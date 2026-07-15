import { collectSenders } from "./scan.js";
import { createAggregator } from "./filter.js";

const loginPanel = document.getElementById("loginPanel");
const appPanel = document.getElementById("appPanel");
const googleBtn = document.getElementById("googleBtn");
const loginStatus = document.getElementById("loginStatus");
const statusEl = document.getElementById("status");
const progressEl = document.getElementById("progress");
const meta = document.getElementById("meta");
const err = document.getElementById("err");
const rows = document.getElementById("rows");
const hiddenToggle = document.getElementById("hiddenToggle");
const hiddenBody = document.getElementById("hiddenBody");
const hiddenRows = document.getElementById("hiddenRows");
const linkNote = document.getElementById("linkNote");
const scanBtn = document.getElementById("scan");
const saveBtn = document.getElementById("save");
const logoutBtn = document.getElementById("logout");

const FAMILY_LABEL = {
  signup: "가입",
  auth: "인증",
  transaction: "거래",
  notification: "알림",
  marketing: "마케팅",
  closure: "탈퇴",
  unknown: "미분류",
};

const RULE_LABEL = {
  self: "본인 주소",
  invalid_domain: "유효하지 않은 도메인",
  relay_domain: "메일 중계 도메인",
  personal_mailbox: "개인 메일함",
};

let config = null;
/** @type {{ services: any[], hidden: any[], unresolved: any[], stats: any } | null} */
let lastSnapshot = null;
/** Keys the user restored. Held outside the aggregator so each progress tick re-applies them. */
const restoredKeys = new Set();
let abortScan = null;
let gmailAccessToken = null;
let hiddenOpen = false;

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function evidenceBadges(families) {
  const order = ["signup", "auth", "transaction", "notification", "closure", "marketing", "unknown"];
  const parts = [];
  for (const f of order) {
    if ((families?.[f]?.count || 0) > 0) {
      parts.push(`<span class="badge">${escapeHtml(FAMILY_LABEL[f] || f)}</span>`);
    }
  }
  return parts.join(" · ") || "—";
}

function serviceCell(s) {
  const name = escapeHtml(s.displayName || s.registrableDomain || "");
  if (s.siteUrl) {
    return `<a href="${escapeHtml(s.siteUrl)}" target="_blank" rel="noopener noreferrer">${name}</a>`;
  }
  return name;
}

/**
 * Move user-restored entries out of the excluded buckets. Runs on every render because
 * each progress tick hands us a fresh snapshot that knows nothing about restores.
 * Link fields are left untouched: restoring says "this is a service", not "this URL is right".
 */
function applyRestores(snapshot) {
  if (!snapshot || restoredKeys.size === 0) return snapshot;
  const services = [...snapshot.services];
  const withoutRestored = (bucket) =>
    bucket.filter((s) => {
      if (!restoredKeys.has(s.key)) return true;
      services.push({ ...s, verdict: "candidate", hiddenRule: null });
      return false;
    });

  const hidden = withoutRestored(snapshot.hidden);
  const unresolved = withoutRestored(snapshot.unresolved);
  services.sort((a, b) => b.messageCount - a.messageCount);

  return {
    services,
    hidden,
    unresolved,
    stats: {
      ...snapshot.stats,
      services: services.length,
      hidden: hidden.length,
      unresolved: unresolved.length,
    },
  };
}

function renderSnapshot(rawSnapshot) {
  const snapshot = applyRestores(rawSnapshot);
  lastSnapshot = snapshot;
  const services = snapshot?.services || [];
  const excluded = [...(snapshot?.hidden || []), ...(snapshot?.unresolved || [])];

  rows.innerHTML = services
    .map(
      (s, i) =>
        `<tr>
          <td>${i + 1}</td>
          <td>${serviceCell(s)}</td>
          <td>${escapeHtml(s.registrableDomain || "")}</td>
          <td>${evidenceBadges(s.families)}</td>
          <td>${escapeHtml(s.lastSeenMonth || "—")}</td>
          <td>${s.messageCount}</td>
        </tr>`
    )
    .join("");

  const hasInferred = services.some((s) => s.linkSafety === "inferred");
  linkNote.classList.toggle("hidden", !hasInferred);

  hiddenToggle.textContent = `제외된 발신자 ${excluded.length}개 보기`;
  hiddenRows.innerHTML = excluded
    .map((s, i) => {
      const reason = RULE_LABEL[s.hiddenRule] || s.hiddenRule || "—";
      return `<tr>
          <td>${i + 1}</td>
          <td>${escapeHtml(s.displayName || s.registrableDomain || "")}</td>
          <td>${escapeHtml(s.registrableDomain || "")}</td>
          <td>${escapeHtml(reason)}</td>
          <td>${s.messageCount}</td>
          <td><button type="button" class="restore-btn" data-restore="${i}">복구</button></td>
        </tr>`;
    })
    .join("");

  saveBtn.disabled = services.length === 0;
}

