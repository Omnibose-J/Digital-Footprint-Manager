// core/ is served from /core (server.js mounts it); the browser resolves these as URLs, not paths.
import { collectSenders, scanFraction } from "/core/scan.js";
import { createAggregator } from "/core/filter.js";
import { loadCatalog, upgradeSnapshot, isStale } from "/core/catalog.js";
import { renderGuideHtml, renderRequestTemplate, maskAccount } from "/core/guide.js";
import { applyUserVerdict, sortBuckets } from "/core/verdict.js";
import { escapeHtml } from "/core/html.js";
import { initAnalytics, track } from "/core/analytics.js";

function el(id) {
  return document.getElementById(id);
}

const loginPanel = el("loginPanel");
const appPanel = el("appPanel");
const googleBtn = el("googleBtn");
const loginStatus = el("loginStatus");
const statusEl = el("status");
const progressEl = el("progress");
const progressTrack = el("progressTrack");
const progressBar = el("progressBar");
const meta = el("meta");
const err = el("err");
const rows = el("rows");
const hiddenToggle = el("hiddenToggle");
const hiddenBody = el("hiddenBody");
const hiddenRows = el("hiddenRows");
const linkNote = el("linkNote");
const emptyState = el("emptyState");
const scanBtn = el("scan");
const logoutBtn = el("logout");
const guideModal = el("guideModal");
const guideBackdrop = el("guideBackdrop");
const guideClose = el("guideClose");
const guideBody = el("guideBody");

const RULE_LABEL = {
  self: "본인 주소",
  invalid_domain: "유효하지 않은 도메인",
  relay_domain: "메일 중계 도메인",
  personal_mailbox: "개인 메일함",
  payment_gateway: "결제대행사",
};

let config = null;
/** @type {{ services: any[], hidden: any[], unresolved: any[], stats: any } | null} */
let lastSnapshot = null;
/**
 * key -> user's explicit verdict. Held outside the aggregator; re-applied on every render,
 * because each progress tick hands us a fresh snapshot that knows nothing about user input.
 * Session-only — a reload resets it (persistence needs the database, §8).
 *
 * Only 'candidate' is written now, by 복구 in the excluded bucket. The rule engine decides what
 * is not a service; the user only overrules it in the direction of putting a row back.
 */
const userVerdict = new Map(); // 'candidate'

const BAND_LABEL = {
  high: "높음",
  review: "검토",
  low: "낮음",
};
let abortScan = null;
/**
 * Which scan the UI currently belongs to. Aborting is not enough: requests already sent land
 * anyway, and logout is a DOM swap rather than a navigation, so a callback from a scan the user
 * walked away from would otherwise repaint the table for whoever signed in next.
 */
let scanGeneration = 0;
let gmailAccessToken = null;
let hiddenOpen = false;
/** @type {any | null} */
let catalog = null;
/** @type {HTMLElement | null} */
let guideTrigger = null;
/** Route of the guide currently on screen, for the outbound counter below. */
let guideRoute = "none";
let sessionEmail = "";
/** The Gmail account the scan actually read, from users/me/profile. Not sessionEmail. */
let scannedAccount = "";

// data-safety, not just data-out, because this one anchor points at two different things. For a
// catalogued row siteUrl is the catalog's own withdrawal URL; for an uncatalogued one it is
// https://{sender domain}, a guess, which is what #linkNote warns about. They look identical in the
// table, so counting them as one number would answer neither question.
function serviceCell(s) {
  const name = escapeHtml(s.displayName || s.registrableDomain || "");
  if (s.siteUrl) {
    return `<a href="${escapeHtml(s.siteUrl)}" data-out="list" data-safety="${escapeHtml(
      s.linkSafety || "inferred"
    )}" target="_blank" rel="noopener noreferrer">${name}</a>`;
  }
  return name;
}

