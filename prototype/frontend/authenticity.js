/**
 * Authentication-Results gate (PRODUCT_SPEC §3 / SOW 004 R1).
 *
 * Rules (mandatory):
 * - Read only authserv-id mx.google.com (never the first found, never ARC-*).
 * - Prefer Gmail's dmarc=pass + header.from= over hand-rolled DKIM alignment.
 * - Expect multiple dkim= with different header.d= (up to five).
 */

/**
 * @param {string|string[]|null|undefined} authenticationResultsHeader
 * @param {string|null|undefined} senderRegistrableDomain
 * @returns {{ pass: boolean, reason: string, dkimResults?: Array<{ result: string, headerD: string|null }> }}
 */
export function authVerdict(authenticationResultsHeader, senderRegistrableDomain) {
  const raw = normalizeHeaderInput(authenticationResultsHeader);
  if (!raw) {
    return { pass: false, reason: "no_authserv_id" };
  }

  const blocks = splitAuthservBlocks(raw);
  const gmail = blocks.find((b) => b.authservId === "mx.google.com");
  if (!gmail) {
    return { pass: false, reason: "no_authserv_id" };
  }

  const methods = parseMethodResults(gmail.body);
  const dkimResults = methods
    .filter((m) => m.method === "dkim")
    .map((m) => ({
      result: m.result,
      headerD: headerDFromProps(m.props),
    }));

  const dmarc = methods.find((m) => m.method === "dmarc");
  const sender = String(senderRegistrableDomain || "")
    .toLowerCase()
    .replace(/\.$/, "");

  if (dmarc) {
    if (dmarc.result === "pass") {
      const fromHost = (dmarc.props["header.from"] || "").toLowerCase();
      if (sender && alignsDomain(fromHost, sender)) {
        return { pass: true, reason: "dmarc_pass", dkimResults };
      }
      return { pass: false, reason: "dmarc_from_mismatch", dkimResults };
    }
    if (dmarc.result === "fail") {
      return { pass: false, reason: "dmarc_fail", dkimResults };
    }
  }

  // Prefer dmarc; fall back only to Gmail's dkim=pass + header.d (already evaluated).
  const alignedDkim = dkimResults.find(
    (d) => d.result === "pass" && d.headerD && sender && alignsDomain(d.headerD, sender)
  );
  if (alignedDkim) {
    return { pass: true, reason: "dkim_pass", dkimResults };
  }

  return { pass: false, reason: "no_pass", dkimResults };
}

function normalizeHeaderInput(input) {
  if (input == null) return "";
  if (Array.isArray(input)) {
    return input
      .map((s) => String(s || "").trim())
      .filter(Boolean)
      .join("\n");
  }
  return String(input).trim();
}

function headerDFromProps(props) {
  if (props["header.d"]) return props["header.d"].toLowerCase();
  if (props["header.i"]) return props["header.i"].replace(/^@/, "").toLowerCase();
  return null;
}

/**
 * Split Authentication-Results value(s) into authserv blocks.
 * Host-like authserv-ids only (contain a dot). Never treats ARC-* (different header).
 */
export function splitAuthservBlocks(raw) {
  const text = String(raw)
    .replace(/\r\n/g, "\n")
    .replace(/\n[ \t]+/g, " ")
    .trim();
  if (!text) return [];

  const blocks = [];
  // Match hostname-like authserv-id at BOL or after newline.
  const re = /(?:^|\n)\s*([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)\s*;/g;
  const hits = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const id = m[1].toLowerCase();
    if (!id.includes(".")) continue;
    hits.push({ id, bodyStart: m.index + m[0].length });
  }

  for (let i = 0; i < hits.length; i++) {
    let sliceEnd = text.length;
    if (i + 1 < hits.length) {
      const nextId = hits[i + 1].id;
      const searchFrom = hits[i].bodyStart;
      // Folding above already collapsed /\n[ \t]+/ into a single space, so a newline is never
      // followed by whitespace here — only the bare "\n<id>" form can ever match.
      const idx = text.toLowerCase().indexOf(`\n${nextId}`, searchFrom);
      if (idx >= 0) sliceEnd = idx;
    }
    blocks.push({
      authservId: hits[i].id,
      body: text.slice(hits[i].bodyStart, sliceEnd).trim(),
    });
  }

  // Single-line / single-block common case: "mx.google.com; dkim=pass; dmarc=pass header.from=x"
  if (!blocks.length) {
    const one = text.match(/^([A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9])\s*;\s*([\s\S]*)$/);
    if (one && one[1].includes(".")) {
      blocks.push({ authservId: one[1].toLowerCase(), body: one[2].trim() });
    }
  }

  return blocks;
}

function parseMethodResults(body) {
  const out = [];
  for (const part of String(body).split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const method = trimmed.slice(0, eq).trim().toLowerCase();
    if (!method || /\s/.test(method)) continue;
    let rest = trimmed.slice(eq + 1).trim();
    const resultMatch = rest.match(/^([A-Za-z0-9_-]+)/);
    if (!resultMatch) continue;
    const result = resultMatch[1].toLowerCase();
    rest = rest.slice(resultMatch[0].length);
    const props = {};
    const propRe = /([A-Za-z0-9_.-]+)=([^\s;]+)/g;
    let pm;
    while ((pm = propRe.exec(rest)) !== null) {
      props[pm[1].toLowerCase()] = pm[2];
    }
    out.push({ method, result, props });
  }
  return out;
}

function alignsDomain(headerDomain, senderRegistrable) {
  const h = String(headerDomain || "")
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/\.$/, "");
  const s = String(senderRegistrable || "")
    .toLowerCase()
    .replace(/\.$/, "");
  if (!h || !s) return false;
  return h === s || h.endsWith(`.${s}`);
}
