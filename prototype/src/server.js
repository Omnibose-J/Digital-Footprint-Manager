import "dotenv/config";
import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createOAuthClient,
  getAuthUrl,
  getGmailClient,
  collectSenders,
} from "./gmail.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "..", "public");
const port = Number(process.env.PORT || 3456);
const maxMessages = Number(process.env.GMAIL_MAX_MESSAGES || 0);
const concurrency = Number(process.env.GMAIL_CONCURRENCY || 12);

/** @type {Map<string, { tokens: object, hintEmail: string, accountEmail?: string }>} */
const sessions = new Map();

const app = express();
app.use(express.json());
app.use(express.static(publicDir));

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

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    hasClientId: Boolean(process.env.GOOGLE_CLIENT_ID),
    hasClientSecret: Boolean(process.env.GOOGLE_CLIENT_SECRET),
    redirectUri:
      process.env.GOOGLE_REDIRECT_URI || "http://localhost:3456/oauth2callback",
    maxMessages,
    concurrency,
  });
});

app.get("/api/me", (req, res) => {
  const session = getSession(req);
  if (!session?.tokens) {
    res.json({ connected: false });
    return;
  }
  res.json({
    connected: true,
    account: session.accountEmail || null,
    hintEmail: session.hintEmail || null,
  });
});

app.post("/api/auth/start", (req, res) => {
  try {
    const email = String(req.body?.email || "").trim();
    if (!email || !email.includes("@")) {
      res.status(400).json({ error: "유효한 이메일을 입력해 주세요." });
      return;
    }

    const sid = crypto.randomUUID();
    sessions.set(sid, { tokens: null, hintEmail: email.toLowerCase() });
    setSessionCookie(res, sid);

    const oauth2Client = createOAuthClient();
    const authUrl = getAuthUrl(oauth2Client, { loginHint: email });
    res.json({ authUrl, email: email.toLowerCase() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.get("/oauth2callback", async (req, res) => {
  try {
    const err = req.query.error;
    if (err) {
      res.status(400).send(`OAuth error: ${err}`);
      return;
    }

    const code = req.query.code;
    if (!code) {
      res.status(400).send("Missing code");
      return;
    }

    const cookies = parseCookies(req);
    let sid = cookies.dfm_sid;
    let session = sid ? sessions.get(sid) : null;

    if (!session) {
      sid = crypto.randomUUID();
      session = { tokens: null, hintEmail: "" };
      sessions.set(sid, session);
      setSessionCookie(res, sid);
    }

    const oauth2Client = createOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const gmail = getGmailClient(oauth2Client);
    const profile = await gmail.users.getProfile({ userId: "me" });
    const accountEmail = profile.data.emailAddress || "";

    session.tokens = tokens;
    session.accountEmail = accountEmail;

    const mismatch =
      session.hintEmail &&
      accountEmail &&
      session.hintEmail.toLowerCase() !== accountEmail.toLowerCase();

    const q = new URLSearchParams({ connected: "1" });
    if (mismatch) q.set("mismatch", "1");
    res.redirect(`/?${q.toString()}`);
  } catch (e) {
    console.error(e);
    res.status(500).send(String(e.message || e));
  }
});

app.post("/api/auth/logout", (req, res) => {
  const sid = parseCookies(req).dfm_sid;
  if (sid) sessions.delete(sid);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/senders", async (req, res) => {
  try {
    const session = getSession(req);
    if (!session?.tokens) {
      res.status(401).json({
        error: "먼저 이메일을 입력하고 Google 계정에 연결해 주세요.",
      });
      return;
    }

    const oauth2Client = createOAuthClient();
    oauth2Client.setCredentials(session.tokens);
    oauth2Client.on("tokens", (t) => {
      session.tokens = { ...session.tokens, ...t };
    });

    const gmail = getGmailClient(oauth2Client);
    const profile = await gmail.users.getProfile({ userId: "me" });
    session.accountEmail = profile.data.emailAddress || session.accountEmail;
    const estimatedTotal = Number(profile.data.messagesTotal || 0);

    const result = await collectSenders(gmail, {
      maxMessages,
      concurrency,
      estimatedTotal,
    });

    res.json({
      account: session.accountEmail,
      hintEmail: session.hintEmail || null,
      maxMessages,
      concurrency,
      estimatedTotal,
      ...result,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: err.message || String(err),
    });
  }
});

app.get("/api/senders/stream", async (req, res) => {
  const session = getSession(req);
  if (!session?.tokens) {
    res.status(401).json({
      error: "먼저 이메일을 입력하고 Google 계정에 연결해 주세요.",
    });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const oauth2Client = createOAuthClient();
    oauth2Client.setCredentials(session.tokens);
    oauth2Client.on("tokens", (t) => {
      session.tokens = { ...session.tokens, ...t };
    });

    const gmail = getGmailClient(oauth2Client);
    const profile = await gmail.users.getProfile({ userId: "me" });
    session.accountEmail = profile.data.emailAddress || session.accountEmail;
    const estimatedTotal = Number(profile.data.messagesTotal || 0);
    const unlimited = !(maxMessages > 0);

    send("start", {
      account: session.accountEmail,
      maxMessages,
      concurrency,
      estimatedTotal,
      unlimited,
    });

    const result = await collectSenders(gmail, {
      maxMessages,
      concurrency,
      estimatedTotal,
      onProgress: (p) => send("progress", p),
    });

    send("done", {
      account: session.accountEmail,
      hintEmail: session.hintEmail || null,
      maxMessages,
      concurrency,
      estimatedTotal,
      ...result,
    });
  } catch (err) {
    console.error(err);
    send("fail", { error: err.message || String(err) });
  } finally {
    res.end();
  }
});

app.listen(port, () => {
  console.log(`DFM sender prototype: http://localhost:${port}`);
  console.log(`Connect flow: enter email → Google OAuth → load senders`);
});