function deletionCell(s, index) {
  if (s.likelyClosed) {
    return `<span class="band band-closed">폐쇄 추정</span>`;
  }
  // Without a catalog entry there is no verified route, no privacy contact for the request
  // template to reach, and nothing to say that is about THIS service. The old button opened
  // generic advice, which reads as an answer and is not one. State the gap instead.
  if (s.linkSafety !== "verified") {
    return `<span class="cell-none" title="이 서비스의 공식 탈퇴 경로를 아직 확인하지 못했습니다">경로 미확인</span>`;
  }
  const label = isStale(s.catalogEntry || {}) ? "탈퇴 (검토 필요)" : "탈퇴";
  return `<button type="button" class="btn-row" data-guide="${index}">${label}</button>`;
}

function bandCell(s) {
  const band = s.discoveryBand || "low";
  const score = s.discoveryScore ?? 0;
  const expl = s.scoreExplanation || `${score}점`;
  // No 폐쇄 추정 badge here. deletionCell already renders it in place of the 탈퇴 button, which is
  // where it belongs: it is an answer to "can I leave", not to "how sure are we you joined".
  return `<span class="band band-${escapeHtml(band)}">${escapeHtml(BAND_LABEL[band] || band)} ${escapeHtml(String(score))}</span><span class="score-why">${escapeHtml(expl)}</span>`;
}

const CLEANUP_LABEL = {
  recommended: "정리 권장",
  review: "검토",
  keep_or_watch: "보류",
};

/**
 * The answer to "what first", which is a different question from 신뢰 and routinely points the
 * other way: the account we are surest about is often the one being used every day.
 *
 * §4 scopes this to high-band rows, so a candidate we are not sure exists shows a dash instead of
 * a rank. Ordering "delete this first" above something that might not be an account would invert
 * the product, because the user works down the list.
 */
function cleanupCell(s) {
  if (s.cleanupScore === null || s.cleanupScore === undefined) {
    return `<span class="cell-none" title="신뢰 '높음' 후보만 우선도를 계산합니다">—</span>`;
  }
  const band = s.cleanupBand || "keep_or_watch";
  const inUse = s.inUse ? `<span class="badge-inuse">최근 사용 흔적</span>` : "";
  const label = escapeHtml(CLEANUP_LABEL[band] || band);
  return `<span class="pri pri-${escapeHtml(band)}">${label} ${escapeHtml(String(s.cleanupScore))}</span>${inUse}<span class="score-why">${escapeHtml(s.cleanupWhy || "")}</span>`;
}

function withCatalog(rawSnapshot) {
  // Order is forced: verdict moves buckets and clears hiddenRule, the catalog pass reads hiddenRule
  // to decide the link and only then can score cleanup, and the sort ranks by that score. Sorting
  // any earlier ranks by a field that does not exist yet.
  const overridden = applyUserVerdict(rawSnapshot, userVerdict);
  if (!catalog) return overridden;
  return sortBuckets(upgradeSnapshot(overridden, catalog));
}

// data-label carries the column header down into the cell, because on a phone the table stacks
// into cards and the <thead> is gone. Without it "2025-01" and "2" sit in a card with nothing
// saying which is the last trace and which is the message count.
function rowHtml(s, i) {
  return `<td class="cell-rank">${i + 1}</td>
      <td class="cell-service">${serviceCell(s)}</td>
      <td class="cell-domain">${escapeHtml(s.registrableDomain || "")}</td>
      <td data-label="정리 우선도">${cleanupCell(s)}</td>
      <td data-label="신뢰">${bandCell(s)}</td>
      <td class="cell-month" data-label="마지막 흔적">${escapeHtml(s.lastSeenMonth || "—")}</td>
      <td class="col-count" data-label="건수">${s.messageCount}</td>
      <td class="cell-action">${deletionCell(s, i)}</td>`;
}

