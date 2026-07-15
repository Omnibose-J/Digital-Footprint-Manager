/** Sender reduction + signal classification. Browser ESM; no bundler. */

import { defaultRules } from "./filter.rules.js";

const FAMILIES = [
  "signup",
  "auth",
  "transaction",
  "notification",
  "marketing",
  "closure",
  "unknown",
];

const FAMILY_STRENGTH = {
  signup: 55,
  auth: 45,
  transaction: 30,
  notification: 15,
  closure: 10,
  marketing: 5,
  unknown: 0,
};

function parseFromHeader(raw = "") {
  const text = String(raw).trim();
  if (!text) return null;

  const angle = text.match(/^(.*)<([^>]+)>\s*$/);
  if (angle) {
    const name = angle[1].replace(/^"|"$/g, "").trim();
    const email = angle[2].trim().toLowerCase();
    return { name: name || email, email, raw: text };
  }

  const emailOnly = text.match(/[\w.+-]+@[\w.-]+\.\w+/);
  if (emailOnly) {
    const email = emailOnly[0].toLowerCase();
    return { name: email, email, raw: text };
  }

  return { name: text, email: text.toLowerCase(), raw: text };
}

function domainFromEmail(email) {
  const at = String(email).lastIndexOf("@");
  if (at < 0) return null;
  return String(email)
    .slice(at + 1)
    .toLowerCase();
}

/**
 * Registrable domain = eTLD+1 against PUBLIC_SUFFIXES (longest match),
 * else last two labels, else null when no dot.
 */
export function registrableDomainFromHost(senderDomain, publicSuffixes = defaultRules.PUBLIC_SUFFIXES) {
  const host = String(senderDomain || "")
    .toLowerCase()
    .replace(/\.$/, "");
  if (!host || !host.includes(".")) return null;

  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return null;

  let bestSuffix = null;
  for (const suffix of publicSuffixes) {
    const s = String(suffix).toLowerCase();
    if (host === s || host.endsWith(`.${s}`)) {
      if (!bestSuffix || s.length > bestSuffix.length) bestSuffix = s;
    }
  }

  if (bestSuffix) {
    const suffixLabels = bestSuffix.split(".").length;
    if (labels.length <= suffixLabels) return null;
    return labels.slice(-(suffixLabels + 1)).join(".");
  }

  return labels.slice(-2).join(".");
}

export function normalizeSender(fromHeaderValue, rules = defaultRules) {
  const parsed = parseFromHeader(fromHeaderValue);
  if (!parsed?.email || !String(parsed.email).includes("@")) {
    // R4/D2: never silently discard — surface as invalid_domain in snapshot().
    return {
      email: parsed?.email ? String(parsed.email).toLowerCase() : "",
      localPart: "",
      senderDomain: null,
      registrableDomain: null,
      displayName: parsed?.name || parsed?.email || "(invalid from)",
    };
  }

  const email = parsed.email;
  const at = email.lastIndexOf("@");
  const localPart = email.slice(0, at);
  const senderDomain = domainFromEmail(email);
  if (!senderDomain) {
    return {
      email,
      localPart,
      senderDomain: null,
      registrableDomain: null,
      displayName: parsed.name || email,
    };
  }

  const registrableDomain = registrableDomainFromHost(
    senderDomain,
    rules.PUBLIC_SUFFIXES
  );

  return {
    email,
    localPart,
    senderDomain,
    registrableDomain,
    displayName: parsed.name || email,
  };
}

