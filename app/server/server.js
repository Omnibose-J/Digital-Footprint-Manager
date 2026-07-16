import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OAuth2Client } from "google-auth-library";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Each asset dir is mounted by name. Serving app/ wholesale would expose .env and this source.
const webDir = path.resolve(__dirname, "..", "web");
const coreDir = path.resolve(__dirname, "..", "core");
const dataDir = path.resolve(__dirname, "..", "data");
const port = Number(process.env.PORT || 3456);
const gaMeasurementId = process.env.GA_MEASUREMENT_ID || "";
const clientId = process.env.GOOGLE_CLIENT_ID || "";
const concurrency = Number(process.env.GMAIL_CONCURRENCY || 12);
const maxMessages = Number(process.env.GMAIL_MAX_MESSAGES || 0);

const oauthClient = clientId ? new OAuth2Client(clientId) : null;

/** PRODUCT_SPEC §6 / SOW 005 R2 — GIS sign-in must keep working (H3). */
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  // googletagmanager serves gtag.js; region1.google-analytics.com is where it beacons.
  "script-src 'self' https://accounts.google.com/gsi/client https://www.googletagmanager.com",
  "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
  // GIS token client talks to accounts.google.com (not only /gsi/) and oauth2.googleapis.com;
  // Gmail metadata stays on gmail.googleapis.com.
  "connect-src 'self' https://accounts.google.com https://oauth2.googleapis.com https://gmail.googleapis.com https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com",
  "frame-src https://accounts.google.com/gsi/ https://accounts.google.com/",
  "img-src 'self' data: https://*.googleusercontent.com https://*.google-analytics.com https://www.googletagmanager.com",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (req.path.startsWith("/api")) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  const out = {};
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(rest.join("=") || "");
    } catch {
      // Malformed percent-encoding. Cookies are attacker-supplied, and this decodes every
      // cookie on the domain, not just ours -- one bad value must not take the request down.
      // A value that is not valid encoding is not a usable token either, so skipping it
      // lands on the same answer as a wrong token: not signed in.
    }
  }
  return out;
}

/**
 * The session IS the verified Google ID token, held in an HttpOnly cookie and re-verified
 * per request. Stateless on purpose: serverless instances do not share memory, so a
 * server-side session map logs the user out at random. An ID token asserts identity only
 * and carries no Gmail scope, so this cookie still grants no mailbox access.
 */
async function getSession(req) {
  const idToken = parseCookies(req).dfm_idt;
  if (!idToken || !oauthClient) return null;
  try {
    const ticket = await oauthClient.verifyIdToken({ idToken, audience: clientId });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email) return null;
    return {
      sub: payload.sub,
      email: payload.email,
      name: payload.name || payload.email,
      picture: payload.picture,
    };
  } catch {
    // Expired or tampered token means "not signed in" — the defined outcome, not an error.
    return null;
  }
}

function isHttps(req) {
  return String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
}

function sessionCookie(req, value, maxAge) {
  const parts = [
    `dfm_idt=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (isHttps(req)) parts.push("Secure");
  return parts.join("; ");
}

function setSessionCookie(req, res, idToken) {
  // Expiry rides on the ID token's own exp; the cookie is just the carrier.
  res.setHeader("Set-Cookie", sessionCookie(req, idToken, 3600));
}

function clearSessionCookie(req, res) {
  res.setHeader("Set-Cookie", sessionCookie(req, "", 0));
}

async function requireSession(req, res) {
  const session = await getSession(req);
  if (!session) {
    res.status(401).json({ error: "로그인이 필요합니다." });
    return null;
  }
  return session;
}

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
    gaMeasurementId,
  });
});

app.get("/api/me", async (req, res) => {
  const session = await getSession(req);
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

    setSessionCookie(req, res, credential);

    res.json({
      loggedIn: true,
      email: payload.email,
      name: payload.name || payload.email,
    });
  } catch {
    // Never interpolate the error object — google-auth-library embeds credential material (R3).
    console.error("login failed");
    res.status(401).json({ error: "로그인에 실패했습니다." });
  }
});

/**
 * SameSite=Lax already blocks the cookie on a cross-site POST, so a forged logout cannot carry the
 * session and the state-changing part is inert. It still returns 200 and a clearing Set-Cookie,
 * which is noise a same-origin check removes for the cost of four lines.
 *
 * Only the mutating routes get this. A browser omits Origin on same-origin GETs, so demanding it
 * everywhere would break the reads.
 */
function isSameOrigin(req) {
  const origin = req.get("origin");
  if (!origin) return true; // non-CORS clients (curl, the launcher) send none
  try {
    return new URL(origin).host === req.get("host");
  } catch {
    return false;
  }
}

app.post("/api/auth/logout", (req, res) => {
  if (!isSameOrigin(req)) {
    res.status(403).json({ error: "cross-origin" });
    return;
  }
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

app.use(express.static(webDir));
app.use("/core", express.static(coreDir));
app.use("/data", express.static(dataDir));

// On Vercel the platform invokes the exported app; binding a port there would hang the build.
if (!process.env.VERCEL) {
  const server = app.listen(port, () => {
    console.log(`DFM prototype: http://localhost:${port}`);
    console.log("Product login on server; Gmail scan stays in the browser.");
  });
  server.on("error", (err) => {
    if (err && err.code === "EADDRINUSE") {
      console.error(
        `\n[FAILED] Port ${port} is already in use. Stop the other process, or set PORT in .env.\n` +
          `  A leftover server that still answers /api but 404s / will look like the app is broken.\n`
      );
      process.exit(1);
    }
    throw err;
  });
}

export default app;