/**
 * Reconcile the table against the snapshot, keyed by ServiceCandidate.key.
 *
 * This used to be one `rows.innerHTML = ...`, which during a scan destroys and rebuilds every row
 * roughly eight times a second for the length of the scan. That is what made the list twitch: the
 * browser re-measured every column against fresh content on each rebuild, so widths jumped, and
 * nothing on screen had an identity long enough to hover or animate.
 *
 * Keeping the <tr> alive and only writing cells that changed also makes the reorder legible. A row
 * whose score just rose slides to its new rank instead of teleporting there, and that is the one
 * moment during a scan where movement is information: it means the evidence for that service
 * changed a second ago.
 */
function reconcileRows(services) {
  const existing = new Map();
  for (const tr of rows.children) existing.set(tr.dataset.key, tr);

  // Measure before, so the move can be played from where each row actually was (FLIP).
  const before = new Map();
  for (const [key, tr] of existing) before.set(key, tr.getBoundingClientRect().top);

  const frag = document.createDocumentFragment();
  services.forEach((s, i) => {
    let tr = existing.get(s.key);
    if (!tr) {
      tr = document.createElement("tr");
      tr.dataset.key = s.key;
    }
    const html = rowHtml(s, i);
    // Only touch the DOM when the row actually changed. Most ticks change nothing for most rows.
    if (tr.dataset.html !== html) {
      tr.innerHTML = html;
      tr.dataset.html = html;
    }
    tr.classList.toggle("row-closed", Boolean(s.likelyClosed));
    existing.delete(s.key);
    frag.appendChild(tr);
  });
  for (const tr of existing.values()) tr.remove();
  rows.appendChild(frag);

  playRankMoves(before);
}

/** FLIP: invert each moved row to its old position, then let it transition home. */
function playRankMoves(before) {
  if (!before.size || prefersReducedMotion()) return;
  for (const tr of rows.children) {
    const from = before.get(tr.dataset.key);
    if (from === undefined) continue;
    const delta = from - tr.getBoundingClientRect().top;
    if (!delta || Math.abs(delta) < 1) continue;
    tr.animate(
      [{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }],
      { duration: 320, easing: "cubic-bezier(0.77, 0, 0.175, 1)" }
    );
  }
}

function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function renderSnapshot(rawSnapshot) {
  const snapshot = withCatalog(rawSnapshot);
  lastSnapshot = snapshot;
  const services = snapshot?.services || [];
  const excluded = [...(snapshot?.hidden || []), ...(snapshot?.unresolved || [])];

  reconcileRows(services);

  const hasInferred = services.some((s) => s.linkSafety === "inferred");
  linkNote.classList.toggle("hidden", !hasInferred);

  hiddenToggle.textContent = `제외된 발신자 ${excluded.length}개 보기`;
  hiddenRows.innerHTML = excluded
    .map((s, i) => {
      const reason = RULE_LABEL[s.hiddenRule] || s.hiddenRule || "—";
      return `<tr>
          <td>${i + 1}</td>
          <td class="cell-service">${escapeHtml(s.displayName || s.registrableDomain || "")}</td>
          <td class="cell-domain">${escapeHtml(s.registrableDomain || "")}</td>
          <td class="reason">${escapeHtml(reason)}</td>
          <td>${s.messageCount}</td>
          <td><button type="button" class="btn-row" data-restore="${i}">복구</button></td>
        </tr>`;
    })
    .join("");

  emptyState?.classList.toggle("hidden", services.length > 0);
}

function setProgressBar(fraction) {
  if (fraction === null) {
    progressTrack.hidden = true;
    return;
  }
  progressTrack.hidden = false;
  progressBar.style.transform = `scaleX(${fraction})`;
}

function resetProgressBar() {
  progressTrack.hidden = true;
  progressBar.style.transform = "scaleX(0)";
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
  resetProgressBar();
  meta.textContent = "";
  rows.innerHTML = "";
  hiddenRows.innerHTML = "";
  lastSnapshot = null;
  gmailAccessToken = null;
  sessionEmail = "";
  scannedAccount = "";
  linkNote.classList.add("hidden");
  hiddenBody.classList.add("hidden");
  hiddenOpen = false;
  hiddenToggle.textContent = "제외된 발신자 0개 보기";
  closeGuide();
}

