#!/usr/bin/env node
/**
 * One-step launcher: check prerequisites, install deps, start the server, open the browser.
 * Cross-platform. Windows users can double-click run.cmd instead.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(root, ".env");
const exampleFile = path.join(root, ".env.example");

function fail(message) {
  console.error(`\n[FAILED] ${message}\n`);
  process.exit(1);
}

/** Minimal .env reader — the launcher runs before dependencies are installed. */
function readEnv(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) out[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(500, () => done(false));
  });
}

/**
 * Port open ≠ DFM healthy. After public/ → frontend/ renames, a leftover
 * `src/server.js` still answers /api/* but serves 404 for /. Treating that as
 * "already running" opens a blank page and looks like the app is broken.
 */
async function isDfmUiHealthy(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      redirect: "manual",
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return false;
    const type = res.headers.get("content-type") || "";
    if (!type.includes("text/html")) return false;
    const body = await res.text();
    return body.includes("googleBtn") || body.includes("디지털 발자국");
  } catch {
    return false;
  }
}

async function waitForPort(port, child, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    if (await isDfmUiHealthy(port)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function openBrowser(url) {
  const [cmd, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    console.log(`Could not open a browser automatically. Open this URL: ${url}`);
  }
}

async function main() {
  console.log("DFM prototype launcher\n");

  // 1. Config. This is where a first-time run almost always stops.
  if (!existsSync(envFile)) {
    fail(
      `No .env file found.\n\n` +
        `  Fix: copy .env.example to .env, then set GOOGLE_CLIENT_ID.\n` +
        `    Windows : copy .env.example .env\n` +
        `    macOS   : cp .env.example .env\n\n` +
        `  Expected at: ${envFile}\n` +
        `  Template   : ${existsSync(exampleFile) ? exampleFile : "missing (.env.example not found)"}`
    );
  }

  const env = readEnv(envFile);
  if (!env.GOOGLE_CLIENT_ID) {
    fail(
      `GOOGLE_CLIENT_ID is empty in .env.\n\n` +
        `  Get one from Google Cloud Console > APIs & Services > Credentials,\n` +
        `  as an OAuth 2.0 Client ID of type "Web application".\n` +
        `  It looks like: 1234567890-abcdef.apps.googleusercontent.com\n\n` +
        `  Authorized JavaScript origin must include: http://localhost:${env.PORT || 3456}\n\n` +
        `  File: ${envFile}`
    );
  }

  const port = Number(env.PORT || 3456);
  const url = `http://localhost:${port}`;

  // 2. Already running? Reuse only a healthy DFM UI — a dead static root is not "up".
  if (await isPortOpen(port)) {
    if (await isDfmUiHealthy(port)) {
      console.log(`Server already running on ${url} — opening the browser.`);
      openBrowser(url);
      return;
    }
    fail(
      `Port ${port} is in use, but GET / is not the DFM UI (often an old ` +
        `src/server.js left over after public/ → frontend/).\n\n` +
        `  Stop the process holding ${port}, then run again.\n` +
        `    Windows : Get-NetTCPConnection -LocalPort ${port} | Select OwningProcess\n` +
        `              Stop-Process -Id <pid> -Force\n` +
        `    macOS   : lsof -i :${port}   then   kill <pid>`
    );
  }

  // 3. Dependencies.
  if (!existsSync(path.join(root, "node_modules"))) {
    console.log("Installing dependencies (first run only)...\n");
    const install = spawnSync("npm", ["install"], {
      cwd: root,
      stdio: "inherit",
      shell: true, // npm is npm.cmd on Windows
    });
    if (install.status !== 0) {
      fail(`npm install exited with code ${install.status}. Is Node.js installed?`);
    }
    console.log("");
  }

  // 4. Server.
  console.log(`Starting the server on ${url} ...\n`);
  const child = spawn("node", ["backend/server.js"], { cwd: root, stdio: "inherit" });

  const shutdown = () => {
    if (child.exitCode === null) child.kill();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  child.on("exit", (code) => process.exit(code ?? 0));

  // 5. Browser — only once the port actually accepts connections, so nobody
  //    sees a connection-refused page and concludes the app is broken.
  if (await waitForPort(port, child)) {
    console.log(`\nReady. Opening ${url}\nPress Ctrl+C to stop.\n`);
    openBrowser(url);
  } else if (child.exitCode === null) {
    console.error(`\nServer did not accept connections within 20s. Open ${url} manually.\n`);
  }
}

main().catch((err) => fail(err.message || String(err)));