function formatProgress(p, stats) {
  const totalLabel = p.target ? String(p.target) : "?";
  if (p.phase === "listing") {
    return `메일 ID 수집 중… ${p.scannedIds}${p.unlimited ? ` (전체 ~${totalLabel})` : ` / ${totalLabel}`}`;
  }
  return [
    `헤더 조회 중… ${p.fetched} / ${p.scannedIds || totalLabel}`,
    p.unlimited && p.target ? `전체 예상 ${p.target}` : null,
    stats ? `후보 ${stats.services} · 제외 ${stats.hidden + stats.unresolved}` : null,
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
  hiddenRows.innerHTML = "";
  lastSnapshot = null;
  gmailAccessToken = null;
  saveBtn.disabled = true;
  linkNote.classList.add("hidden");
  hiddenBody.classList.add("hidden");
  hiddenOpen = false;
  hiddenToggle.textContent = "제외된 발신자 0개 보기";
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
  reportIfButtonMissing();
}

/**
 * An unregistered origin is reported by GSI only to the devtools console; the container
 * is simply left empty. Without this the page shows a blank space and reads as "broken app"
 * — which is what it looked like to everyone who tried to run this.
 */
function reportIfButtonMissing() {
  setTimeout(() => {
    if (googleBtn.querySelector("iframe")) return;
    loginStatus.innerHTML = `
      <p style="color:#b00020"><strong>로그인 버튼을 불러오지 못했습니다.</strong></p>
      <p class="note">
        이 주소가 Google OAuth 클라이언트의 <strong>승인된 JavaScript 원본</strong>에 등록되어 있지 않습니다:<br />
        <code>${escapeHtml(window.location.origin)}</code>
      </p>
      <p class="note">
        Google Cloud Console → API 및 서비스 → 사용자 인증 정보에서 클라이언트
        <code>${escapeHtml(String(config?.clientId || "").split("-")[0])}</code> 를 열고
        위 주소를 추가한 뒤 이 페이지를 새로고침하세요. 반영에 몇 분 걸릴 수 있습니다.
      </p>`;
  }, 2500);
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

hiddenToggle.addEventListener("click", () => {
  hiddenOpen = !hiddenOpen;
  hiddenBody.classList.toggle("hidden", !hiddenOpen);
});

hiddenRows.addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-restore]");
  if (!btn || !lastSnapshot) return;
  const idx = Number(btn.getAttribute("data-restore"));
  const item = [...lastSnapshot.hidden, ...lastSnapshot.unresolved][idx];
  if (!item) return;

  restoredKeys.add(item.key);
  renderSnapshot(lastSnapshot);
});

scanBtn.addEventListener("click", async () => {
  err.textContent = "";
  meta.textContent = "";
  progressEl.textContent = "Gmail 권한 요청 중…";
  rows.innerHTML = "";
  hiddenRows.innerHTML = "";
  lastSnapshot = null;
  restoredKeys.clear();
  scanBtn.disabled = true;
  saveBtn.disabled = true;
  linkNote.classList.add("hidden");

  if (abortScan) abortScan.abort();
  abortScan = new AbortController();

  try {
    gmailAccessToken = await requestGmailToken();
    progressEl.textContent = "스캔 시작…";

    // Prefer Gmail profile email for self-exclusion; fall back to app session.
    let aggregator = null;
    const meData = await fetch("/api/me").then((r) => r.json());
    aggregator = createAggregator({ selfEmail: meData.email || "" });

    const result = await collectSenders(gmailAccessToken, {
      maxMessages: config.maxMessages,
      concurrency: config.concurrency,
      signal: abortScan.signal,
      onMessage: (message) => {
        aggregator.add(message);
      },
      onProgress: (p) => {
        if (
          p.account &&
          meData.email &&
          p.account.toLowerCase() !== String(meData.email).toLowerCase() &&
          aggregator.snapshot().stats.messages === 0
        ) {
          aggregator = createAggregator({ selfEmail: p.account });
        }
        const snap = aggregator.snapshot();
        renderSnapshot(snap);
        progressEl.textContent = formatProgress(p, snap.stats);
      },
    });

    const finalSnap = aggregator.snapshot();
    renderSnapshot(finalSnap);

    const unknownShare =
      finalSnap.stats.messages > 0
        ? ((finalSnap.stats.unknownFamily / finalSnap.stats.messages) * 100).toFixed(1)
        : "0.0";

    progressEl.textContent = `완료: ${result.fetched} / ${result.scannedIds}${result.unlimited ? " (전체)" : ""}`;
    meta.textContent = [
      `Gmail: ${result.account}`,
      `스캔 ID: ${result.scannedIds}`,
      `헤더 조회: ${result.fetched}`,
      `에러: ${result.errors}`,
      `후보 ${finalSnap.stats.services}`,
      `제외 ${finalSnap.stats.hidden}`,
      `미해결 ${finalSnap.stats.unresolved}`,
      `unknownFamily ${finalSnap.stats.unknownFamily}/${finalSnap.stats.messages} (${unknownShare}%)`,
    ].join(" · ");
  } catch (e) {
    err.textContent = String(e.message || e);
  } finally {
    scanBtn.disabled = false;
  }
});

saveBtn.addEventListener("click", async () => {
  err.textContent = "";
  const services = lastSnapshot?.services || [];
  // Fold by domain: free-mailbox rescues are per-address, so two candidates can share
  // one registrable domain. The server keeps the first and drops the rest, not the sum.
  const byDomain = new Map();
  for (const s of services) {
    if (!s.registrableDomain) continue;
    byDomain.set(s.registrableDomain, (byDomain.get(s.registrableDomain) || 0) + s.messageCount);
  }
  const domains = [...byDomain].map(([domain, count]) => ({ domain, count }));

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