function openGuide(candidate, trigger) {
  if (!candidate || !guideModal || !guideBody) return;
  // No entry means deletionCell rendered no button, so nothing can have called this. Reading the
  // field and leaving rather than rendering a guide with nothing in it: the uncatalogued modal is
  // gone on purpose and this must not quietly grow back into one.
  const entry = candidate.catalogEntry;
  if (!entry) return;
  guideTrigger = trigger || null;
  const stale = isStale(entry);
  const serviceName = entry.display_name || candidate.displayName || candidate.registrableDomain || "";
  // The scanned mailbox, not the signed-in one. Falls back to the session only before a scan
  // has run, which is the only moment the two cannot disagree.
  const masked = maskAccount(scannedAccount || sessionEmail);
  guideBody.innerHTML = renderGuideHtml({
    candidate,
    entry,
    stale,
    serviceName,
    maskedAccount: masked,
    // The mailbox the scan read, so the Gmail link opens the account these results came from.
    scannedAccount,
  });
  guideModal.classList.remove("hidden");
  guideModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  // band and route are our own enums. catalogued is gone: every guide that opens is catalogued now,
  // so the parameter had one value and measured nothing. scan_completed.no_route counts the rest.
  track("guide_opened", {
    band: candidate.discoveryBand || "low",
    route: entry.deletion_route || "none",
    stale,
  });
  guideRoute = entry.deletion_route || "none";
  guideClose?.focus();

  const copyBtn = document.getElementById("guideCopyBtn");
  copyBtn?.addEventListener("click", async () => {
    const tpl = renderRequestTemplate({ serviceName, maskedAccount: masked });
    try {
      await navigator.clipboard.writeText(tpl.fullText);
      // The strongest signal a guide was actually used. Still says nothing about which service.
      // catalogued is gone for the same reason it left guide_opened: openGuide returns early
      // without an entry, so Boolean(entry) was always true and the parameter measured nothing.
      // route is the useful cut, since copying matters most where sending it IS the withdrawal.
      track("template_copied", { route: entry.deletion_route || "none" });
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
  document.body.classList.remove("modal-open");
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
    // The funnel's denominator. logged_out has been counted since it shipped, which left its rate
    // unreadable: there was no measure of how many arrivals became sessions at all. Product
    // sign-in is not mailbox access (§6), and this carries nothing about one.
    track("logged_in", {});
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
      // Point the chooser at the account they signed in as. It is a hint, not a constraint: the
      // user can still pick another, which is why the scanned address is read back from the Gmail
      // profile and the request template is built from that rather than from this.
      login_hint: sessionEmail || undefined,
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
    // Empty string, not "consent". Per Google's own reference, "consent" forces the consent
    // screen on every single call, while an unspecified prompt means "the user is prompted only
    // on the first access request". The token lives in a variable and dies on reload, so with
    // "consent" every refresh made the user re-grant Gmail from scratch.
    //
    // This does not weaken the §5 boundary. The grant is still incremental and still separate
    // from the product sign-in, the token still never touches a cookie or our server, and the
    // user can still revoke at myaccount.google.com/permissions, which the trust block links.
    // What changes is only that we stop re-asking a question they already answered.
    tokenClient.requestAccessToken({ prompt: "" });
  });
}

hiddenToggle?.addEventListener("click", () => {
  hiddenOpen = !hiddenOpen;
  hiddenBody?.classList.toggle("hidden", !hiddenOpen);
  // Only the open. Counting the close too would double every curious user and answer nothing:
  // the question is whether anyone looks at what we threw away, not how long they looked.
  if (hiddenOpen) track("excluded_opened", { excluded: lastSnapshot ? lastSnapshot.hidden.length + lastSnapshot.unresolved.length : 0 });
});

hiddenRows?.addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-restore]");
  if (!btn || !lastSnapshot) return;
  const idx = Number(btn.getAttribute("data-restore"));
  const item = [...lastSnapshot.hidden, ...lastSnapshot.unresolved][idx];
  if (!item?.key) return;

  // The rule's own name, which is ours. A rule that gets restored half the time is a bug report
  // we would otherwise never receive: the user is telling us our exclusion was wrong, and this is
  // the only channel that carries it back.
  track("sender_restored", { reason: item.hiddenRule || "unresolved" });
  userVerdict.set(item.key, "candidate");
  renderSnapshot(lastSnapshot);
});

