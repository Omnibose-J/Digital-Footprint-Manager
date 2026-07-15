import { collectSenders } from "./scan.js";
import { createAggregator } from "./filter.js";
import { loadCatalog, upgradeSnapshot, isStale } from "./catalog.js";
import { renderGuideHtml, renderRequestTemplate, maskAccount } from "./guide.js";
import { applyUserVerdict } from "./verdict.js";

function el(id) {
  return document.getElementById(id);
}

const loginPanel = el("loginPanel");
const appPanel = el("appPanel");
const googleBtn = el("googleBtn");
const loginStatus = el("loginStatus");
const statusEl = el("status");
const progressEl = el("progress");
const meta = el("meta");
const err = el("err");
const rows = el("rows");
const hiddenToggle = el("hiddenToggle");
const hiddenBody = el("hiddenBody");
const hiddenRows = el("hiddenRows");
const linkNote = el("linkNote");
const scanBtn = el("scan");
const saveBtn = el("save");
const logoutBtn = el("logout");
const guideModal = el("guideModal");
const guideBackdrop = el("guideBackdrop");
const guideClose = el("guideClose");
const guideBody = el("guideBody");

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
  payment_gateway: "결제대행사",
  not_mine: "내 계정 아님",
};

let config = null;
/** @type {{ services: any[], hidden: any[], unresolved: any[], stats: any } | null} */
let lastSnapshot = null;
/**
 * key -> user's explicit verdict. Held outside the aggregator; re-applied on every render,
 * because each progress tick hands us a fresh snapshot that knows nothing about user input.
 * Session-only — a reload resets it (no persistence in this SOW).
 */
const userVerdict = new Map(); // 'owned' | 'not_mine' | 'unsure' | 'candidate'

const BAND_LABEL = {
  high: "높음",
  review: "검토",
  low: "낮음",
};
let abortScan = null;
let gmailAccessToken = null;
let hiddenOpen = false;
/** @type {any | null} */
let catalog = null;
/** @type {((domain: string|null, hiddenRule: string|null, match?: any|null) => any) | null} */
let linkFieldsFn = null;
/** @type {HTMLElement | null} */
let guideTrigger = null;
let sessionEmail = "";

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

function deletionCell(s, index) {
  if (s.likelyClosed && s.userStatus !== "owned") {
    return `<span class="badge badge-closed">폐쇄 추정</span>`;
  }
  const label =
    s.linkSafety === "verified"
      ? isStale(s.catalogEntry || {})
        ? "탈퇴 (검토 필요)"
        : "탈퇴"
      : "탈퇴 안내";
  return `<button type="button" class="guide-open-btn" data-guide="${index}">${label}</button>`;
}

function bandCell(s) {
  const band = s.discoveryBand || "low";
  const score = s.discoveryScore ?? 0;
  const expl = s.scoreExplanation || `${score}점`;
  const owned = s.userStatus === "owned" ? ` <span class="badge badge-owned">내 계정</span>` : "";
  const closed =
    s.likelyClosed && s.userStatus !== "owned"
      ? ` <span class="badge badge-closed">폐쇄 추정</span>`
      : "";
  return `<span class="badge badge-band badge-${escapeHtml(band)}">${escapeHtml(BAND_LABEL[band] || band)}</span> ${escapeHtml(String(score))} · ${escapeHtml(expl)}${owned}${closed}`;
}

function confirmCell(index) {
  return [
    `<button type="button" class="confirm-btn" data-owned="${index}">내 계정</button>`,
    `<button type="button" class="not-mine-btn" data-not-mine="${index}">아님</button>`,
    `<button type="button" class="unsure-btn" data-unsure="${index}">모르겠음</button>`,
  ].join(" ");
}

function withCatalog(rawSnapshot) {
  const overridden = applyUserVerdict(rawSnapshot, userVerdict);
  if (!catalog || !linkFieldsFn) return overridden;
  return upgradeSnapshot(overridden, catalog, linkFieldsFn);
}

