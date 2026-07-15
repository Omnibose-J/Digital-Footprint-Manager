import { google } from "googleapis";

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

export function createOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI || "http://localhost:3456/oauth2callback";

  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required in .env");
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function getAuthUrl(oauth2Client, { loginHint } = {}) {
  const opts = {
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  };
  if (loginHint) opts.login_hint = String(loginHint).trim();
  return oauth2Client.generateAuthUrl(opts);
}

export function getGmailClient(oauth2Client) {
  return google.gmail({ version: "v1", auth: oauth2Client });
}

/** Parse "Name <email@domain>" / bare email into { name, email, raw } */
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

function isRateLimited(err) {
  const status = err?.code || err?.response?.status;
  return status === 429 || status === 403;
}

function sortedSenders(byEmail) {
  return [...byEmail.values()].sort((a, b) => b.count - a.count);
}

/**
 * Scan mailbox (optionally capped), aggregate From headers.
 * maxMessages <= 0 means no cap (entire mailbox).
 * Processes list pages → fetch immediately so the UI can update live.
 */
export async function collectSenders(
  gmail,
  {
    maxMessages = 0,
    concurrency = 12,
    estimatedTotal = 0,
    onProgress,
  } = {}
) {
  const unlimited = !(Number(maxMessages) > 0);
  const cap = unlimited ? Number.POSITIVE_INFINITY : Number(maxMessages);
  const byEmail = new Map();
  let listed = 0;
  let fetched = 0;
  let errors = 0;
  let pageToken;
  let lastReportAt = 0;

  const report = (phase, force = false, extra = {}) => {
    const now = Date.now();
    if (!force && now - lastReportAt < 120) return;
    lastReportAt = now;
    if (typeof onProgress !== "function") return;
    onProgress({
      phase,
      unlimited,
      target: estimatedTotal || (unlimited ? listed : Math.min(cap, listed || cap)),
      scannedIds: listed,
      fetched,
      errors,
      uniqueSenders: byEmail.size,
      senders: sortedSenders(byEmail),
      ...extra,
    });
  };

  report("listing", true);

  while (listed < cap) {
    const pageSize = Math.min(500, unlimited ? 500 : cap - listed);
    if (pageSize <= 0) break;

    const listRes = await gmail.users.messages.list({
      userId: "me",
      maxResults: pageSize,
      pageToken,
      fields: "messages/id,nextPageToken",
    });

    const batch = listRes.data.messages || [];
    if (batch.length === 0) break;

    const pageIds = [];
    for (const m of batch) {
      if (listed + pageIds.length >= cap) break;
      pageIds.push(m.id);
    }
    listed += pageIds.length;

    report("listing", true);

    await mapPool(pageIds, concurrency, async (id) => {
      let attempt = 0;
      while (attempt < 4) {
        try {
          const res = await gmail.users.messages.get({
            userId: "me",
            id,
            format: "metadata",
            metadataHeaders: ["From"],
            fields: "payload/headers",
          });

          const headers = res.data.payload?.headers || [];
          const fromHeader = headers.find((h) => h.name?.toLowerCase() === "from");
          const parsed = parseFromHeader(fromHeader?.value);
          if (parsed) {
            const prev = byEmail.get(parsed.email);
            if (prev) {
              prev.count += 1;
              if (parsed.name && parsed.name !== parsed.email) {
                prev.name = parsed.name;
              }
            } else {
              byEmail.set(parsed.email, {
                email: parsed.email,
                name: parsed.name,
                count: 1,
              });
            }
          }
          fetched += 1;
          report("fetching");
          return;
        } catch (err) {
          attempt += 1;
          if (isRateLimited(err) && attempt < 4) {
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

    pageToken = listRes.data.nextPageToken;
    if (!pageToken) break;
  }

  const senders = sortedSenders(byEmail);
  report("fetching", true);

  return {
    scannedIds: listed,
    fetched,
    errors,
    uniqueSenders: senders.length,
    unlimited,
    senders,
  };
}
