/** Browser-side Gmail metadata collector. Access token never leaves the browser. */

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

async function gmailFetch(accessToken, path, params) {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === "") continue;
      // Gmail treats metadataHeaders as a repeated query param, not CSV.
      if (Array.isArray(v)) {
        for (const item of v) url.searchParams.append(k, String(item));
      } else {
        url.searchParams.set(k, String(v));
      }
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

function headerMap(headers) {
  const out = {
    from: undefined,
    subject: undefined,
    listUnsubscribe: undefined,
    listUnsubscribePost: undefined,
    listId: undefined,
    precedence: undefined,
    autoSubmitted: undefined,
    authenticationResults: undefined,
  };
  const byName = {
    from: "from",
    subject: "subject",
    "list-unsubscribe": "listUnsubscribe",
    "list-unsubscribe-post": "listUnsubscribePost",
    "list-id": "listId",
    precedence: "precedence",
    "auto-submitted": "autoSubmitted",
    "authentication-results": "authenticationResults",
  };
  for (const h of headers || []) {
    const key = byName[String(h.name || "").toLowerCase()];
    if (key && out[key] === undefined) out[key] = h.value;
  }
  return out;
}

/**
 * Full-mailbox (or capped) scan in the browser.
 * Pure collector — aggregation lives in filter.js (wired by app.js).
 * onProgress({ phase, unlimited, target, scannedIds, fetched, errors, account })
 * onMessage({ id, internalDate, labelIds, headers })
 */
export async function collectSenders(
  accessToken,
  { maxMessages = 0, concurrency = 12, onProgress, onMessage, signal } = {}
) {
  const unlimited = !(Number(maxMessages) > 0);
  const cap = unlimited ? Number.POSITIVE_INFINITY : Number(maxMessages);
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
          const msg = await gmailFetch(accessToken, `users/me/messages/${id}`, {
            format: "metadata",
            metadataHeaders: [
              "From",
              "Subject",
              "List-Unsubscribe",
              "List-Unsubscribe-Post",
              "List-Id",
              "Precedence",
              "Auto-Submitted",
              "Authentication-Results",
            ],
            fields: "labelIds,internalDate,payload/headers",
          });
          onMessage?.({
            id,
            internalDate: msg.internalDate,
            labelIds: Array.isArray(msg.labelIds) ? msg.labelIds : [],
            headers: headerMap(msg.payload?.headers),
          });
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

  report("fetching", true);

  return {
    account: profile.emailAddress || null,
    scannedIds: listed,
    fetched,
    errors,
    unlimited,
    estimatedTotal,
  };
}
