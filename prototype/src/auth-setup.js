import "dotenv/config";
import http from "node:http";
import { URL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import open from "open";
import { createOAuthClient, getAuthUrl } from "./gmail.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, "..", ".env");
const port = Number(process.env.PORT || 3456);

function upsertEnv(key, value) {
  let raw = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(raw)) {
    raw = raw.replace(re, line);
  } else {
    raw = raw.trimEnd() + `\n${line}\n`;
  }
  fs.writeFileSync(envPath, raw, "utf8");
}

async function main() {
  const oauth2Client = createOAuthClient();
  const authUrl = getAuthUrl(oauth2Client);

  console.log("\nOpen this URL if the browser did not open:\n");
  console.log(authUrl);
  console.log("\nWaiting for Google OAuth callback...\n");

  await open(authUrl);

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const u = new URL(req.url, `http://localhost:${port}`);
        if (u.pathname !== "/oauth2callback") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const err = u.searchParams.get("error");
        if (err) {
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(`OAuth error: ${err}`);
          reject(new Error(err));
          server.close();
          return;
        }

        const authCode = u.searchParams.get("code");
        if (!authCode) {
          res.writeHead(400);
          res.end("Missing code");
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          "<h1>Auth OK</h1><p>Refresh token saved to .env. You can close this tab and run <code>npm start</code>.</p>"
        );
        server.close();
        resolve(authCode);
      } catch (e) {
        reject(e);
      }
    });

    server.listen(port, "127.0.0.1");
  });

  const { tokens } = await oauth2Client.getToken(code);
  if (!tokens.refresh_token) {
    console.error(
      "No refresh_token returned. Revoke app access at https://myaccount.google.com/permissions and run npm run auth again."
    );
    process.exit(1);
  }

  upsertEnv("GOOGLE_REFRESH_TOKEN", tokens.refresh_token);
  console.log("Saved GOOGLE_REFRESH_TOKEN to .env");
  console.log("Next: npm start");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
