/** Browser-side Gmail From aggregation. Access token never leaves the browser. */

export function parseFromHeader(raw = "") {
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

export function domainFromEmail(email) {
  const at = String(email).lastIndexOf("@");
  if (at < 0) return null;
  return String(email)
    .slice(at + 1)
    .toLowerCase();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function mapPool(items, concurrency, worker) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let next = 0;

  async function run() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }

  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: n }, () => run()));
  return results;
}

function sortedSenders(byEmail) {
  return [...byEmail.values()].sort((a, b) => b.count - a.count);
}

async function gmailFetch(accessToken, path, params) {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 429 || res.status === 403) {
    const err = new Error(`Gmail rate/auth error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gmail ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Full-mailbox (or capped) scan in the browser.
 * onProgress({ phase, unlimited, target, scannedIds, fetched, errors, uniqueSenders, senders })
 */
export async function collectSenders(accessToken, {
  maxMessages = 0,
  concurrency = 12,
  onProgress,
  signal,
} = {}) {
  const unlimited = !(Number(maxMessages) > 0);
  const cap = unlimited ? Number.POSITIVE_INFINITY : Number(maxMessages);
  const byEmail = new Map();
  let listed = 0;
  let fetched = 0;
  let errors = 0;
  let pageToken;
  let lastReportAt = 0;

  const profile = await gmailFetch(accessToken, "users/me/profile");
  const estimatedTotal = Number(profile.messagesTotal || 0);

  const report = (phase, force = false) => {
    const now = Date.now();
    if (!force && now - lastReportAt < 120) return;
    lastReportAt = now;
    onProgress?.({
      phase,
      unlimited,
      target: estimatedTotal || listed,
      scannedIds: listed,
      fetched,
      errors,
      uniqueSenders: byEmail.size,
      senders: sortedSenders(byEmail),
      account: profile.emailAddress || null,
    });
  };

  report("listing", true);

  while (listed < cap) {
    if (signal?.aborted) throw new Error("스캔이 취소되었습니다.");

    const pageSize = Math.min(500, unlimited ? 500 : cap - listed);
    if (pageSize <= 0) break;

    const listRes = await gmailFetch(accessToken, "users/me/messages", {
      maxResults: pageSize,
      pageToken,
      fields: "messages/id,nextPageToken",
    });

    const batch = listRes.messages || [];
    if (batch.length === 0) break;

    const pageIds = [];
    for (const m of batch) {
      if (listed + pageIds.length >= cap) break;
      pageIds.push(m.id);
    }
    listed += pageIds.length;
    report("listing", true);

    await mapPool(pageIds, concurrency, async (id) => {
      if (signal?.aborted) return;
      let attempt = 0;
      while (attempt < 4) {
        try {
          const msg = await gmailFetch(
            accessToken,
            `users/me/messages/${id}`,
            {
              format: "metadata",
              metadataHeaders: "From",
              fields: "payload/headers",
            }
          );
          const headers = msg.payload?.headers || [];
          const fromHeader = headers.find((h) => h.name?.toLowerCase() === "from");
          const parsed = parseFromHeader(fromHeader?.value);
          if (parsed) {
            const prev = byEmail.get(parsed.email);
            if (prev) {
              prev.count += 1;
              if (parsed.name && parsed.name !== parsed.email) prev.name = parsed.name;
            } else {
              byEmail.set(parsed.email, {
                email: parsed.email,
                name: parsed.name,
                count: 1,
                domain: domainFromEmail(parsed.email),
              });
            }
          }
          fetched += 1;
          report("fetching");
          return;
        } catch (err) {
          attempt += 1;
          if ((err.status === 429 || err.status === 403) && attempt < 4) {
            await sleep(300 * attempt);
            continue;
          }
          errors += 1;
          report("fetching");
          return;
        }
      }
    });

    report("fetching", true);
    pageToken = listRes.nextPageToken;
    if (!pageToken) break;
  }

  const senders = sortedSenders(byEmail);
  report("fetching", true);

  return {
    account: profile.emailAddress || null,
    scannedIds: listed,
    fetched,
    errors,
    uniqueSenders: senders.length,
    unlimited,
    estimatedTotal,
    senders,
  };
}