rows?.addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-guide]");
  if (!btn || !lastSnapshot) return;
  const idx = Number(btn.getAttribute("data-guide"));
  const item = lastSnapshot.services[idx];
  if (!item) return;
  openGuide(item, btn);
});

// The service name in the table is a link out, and it was the one outbound path with no counter.
// Delegated on the tbody, which survives the reconcile that replaces its rows during a scan.
rows?.addEventListener("click", (ev) => {
  const link = ev.target.closest?.("a[data-out]");
  if (!link) return;
  track("outbound_click", { link: link.dataset.out, safety: link.dataset.safety });
});

// Every link out of the modal goes to someone else's site, and that is the last thing this product
// can see: the withdrawal happens where we are not. Bound once, here, rather than per open, because
// guideBody survives the modal closing and re-binding it would fire the event once per open so far.
guideBody?.addEventListener("click", (ev) => {
  const link = ev.target.closest?.("a[data-out]");
  if (!link) return;
  track("outbound_click", { link: link.dataset.out, route: guideRoute });
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
  // The funnel's first step. scan_completed alone cannot see anyone who bounced off the Google
  // permission screen, which is exactly the moment this product asks for the most and is most
  // likely to lose someone.
  track("scan_started", {});
  err.textContent = "";
  meta.textContent = "";
  progressEl.textContent = "Gmail 권한 요청 중…";
  resetProgressBar();
  rows.innerHTML = "";
  hiddenRows.innerHTML = "";
  lastSnapshot = null;
  userVerdict.clear();
  scanBtn.disabled = true;
  linkNote.classList.add("hidden");

  if (abortScan) abortScan.abort();
  abortScan = new AbortController();
  const myScan = ++scanGeneration;

  try {
    gmailAccessToken = await requestGmailToken();
    progressEl.textContent = "스캔 시작…";

    // selfEmail comes from the Gmail profile, not /api/me (SOW 005 R7): an expired session
    // answers {loggedIn:false} with a 200, and an empty selfEmail turns the self rule into a
    // no-op, which makes the user's own address a candidate service.
    let aggregator = null;

    const result = await collectSenders(gmailAccessToken, {
      maxMessages: config.maxMessages,
      concurrency: config.concurrency,
      signal: abortScan.signal,
      onProfile: ({ account }) => {
        aggregator = createAggregator({ selfEmail: account || "" });
        // The mailbox we actually read, which is not necessarily the one signed into the product.
        // The Gmail token comes from a separate consent that offers its own account chooser, so a
        // multi-account user can sign in as one and scan another. SOW 005 R7 already established
        // that the aggregator must trust this address over /api/me; the request template is the
        // second consumer of the same fact and was still trusting the session.
        scannedAccount = account || "";
      },
      onMessage: (message) => aggregator.add(message),
      onProgress: (p) => {
        if (myScan !== scanGeneration) return;
        const snap = aggregator.snapshot();
        renderSnapshot(snap);
        progressEl.textContent = formatProgress(p, snap.stats);
        setProgressBar(scanFraction(p));
      },
    });

    // A scan can still resolve after logout: the listing loop breaks on the last page before it
    // rechecks the signal, so nothing here is reached only by the abort path.
    if (myScan !== scanGeneration) return;

    const finalSnap = aggregator.snapshot();
    renderSnapshot(finalSnap);

    const bands = { high: 0, review: 0, low: 0 };
    for (const s of finalSnap.services) {
      bands[s.discoveryBand] = (bands[s.discoveryBand] || 0) + 1;
    }
    const closedN = finalSnap.services.filter((s) => s.likelyClosed).length;

    progressEl.textContent = `완료: ${result.fetched} / ${result.scannedIds}${result.unlimited ? " (전체)" : ""}`;
    // The last tick lands a hair short of the total; a bar that stops at 99% reads as a stall.
    setProgressBar(1);

    // What the user is owed: whose mailbox, how much of it, what came out. This line used to
    // carry eleven fields including "unauthenticated 91/811" and "unknownFamily 189/811 (23.3%)",
    // which are our diagnostics wearing English identifiers in a Korean product.
    meta.textContent = [
      result.account,
      `메일 ${result.fetched}통 검사`,
      `후보 ${finalSnap.stats.services}개 (높음 ${bands.high} · 검토 ${bands.review} · 낮음 ${bands.low})`,
      closedN ? `폐쇄 추정 ${closedN}` : null,
      `제외 ${finalSnap.stats.hidden + finalSnap.stats.unresolved}`,
      result.errors ? `읽지 못한 메일 ${result.errors}통` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    // The diagnostics still exist, in the console, where they are for us. Every scoring decision
    // made today was argued from these two numbers, so they do not get to disappear.
    track("scan_completed", {
      messages: result.fetched,
      candidates: finalSnap.stats.services,
      high: bands.high,
      review: bands.review,
      low: bands.low,
      excluded: finalSnap.stats.hidden + finalSnap.stats.unresolved,
      errors: result.errors,
      // Catalog coverage, which the click used to report. guide_opened{catalogued:false} was the
      // one signal telling us which routes users reach for and we lack; removing that button to
      // stop promising an answer we do not have also removed the way to count the demand. This is
      // our catalog's miss rate, not a fact about their mailbox, so it belongs in the same event.
      //
      // lastSnapshot, not finalSnap: linkSafety only becomes "verified" inside withCatalog, which
      // renderSnapshot applies and stores here. Counting the raw aggregator snapshot marked every
      // row uncatalogued, so this reported 63 of 63 on a mailbox with four catalogued services —
      // a number that could never be anything but `candidates`.
      no_route: (lastSnapshot?.services || []).filter(
        (s) => !s.likelyClosed && s.linkSafety !== "verified"
      ).length,
    });

    console.info("[dfm] scan", {
      account: result.account,
      listed: result.scannedIds,
      fetched: result.fetched,
      errors: result.errors,
      candidates: finalSnap.stats.services,
      bands,
      likelyClosed: closedN,
      hidden: finalSnap.stats.hidden,
      unresolved: finalSnap.stats.unresolved,
      unauthenticated: `${finalSnap.stats.unauthenticatedMessages}/${finalSnap.stats.messages}`,
      unknownFamily: `${finalSnap.stats.unknownFamily}/${finalSnap.stats.messages}`,
      unknownShare:
        finalSnap.stats.messages > 0
          ? `${((finalSnap.stats.unknownFamily / finalSnap.stats.messages) * 100).toFixed(1)}%`
          : "0.0%",
    });
  } catch (e) {
    // The abandoned scan's own cancellation is not news for whoever is on the page now.
    if (myScan !== scanGeneration) return;
    err.textContent = String(e.message || e);
  } finally {
    scanBtn.disabled = false;
  }
});

logoutBtn?.addEventListener("click", async () => {
  track("logged_out", { scanned: Boolean(lastSnapshot) });
  // Disown the scan here, before the awaits below: the logout round-trip and the token revoke
  // both take longer than an in-flight Gmail read needs to come back and repaint the table.
  scanGeneration += 1;
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

  // Empty GA_MEASUREMENT_ID disables analytics entirely, which is what the e2e runs with.
  initAnalytics(config.gaMeasurementId);

  try {
    catalog = await loadCatalog();
  } catch (e) {
    console.warn("catalog load failed", e);
    catalog = { version: "missing", services: [] };
  }

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
