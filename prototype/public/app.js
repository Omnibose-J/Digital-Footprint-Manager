import { collectSenders, domainFromEmail } from "./scan.js";

const loginPanel = document.getElementById("loginPanel");
const appPanel = document.getElementById("appPanel");
const googleBtn = document.getElementById("googleBtn");
const loginStatus = document.getElementById("loginStatus");
const statusEl = document.getElementById("status");
const progressEl = document.getElementById("progress");
const meta = document.getElementById("meta");
const err = document.getElementById("err");
const rows = document.getElementById("rows");
const scanBtn = document.getElementById("scan");
const saveBtn = document.getElementById("save");
const logoutBtn = document.getElementById("logout");

let config = null;
let lastSenders = [];
let abortScan = null;
let gmailAccessToken = null;

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderSenders(senders) {
  lastSenders = senders || [];
  rows.innerHTML = lastSenders
    .map(
      (s, i) =>
        `<tr><td>${i + 1}</td><td>${escapeHtml(s.name)}</td><td>${escapeHtml(s.email)}</td><td>${s.count}</td></tr>`
    )
    .join("");
  saveBtn.disabled = lastSenders.length === 0;
}

function formatProgress(p) {
  const totalLabel = p.target ? String(p.target) : "?";
  if (p.phase === "listing") {
    return `메일 ID 수집 중… ${p.scannedIds}${p.unlimited ? ` (전체 ~${totalLabel})` : ` / ${totalLabel}`}`;
  }
  return [
    `헤더 조회 중… ${p.fetched} / ${p.scannedIds || totalLabel}`,
    p.unlimited && p.target ? `전체 예상 ${p.target}` : null,
    `고유 발신자 ${p.uniqueSenders}`,
    p.errors ? `에러 ${p.errors}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function setLoggedInUI(me) {
  loginPanel.classList.add("hidden");
  appPanel.classList.remove("hidden");
  statusEl.textContent = `로그인됨: ${me.name || me.email} (${me.email})`;
  loginStatus.textContent = "";
}

function setLoggedOutUI() {
  appPanel.classList.add("hidden");
  loginPanel.classList.remove("hidden");
  statusEl.textContent = "";
  progressEl.textContent = "";
  meta.textContent = "";
  rows.innerHTML = "";
  lastSenders = [];
  gmailAccessToken = null;
  saveBtn.disabled = true;
}

async function refreshMe() {
  const res = await fetch("/api/me");
  const data = await res.json();
  if (data.loggedIn) setLoggedInUI(data);
  else setLoggedOutUI();
  return data;
}

async function handleCredentialResponse(response) {
  err.textContent = "";
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: response.credential }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    await refreshMe();
  } catch (e) {
    err.textContent = String(e.message || e);
    loginStatus.textContent = "로그인 실패";
  }
}

function waitForGis() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    (function tick() {
      if (window.google?.accounts?.id && window.google?.accounts?.oauth2) {
        resolve();
        return;
      }
      if (Date.now() - started > 15000) {
        reject(new Error("Google Identity Services 로드 실패"));
        return;
      }
      setTimeout(tick, 50);
    })();
  });
}

function renderGoogleButton() {
  window.google.accounts.id.initialize({
    client_id: config.clientId,
    callback: handleCredentialResponse,
    auto_select: false,
    cancel_on_tap_outside: true,
  });

  googleBtn.innerHTML = "";
  window.google.accounts.id.renderButton(googleBtn, {
    theme: "outline",
    size: "large",
    text: "signin_with",
    shape: "rectangular",
    width: 280,
  });
}

function requestGmailToken() {
  return new Promise((resolve, reject) => {
    const tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: config.clientId,
      scope: config.gmailScope,
      callback: (resp) => {
        if (resp.error) {
          reject(new Error(resp.error_description || resp.error));
          return;
        }
        resolve(resp.access_token);
      },
      error_callback: (e) => {
        reject(new Error(e?.message || "Gmail 권한 요청 실패"));
      },
    });
    tokenClient.requestAccessToken({ prompt: "consent" });
  });
}

scanBtn.addEventListener("click", async () => {
  err.textContent = "";
  meta.textContent = "";
  progressEl.textContent = "Gmail 권한 요청 중…";
  rows.innerHTML = "";
  scanBtn.disabled = true;
  saveBtn.disabled = true;

  if (abortScan) abortScan.abort();
  abortScan = new AbortController();

  try {
    gmailAccessToken = await requestGmailToken();
    progressEl.textContent = "스캔 시작…";

    const result = await collectSenders(gmailAccessToken, {
      maxMessages: config.maxMessages,
      concurrency: config.concurrency,
      signal: abortScan.signal,
      onProgress: (p) => {
        progressEl.textContent = formatProgress(p);
        if (p.senders?.length) renderSenders(p.senders);
      },
    });

    progressEl.textContent = `완료: ${result.fetched} / ${result.scannedIds}${result.unlimited ? " (전체)" : ""}`;
    meta.textContent = [
      `Gmail: ${result.account}`,
      `스캔 ID: ${result.scannedIds}`,
      `헤더 조회: ${result.fetched}`,
      `에러: ${result.errors}`,
      `고유 발신자: ${result.uniqueSenders}`,
    ].join(" · ");
    renderSenders(result.senders);
  } catch (e) {
    err.textContent = String(e.message || e);
  } finally {
    scanBtn.disabled = false;
  }
});

saveBtn.addEventListener("click", async () => {
  err.textContent = "";
  const domainMap = new Map();
  for (const s of lastSenders) {
    const domain = s.domain || domainFromEmail(s.email);
    if (!domain) continue;
    domainMap.set(domain, (domainMap.get(domain) || 0) + s.count);
  }
  const domains = [...domainMap.entries()].map(([domain, count]) => ({
    domain,
    count,
  }));

  try {
    const res = await fetch("/api/candidates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domains }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    meta.textContent = `${meta.textContent || ""} · 서버 저장: 도메인 ${data.saved}개 (${data.savedAt})`;
  } catch (e) {
    err.textContent = String(e.message || e);
  }
});

logoutBtn.addEventListener("click", async () => {
  if (abortScan) abortScan.abort();
  if (gmailAccessToken && window.google?.accounts?.oauth2) {
    try {
      window.google.accounts.oauth2.revoke(gmailAccessToken);
    } catch {
      /* ignore */
    }
  }
  await fetch("/api/auth/logout", { method: "POST" });
  setLoggedOutUI();
  renderGoogleButton();
});

async function boot() {
  const cfgRes = await fetch("/api/config");
  config = await cfgRes.json();
  if (!cfgRes.ok) throw new Error(config.error || "config failed");

  await waitForGis();
  renderGoogleButton();
  await refreshMe();
}

boot().catch((e) => {
  const msg = String(e.message || e);
  err.textContent = msg;
  loginStatus.textContent = msg;
});