function normalizeSubject(subject) {
  return String(subject || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function classifyMessage(
  { labelIds = [], subject = "", headers = {} } = {},
  rules = defaultRules
) {
  const matchedRules = [];
  const normalized = normalizeSubject(subject);
  const subjectRules = rules.SUBJECT_RULES || {};

  for (const family of ["signup", "auth", "transaction", "closure"]) {
    const phrases = subjectRules[family] || [];
    for (const phrase of phrases) {
      const needle = normalizeSubject(phrase);
      if (needle && normalized.includes(needle)) {
        matchedRules.push(`subject:${family}:${phrase}`);
        return { family, matchedRules };
      }
    }
  }

  const labels = Array.isArray(labelIds) ? labelIds : [];
  if (labels.includes(rules.CATEGORY_PURCHASES)) {
    matchedRules.push("category:purchases");
    return { family: "transaction", matchedRules };
  }
  if (labels.includes(rules.CATEGORY_PROMOTIONS)) {
    matchedRules.push("category:promotions");
    return { family: "marketing", matchedRules };
  }
  if (labels.includes(rules.CATEGORY_UPDATES)) {
    matchedRules.push("category:updates");
    return { family: "notification", matchedRules };
  }

  return { family: "unknown", matchedRules };
}

function monthFromInternalDate(internalDate) {
  if (internalDate === undefined || internalDate === null || internalDate === "") {
    return null;
  }
  const ms = Number(internalDate);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function emptyHeaderFeatures() {
  return {
    listUnsubscribe: 0,
    listId: 0,
    precedenceBulk: 0,
    autoSubmitted: 0,
  };
}

function emptyFamilies() {
  const out = {};
  for (const f of FAMILIES) out[f] = { months: [], count: 0 };
  return out;
}

function strongestEvidence(families) {
  let best = 0;
  for (const f of FAMILIES) {
    if ((families[f]?.count || 0) > 0) {
      best = Math.max(best, FAMILY_STRENGTH[f] ?? 0);
    }
  }
  return best;
}

function lastSeenMonthFromFamilies(families) {
  let latest = null;
  for (const f of FAMILIES) {
    if (f === "marketing") continue;
    const months = families[f]?.months || [];
    for (const month of months) {
      if (!latest || month > latest) latest = month;
    }
  }
  return latest;
}

function firstSeenMonthFromFamilies(families) {
  let earliest = null;
  for (const f of FAMILIES) {
    const months = families[f]?.months || [];
    for (const month of months) {
      if (!earliest || month < earliest) earliest = month;
    }
  }
  return earliest;
}

function mostFrequentName(nameCounts) {
  let best = "";
  let bestN = -1;
  for (const [name, n] of nameCounts.entries()) {
    if (n > bestN || (n === bestN && name < best)) {
      best = name;
      bestN = n;
    }
  }
  return best;
}

function aggregationKey(normalized, rules, self) {
  const free = new Set(rules.FREE_MAILBOX_DOMAINS);
  const relay = new Set(rules.RELAY_DOMAINS);
  if (!normalized.registrableDomain) return `invalid:${normalized.email}`;
  // The user's own address is an address-level fact, so it needs its own bucket.
  // Folded into `dom:`, it would hide every service on that domain — SENT mail puts
  // the user in From, so a custom/Workspace domain loses all of its services.
  if (self && normalized.email === self) return `addr:${normalized.email}`;
  if (free.has(normalized.registrableDomain) || relay.has(normalized.registrableDomain)) {
    return `addr:${normalized.email}`;
  }
  return `dom:${normalized.registrableDomain}`;
}

/**
 * @param {{ selfEmail: string, rules?: typeof defaultRules }} opts
 */
export function createAggregator({ selfEmail, rules = defaultRules } = {}) {
  const self = String(selfEmail || "").trim().toLowerCase();
  const freeSet = new Set(rules.FREE_MAILBOX_DOMAINS);
  const relaySet = new Set(rules.RELAY_DOMAINS);
  const machineRe = rules.MACHINE_LOCALPART;

  /** @type {Map<string, any>} */
  const byKey = new Map();
  let messages = 0;
  let unknownFamily = 0;

  function ensureService(key, normalized) {
    let svc = byKey.get(key);
    if (!svc) {
      svc = {
        key,
        registrableDomain: normalized.registrableDomain,
        emails: new Set(),
        localParts: new Set(),
        nameCounts: new Map(),
        senderAddresses: 0,
        messageCount: 0,
        families: emptyFamilies(),
        headerFeatures: emptyHeaderFeatures(),
      };
      byKey.set(key, svc);
    }
    return svc;
  }

  function add(message) {
    messages += 1;
    const headers = message?.headers || {};
    const normalized = normalizeSender(headers.from, rules);

    const { family } = classifyMessage(
      {
        labelIds: message.labelIds || [],
        subject: headers.subject,
        headers,
      },
      rules
    );
    if (family === "unknown") unknownFamily += 1;

    const key = aggregationKey(normalized, rules, self);
    const svc = ensureService(key, normalized);

    if (normalized.email && !svc.emails.has(normalized.email)) {
      svc.emails.add(normalized.email);
      svc.localParts.add(normalized.localPart);
      svc.senderAddresses += 1;
    } else if (!normalized.email && svc.senderAddresses === 0) {
      svc.senderAddresses = 1;
    }

    const displayName = normalized.displayName || normalized.email;
    svc.nameCounts.set(displayName, (svc.nameCounts.get(displayName) || 0) + 1);
    svc.messageCount += 1;

    const month = monthFromInternalDate(message.internalDate);
    const bucket = svc.families[family] || (svc.families[family] = { months: [], count: 0 });
    bucket.count += 1;
    if (month && !bucket.months.includes(month)) {
      bucket.months.push(month);
      bucket.months.sort();
    }

    if (headers.listUnsubscribe) svc.headerFeatures.listUnsubscribe += 1;
    if (headers.listId) svc.headerFeatures.listId += 1;
    if (String(headers.precedence || "").toLowerCase().trim() === "bulk") {
      svc.headerFeatures.precedenceBulk += 1;
    }
    if (headers.autoSubmitted) svc.headerFeatures.autoSubmitted += 1;
  }

  function linkFields(registrableDomain, hiddenRule) {
    let linkBlockedBy = null;
    if (hiddenRule === "self") linkBlockedBy = "self";
    else if (hiddenRule === "relay_domain" || (registrableDomain && relaySet.has(registrableDomain))) {
      linkBlockedBy = "relay";
    } else if (registrableDomain && freeSet.has(registrableDomain)) {
      linkBlockedBy = "free_mailbox";
    }

    if (linkBlockedBy) {
      return { siteUrl: null, linkSafety: "none", linkBlockedBy };
    }
    if (!registrableDomain) {
      return { siteUrl: null, linkSafety: "none", linkBlockedBy: null };
    }
    return {
      siteUrl: `https://${registrableDomain}`,
      linkSafety: "inferred",
      linkBlockedBy: null,
    };
  }

  function verdictFor(svc) {
    const emails = [...svc.emails];
    if (self && emails.some((e) => e === self)) {
      return { verdict: "hidden", hiddenRule: "self" };
    }
    if (svc.registrableDomain === null || svc.registrableDomain === undefined) {
      return { verdict: "hidden", hiddenRule: "invalid_domain" };
    }
    if (relaySet.has(svc.registrableDomain)) {
      return { verdict: "unresolved", hiddenRule: "relay_domain" };
    }

    const hasSignupOrAuth =
      (svc.families.signup?.count || 0) > 0 || (svc.families.auth?.count || 0) > 0;
    const localParts = [...svc.localParts];
    const allPersonalLooking =
      localParts.length > 0 && localParts.every((lp) => !machineRe.test(lp));

    if (
      freeSet.has(svc.registrableDomain) &&
      allPersonalLooking &&
      !hasSignupOrAuth
    ) {
      return { verdict: "hidden", hiddenRule: "personal_mailbox" };
    }

    return { verdict: "candidate", hiddenRule: null };
  }

  function toCandidate(svc) {
    const { verdict, hiddenRule } = verdictFor(svc);
    const families = {};
    for (const f of FAMILIES) {
      const src = svc.families[f] || { months: [], count: 0 };
      families[f] = {
        months: [...src.months].sort(),
        count: src.count,
      };
    }
    const links = linkFields(svc.registrableDomain, hiddenRule);
    return {
      key: svc.key, // stable identity across snapshots; registrableDomain is not unique
      registrableDomain: svc.registrableDomain,
      displayName: mostFrequentName(svc.nameCounts) || svc.registrableDomain || "",
      senderAddresses: svc.senderAddresses,
      messageCount: svc.messageCount,
      families,
      firstSeenMonth: firstSeenMonthFromFamilies(families),
      lastSeenMonth: lastSeenMonthFromFamilies(families),
      headerFeatures: { ...svc.headerFeatures },
      siteUrl: links.siteUrl,
      linkSafety: links.linkSafety,
      linkBlockedBy: links.linkBlockedBy,
      verdict,
      hiddenRule,
    };
  }

  function snapshot() {
    const services = [];
    const hidden = [];
    const unresolved = [];

    for (const svc of byKey.values()) {
      const candidate = toCandidate(svc);
      if (candidate.verdict === "candidate") services.push(candidate);
      else if (candidate.verdict === "unresolved") unresolved.push(candidate);
      else hidden.push(candidate);
    }

    services.sort((a, b) => {
      const sa = strongestEvidence(a.families);
      const sb = strongestEvidence(b.families);
      if (sb !== sa) return sb - sa;
      return b.messageCount - a.messageCount;
    });
    hidden.sort((a, b) => b.messageCount - a.messageCount);
    unresolved.sort((a, b) => b.messageCount - a.messageCount);

    return {
      services,
      hidden,
      unresolved,
      stats: {
        messages,
        services: services.length,
        hidden: hidden.length,
        unresolved: unresolved.length,
        unknownFamily,
      },
    };
  }

  return { add, snapshot };
}

export { parseFromHeader, domainFromEmail };