function renderSnapshot(rawSnapshot) {
  const snapshot = withCatalog(rawSnapshot);
  lastSnapshot = snapshot;
  const services = snapshot?.services || [];
  const excluded = [...(snapshot?.hidden || []), ...(snapshot?.unresolved || [])];

  rows.innerHTML = services
    .map(
      (s, i) =>
        `<tr class="${s.likelyClosed && s.userStatus !== "owned" ? "row-closed" : ""}">
          <td>${i + 1}</td>
          <td>${serviceCell(s)}</td>
          <td>${escapeHtml(s.registrableDomain || "")}</td>
          <td>${bandCell(s)}</td>
          <td>${evidenceBadges(s.families)}</td>
          <td>${escapeHtml(s.lastSeenMonth || "—")}</td>
          <td>${s.messageCount}</td>
          <td>${deletionCell(s, i)}</td>
          <td>${confirmCell(i)}</td>
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
  sessionEmail = me.email || "";
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
  sessionEmail = "";
  saveBtn.disabled = true;
  linkNote.classList.add("hidden");
  hiddenBody.classList.add("hidden");
  hiddenOpen = false;
  hiddenToggle.textContent = "제외된 발신자 0개 보기";
  closeGuide();
}

function openGuide(candidate, trigger) {
  if (!candidate || !guideModal || !guideBody) return;
  guideTrigger = trigger || null;
  const entry = candidate.catalogEntry || null;
  const stale = entry ? isStale(entry) : false;
  const serviceName = entry?.display_name || candidate.displayName || candidate.registrableDomain || "";
  const masked = maskAccount(sessionEmail);
  guideBody.innerHTML = renderGuideHtml({
    candidate,
    entry,
    stale,
    serviceName,
    maskedAccount: masked,
  });
  guideModal.classList.remove("hidden");
  guideModal.setAttribute("aria-hidden", "false");
  guideClose?.focus();

  const copyBtn = document.getElementById("guideCopyBtn");
  copyBtn?.addEventListener("click", async () => {
    const tpl = renderRequestTemplate({ serviceName, maskedAccount: masked });
    try {
      await navigator.clipboard.writeText(tpl.fullText);
      copyBtn.textContent = "복사됨";
      setTimeout(() => {
        copyBtn.textContent = "템플릿 복사";
      }, 1500);
    } catch {
      copyBtn.textContent = "복사 실패";
    }
  });
}

function closeGuide() {
  if (!guideModal) return;
  guideModal.classList.add("hidden");
  guideModal.setAttribute("aria-hidden", "true");
  if (guideBody) guideBody.innerHTML = "";
  const trigger = guideTrigger;
  guideTrigger = null;
  if (trigger && typeof trigger.focus === "function") trigger.focus();
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

hiddenToggle?.addEventListener("click", () => {
  hiddenOpen = !hiddenOpen;
  hiddenBody?.classList.toggle("hidden", !hiddenOpen);
});

hiddenRows?.addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-restore]");
  if (!btn || !lastSnapshot) return;
  const idx = Number(btn.getAttribute("data-restore"));
  const item = [...lastSnapshot.hidden, ...lastSnapshot.unresolved][idx];
  if (!item?.key) return;

  userVerdict.set(item.key, "candidate");
  renderSnapshot(lastSnapshot);
});

rows?.addEventListener("click", (ev) => {
  const ownedBtn = ev.target.closest("[data-owned]");
  if (ownedBtn && lastSnapshot) {
    const idx = Number(ownedBtn.getAttribute("data-owned"));
    const item = lastSnapshot.services[idx];
    if (!item?.key) return;
    userVerdict.set(item.key, "owned");
    renderSnapshot(lastSnapshot);
    return;
  }
  const unsureBtn = ev.target.closest("[data-unsure]");
  if (unsureBtn && lastSnapshot) {
    const idx = Number(unsureBtn.getAttribute("data-unsure"));
    const item = lastSnapshot.services[idx];
    if (!item?.key) return;
    userVerdict.set(item.key, "unsure");
    renderSnapshot(lastSnapshot);
    return;
  }
  const notMineBtn = ev.target.closest("[data-not-mine]");
  if (notMineBtn && lastSnapshot) {
    const idx = Number(notMineBtn.getAttribute("data-not-mine"));
    const item = lastSnapshot.services[idx];
    if (!item?.key) return;
    userVerdict.set(item.key, "not_mine");
    renderSnapshot(lastSnapshot);
    return;
  }

  const btn = ev.target.closest("[data-guide]");
  if (!btn || !lastSnapshot) return;
  const idx = Number(btn.getAttribute("data-guide"));
  const item = lastSnapshot.services[idx];
  if (!item) return;
  openGuide(item, btn);
});

guideClose?.addEventListener("click", () => closeGuide());
guideBackdrop?.addEventListener("click", () => closeGuide());
{
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && guideModal && !guideModal.classList.contains("hidden")) {
      closeGuide();
    }
  });
}

scanBtn?.addEventListener("click", async () => {
  err.textContent = "";
  meta.textContent = "";
  progressEl.textContent = "Gmail 권한 요청 중…";
  rows.innerHTML = "";
  hiddenRows.innerHTML = "";
  lastSnapshot = null;
  userVerdict.clear();
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
    linkFieldsFn = aggregator.linkFields;

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
          linkFieldsFn = aggregator.linkFields;
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
    const bands = { high: 0, review: 0, low: 0 };
    for (const s of finalSnap.services) {
      bands[s.discoveryBand] = (bands[s.discoveryBand] || 0) + 1;
    }
    const closedN = finalSnap.services.filter((s) => s.likelyClosed).length;

    progressEl.textContent = `완료: ${result.fetched} / ${result.scannedIds}${result.unlimited ? " (전체)" : ""}`;
    meta.textContent = [
      `Gmail: ${result.account}`,
      `스캔 ID: ${result.scannedIds}`,
      `헤더 조회: ${result.fetched}`,
      `에러: ${result.errors}`,
      `후보 ${finalSnap.stats.services}`,
      `높음 ${bands.high} · 검토 ${bands.review} · 낮음 ${bands.low}`,
      `폐쇄추정 ${closedN}`,
      `제외 ${finalSnap.stats.hidden}`,
      `미해결 ${finalSnap.stats.unresolved}`,
      `unauthenticated ${finalSnap.stats.unauthenticatedMessages}/${finalSnap.stats.messages}`,
      `unknownFamily ${finalSnap.stats.unknownFamily}/${finalSnap.stats.messages} (${unknownShare}%)`,
    ].join(" · ");
  } catch (e) {
    err.textContent = String(e.message || e);
  } finally {
    scanBtn.disabled = false;
  }
});

saveBtn?.addEventListener("click", async () => {
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

logoutBtn?.addEventListener("click", async () => {
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

  try {
    catalog = await loadCatalog();
  } catch (e) {
    console.warn("catalog load failed", e);
    catalog = { version: "missing", services: [] };
  }

  // linkFields needs an aggregator instance; create a throwaway for boot-time upgrades.
  linkFieldsFn = createAggregator({ selfEmail: "" }).linkFields;

  await waitForGis();
  renderGoogleButton();
  await refreshMe();
}

if (loginPanel) {
  boot().catch((e) => {
    const msg = String(e.message || e);
    if (err) err.textContent = msg;
    if (loginStatus) loginStatus.textContent = msg;
  });
}
