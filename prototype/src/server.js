import "dotenv/config";
import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OAuth2Client } from "google-auth-library";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "..", "public");
const port = Number(process.env.PORT || 3456);
const clientId = process.env.GOOGLE_CLIENT_ID || "";
const concurrency = Number(process.env.GMAIL_CONCURRENCY || 12);
const maxMessages = Number(process.env.GMAIL_MAX_MESSAGES || 0);

/** Product sessions only — never store Gmail tokens here */
/** @type {Map<string, { sub: string, email: string, name: string, picture?: string, createdAt: number }>} */
const sessions = new Map();

/** Approved candidate domains per user sub (no full sender addresses) */
/** @type {Map<string, { domains: Array<{ domain: string, count: number }>, savedAt: string }>} */
const savedCandidates = new Map();

const oauthClient = clientId ? new OAuth2Client(clientId) : null;

const app = express();
app.use(express.json({ limit: "256kb" }));

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  const out = {};
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (!k) continue;
    out[k] = decodeURIComponent(rest.join("=") || "");
  }
  return out;
}

function getSession(req) {
  const sid = parseCookies(req).dfm_sid;
  if (!sid) return null;
  return sessions.get(sid) || null;
}

function setSessionCookie(res, sid) {
  res.setHeader(
    "Set-Cookie",
    `dfm_sid=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax`
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    "dfm_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
  );
}

function requireSession(req, res) {
  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: "로그인이 필요합니다." });
    return null;
  }
  return session;
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    hasClientId: Boolean(clientId),
    gmailOnServer: false,
    maxMessages,
    concurrency,
  });
});

app.get("/api/config", (_req, res) => {
  if (!clientId) {
    res.status(500).json({ error: "GOOGLE_CLIENT_ID is not configured in .env" });
    return;
  }
  res.json({
    clientId,
    maxMessages,
    concurrency,
    gmailScope: "https://www.googleapis.com/auth/gmail.readonly",
  });
});

app.get("/api/me", (req, res) => {
  const session = getSession(req);
  if (!session) {
    res.json({ loggedIn: false });
    return;
  }
  res.json({
    loggedIn: true,
    email: session.email,
    name: session.name,
    picture: session.picture || null,
  });
});

app.post("/api/auth/login", async (req, res) => {
  try {
    if (!oauthClient || !clientId) {
      res.status(500).json({ error: "GOOGLE_CLIENT_ID missing in .env" });
      return;
    }

    const credential = String(req.body?.credential || "");
    if (!credential) {
      res.status(400).json({ error: "credential required" });
      return;
    }

    const ticket = await oauthClient.verifyIdToken({
      idToken: credential,
      audience: clientId,
    });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email) {
      res.status(401).json({ error: "Invalid Google ID token" });
      return;
    }

    const sid = crypto.randomUUID();
    sessions.set(sid, {
      sub: payload.sub,
      email: payload.email,
      name: payload.name || payload.email,
      picture: payload.picture,
      createdAt: Date.now(),
    });
    setSessionCookie(res, sid);

    res.json({
      loggedIn: true,
      email: payload.email,
      name: payload.name || payload.email,
    });
  } catch (err) {
    console.error(err);
    res.status(401).json({ error: err.message || "Login failed" });
  }
});

app.post("/api/auth/logout", (req, res) => {
  const sid = parseCookies(req).dfm_sid;
  if (sid) sessions.delete(sid);
  clearSessionCookie(res);
  res.json({ ok: true });
});

/**
 * Save approved candidate domains only (never full sender addresses / Gmail tokens).
 */
app.post("/api/candidates", (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;

  const domains = Array.isArray(req.body?.domains) ? req.body.domains : [];
  const cleaned = [];
  const seen = new Set();

  for (const item of domains) {
    const domain = String(item?.domain || item || "")
      .trim()
      .toLowerCase()
      .replace(/^@/, "");
    if (!domain || !domain.includes(".") || seen.has(domain)) continue;
    if (domain.length > 253) continue;
    seen.add(domain);
    cleaned.push({
      domain,
      count: Math.max(0, Number(item?.count) || 0),
    });
  }

  if (cleaned.length > 2000) {
    res.status(400).json({ error: "Too many domains" });
    return;
  }

  const record = {
    domains: cleaned,
    savedAt: new Date().toISOString(),
  };
  savedCandidates.set(session.sub, record);

  res.json({
    ok: true,
    saved: cleaned.length,
    savedAt: record.savedAt,
  });
});

app.get("/api/candidates", (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const record = savedCandidates.get(session.sub) || {
    domains: [],
    savedAt: null,
  };
  res.json(record);
});

app.use(express.static(publicDir));

app.listen(port, () => {
  console.log(`DFM prototype: http://localhost:${port}`);
  console.log("Product login on server; Gmail scan stays in the browser.");
});
