// core/ is served from /core (server.js mounts it); the browser resolves these as URLs, not paths.
import { collectSenders, scanFraction } from "/core/scan.js";
import { createAggregator } from "/core/filter.js";
import { loadCatalog, upgradeSnapshot, isStale } from "/core/catalog.js";
import { renderGuideHtml, renderRequestTemplate, maskAccount } from "/core/guide.js";
import { applyUserVerdict, sortBuckets } from "/core/verdict.js";
import { escapeHtml } from "/core/html.js";
import { initAnalytics, track } from "/core/analytics.js";
import { FREE_MAILBOX_DOMAINS } from "/core/filter.rules.js";
import { resolveCancelLink } from "/core/cancel-urls.js";

const FREE_MAILBOX_SET = new Set(FREE_MAILBOX_DOMAINS);

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
const choiceSummary = el("choiceSummary");
const unusedSummary = el("unusedSummary");
const unusedRows = el("unusedRows");
const unusedEmpty = el("unusedEmpty");
const panelAll = el("panelAll");
const panelUnused = el("panelUnused");
const tabAll = el("tabAll");
const tabUnused = el("tabUnused");
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

let abortScan = null;
/**
 * Which scan the UI currently belongs to. Aborting is not enough: requests already sent land
 * anyway, and logout is a DOM swap rather than a navigation, so a callback from a scan the user
 * walked away from would otherwise repaint the table for whoever signed in next.
 */
let scanGeneration = 0;
/**
 * Which session the in-memory user data belongs to — the same device as scanGeneration, for the
 * same reason: signing in and out are DOM swaps rather than navigations, so nothing gets thrown
 * away for us and a reply from the last session lands on this one's screen.
 */
let sessionGeneration = 0;
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

/**
 * @type {Record<string, "keep"|"delete">} domain -> choice (keep=사용, delete=미사용)
 *
 * Server-owned, loaded per session. This lived in localStorage until §8's storage decision caught up
 * with it: Safari evicts first-party storage on a 7-day no-interaction timer and a device switch is
 * total loss, and a label is the one thing a re-scan cannot rebuild. There is deliberately no
 * localStorage fallback — a fallback here would keep the screen looking right while the thing it
 * promises to remember quietly did not persist.
 */
let cleanupChoices = {};
/**
 * @type {Record<string, { withdrawnAt: string|null, unsubscribedAt: string|null }>}
 *
 * 탈퇴 완료 and 구독해지 완료, which are two facts and not one: unsubscribing does not close an
 * account and closing one does not stop mail already queued (§4's distinction warnings say exactly
 * this on screen, so one checkbox for both would have the data model contradicting the copy).
 *
 * Server-owned for the same reason as the labels above, and more so — this is the one thing a
 * re-scan can never reconstruct. It is not "did we find mail", it is "did this person do a thing".
 * The timestamps come from the server; nothing here ever sends one.
 */
let cleanupStatus = {};
/**
 * @type {Record<string, { category: string, realService: string, reason: string }>} keyed by
 * ServiceCandidate.key
 *
 * §8 (2026-07-16): Gemini names a sender, and that is all. The rules read a domain and call it the
 * service, which is wrong whenever a company sends through someone else's estate — Cursor's mail
 * arrives from stripe.com, so the list showed a payment processor and hid the real account. That is
 * knowledge about the world, not a pattern in the header, so no rule fixes it.
 *
 * It never touches a score. discoveryScore, the bands, the cleanup rank and every §4 gate are
 * computed before this arrives and are not recomputed after: an empty object here is exactly the
 * rules-only product, which is what a missing key or a Gemini outage leaves behind.
 */
let geminiByKey = {};
/** @type {"all"|"unused"} */
let activeTab = "all";

/** Reverse of CHOICE_TO_SPEC: the API speaks §3, the row speaks keep/delete. */
const SPEC_TO_CHOICE = { in_use: "keep", unused: "delete" };

/**
 * Ask Gemini who these senders actually are. Display name and address only — §3's amended boundary.
 *
 * Fails soft, and that is a design rule rather than laziness (§8): the scan is already complete and
 * correct when this runs, so a failure costs better names, not results. Anything louder would be
 * telling the user something broke when nothing they asked for did.
 */
async function classifySenders(services) {
  const senders = (services || [])
    .filter((s) => s.primaryEmail)
    .map((s) => ({
      key: s.key,
      displayName: s.displayName || "",
      // Not just the name the row prints: stripe.com is "Cursor via Stripe" and "Notion via Stripe"
      // at once, and the winner alone is the one fact that cannot resolve either of them.
      names: s.senderNames || [],
      // A subject sample, weighted to what the phrase rules could not read (§3, amended 2026-07-16).
      subjects: s.subjects || [],
      email: s.primaryEmail,
    }));
  // Console, not `err`. These lines were on screen for a while, and they were wrong to be there:
  // `err` is where we tell the user something they asked for failed, and nobody asked for better
  // names — the scan is complete and correct before this runs. Two e2e tests said so by asserting
  // `err` stays empty when the classifier gives nothing back, and they were right.
  //
  // They still say which of the four outcomes happened, because the failure this actually had was
  // invisible: a retired model 404'd every batch, the route failed soft exactly as designed, and an
  // empty 비고 looked identical to "Gemini had nothing to say".
  if (!senders.length) {
    console.warn(`[gemini] not sent: 0 of ${(services || []).length} candidates have an address`);
    return {};
  }
  try {
    const res = await fetch("/api/classify-senders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ senders }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[gemini] request failed: HTTP ${res.status} ${body.slice(0, 200)}`);
      return {};
    }
    const data = await res.json();
    const n = Object.keys(data?.results || {}).length;
    // Empty is not proof the server never reached Gemini — a non-JSON reply and a batch of senders
    // it declined to classify land here too. Report the shape, not a guessed cause; the server logs
    // which one it was.
    if (!n) console.warn(`[gemini] empty result: sent ${senders.length}, got 0`);
    return data?.results || {};
  } catch (e) {
    console.warn("[gemini] request threw", e?.message || e);
    return {};
  }
}

/**
 * Load this user's labels and their completion status in one call.
 *
 * Returns empty for a signed-out visitor, which is the correct empty answer and not a failure — the
 * rows are keyed to a session that does not exist yet.
 *
 * @returns {Promise<{ choices: Record<string,"keep"|"delete">, status: Record<string, any> }>}
 */
async function fetchChoices() {
  const empty = { choices: {}, status: {} };
  let data;
  try {
    const res = await fetch("/api/choices");
    if (res.status === 401) return empty;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (e) {
    // Loud, because the silent version is cruel: an empty list is indistinguishable from "you never
    // labelled anything", so the user re-answers questions they already answered and never learns
    // their earlier answers still exist on the server.
    err.textContent = "저장된 선택을 불러오지 못했습니다. 새로고침하면 다시 시도합니다.";
    console.warn("[choices] load failed", e);
    return empty;
  }
  const choices = {};
  const status = {};
  for (const [domain, value] of Object.entries(data?.choices || {})) {
    const d = normalizeDomain(domain);
    const c = SPEC_TO_CHOICE[value?.choice];
    if (!d || !c) continue;
    choices[d] = c;
    status[d] = {
      withdrawnAt: value?.withdrawnAt ?? null,
      unsubscribedAt: value?.unsubscribedAt ?? null,
    };
  }
  return { choices, status };
}

function normalizeDomain(domain) {
  return String(domain || "")
    .toLowerCase()
    .replace(/\.$/, "")
    .trim();
}

function getChoice(domain) {
  const d = normalizeDomain(domain);
  return d ? cleanupChoices[d] || null : null;
}

/**
 * Apply the label locally, then persist it.
 *
 * Optimistic on purpose: the row has to answer the click now, and a spinner on a two-state toggle is
 * worse than the rare rollback below. `item` carries the scores AS SHOWN — §8 stores them beside the
 * label because "we said 정리 권장 and they said 사용" is the whole measurement, and it stops meaning
 * anything once the scoring rules move.
 *
 * @param {string} domain
 * @param {"keep"|"delete"} choice
 * @param {any} [item] the candidate as rendered, for the scores we showed
 */
async function setChoice(domain, choice, item) {
  const d = normalizeDomain(domain);
  if (!d || (choice !== "keep" && choice !== "delete")) return;

  const previousChoice = cleanupChoices[d];
  cleanupChoices[d] = choice;
  // Flipping back to 사용 no longer wipes the completion. It used to, when 완료 was a browser flag
  // with no meaning outside this tab — but "나는 이 서비스를 탈퇴했다" is a fact about something the
  // user did, and it does not stop being true because they later re-labelled the row.

  try {
    const res = await fetch(`/api/choices/${encodeURIComponent(d)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        choice: CHOICE_TO_SPEC[choice],
        cleanupScore: item?.cleanupScore ?? null,
        cleanupBand: item?.cleanupBand ?? null,
        discoveryScore: item?.discoveryScore ?? null,
        discoveryBand: item?.discoveryBand ?? null,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    // Put the row back where it was. A label that looks saved and is not is the one outcome worth
    // undoing a click for: the user would never know to answer it again.
    if (previousChoice) cleanupChoices[d] = previousChoice;
    else delete cleanupChoices[d];
    err.textContent = "선택을 저장하지 못했습니다. 다시 눌러 주세요.";
    console.warn("[choices] save failed", e);
    if (lastSnapshot) renderSnapshot(lastSnapshot);
  }
}

/** @param {"withdrawn"|"unsubscribed"} field */
function isStatusOn(domain, field) {
  const st = cleanupStatus[normalizeDomain(domain)];
  return Boolean(field === "withdrawn" ? st?.withdrawnAt : st?.unsubscribedAt);
}

const STATUS_FIELD_KEY = { withdrawn: "withdrawnAt", unsubscribed: "unsubscribedAt" };

/**
 * Mark 탈퇴 완료 / 구독해지 완료, then persist it.
 *
 * Optimistic like the label, and rolled back the same way — but this one matters more. §8's storage
 * decision turns on exactly this field: "a re-scan rebuilds the candidate list but cannot rebuild
 * cleanup status — which deletion requests the user already filed is human-generated and
 * irreplaceable". A checkbox that looks ticked and is not would be silently telling them a job is
 * done that they will have to do again.
 *
 * The optimistic timestamp is a placeholder for "on", never a value: the server stamps the real time
 * and the response overwrites this. Nothing on screen reads it, only its presence.
 *
 * @param {"withdrawn"|"unsubscribed"} field
 */
async function setStatus(domain, field, on) {
  const d = normalizeDomain(domain);
  const key = STATUS_FIELD_KEY[field];
  if (!d || !key) return;

  const previous = cleanupStatus[d] || { withdrawnAt: null, unsubscribedAt: null };
  cleanupStatus[d] = { ...previous, [key]: on ? "pending" : null };
  renderUnusedList();

  try {
    const res = await fetch(`/api/choices/${encodeURIComponent(d)}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: on }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    cleanupStatus[d] = {
      withdrawnAt: data?.withdrawnAt ?? null,
      unsubscribedAt: data?.unsubscribedAt ?? null,
    };
  } catch (e) {
    cleanupStatus[d] = previous;
    err.textContent = "완료 표시를 저장하지 못했습니다. 다시 눌러 주세요.";
    console.warn("[status] save failed", e);
  }
  renderUnusedList();
}

function updateChoiceSummary(services) {
  if (!choiceSummary) return;
  const list = services || [];
  if (!list.length) {
    choiceSummary.classList.add("hidden");
    return;
  }
  let unused = 0;
  let used = 0;
  for (const s of list) {
    const c = getChoice(s.registrableDomain);
    if (c === "delete") unused += 1;
    else if (c === "keep") used += 1;
  }
  choiceSummary.textContent = `미사용 ${unused}개 / 사용 ${used}개`;
  choiceSummary.classList.remove("hidden");
}

/**
 * The 미사용 list, in its own stable order.
 *
 * It used to inherit the 후보 list's order, which is sorted by cleanup rank — a rank that moves while
 * the user works: labelling a row re-sorts, a Gemini answer re-renders, and rows this tab already
 * showed jumped around under a cursor about to click 탈퇴 완료. Nothing here needs that ranking
 * anyway; the user already decided about every row on this tab.
 *
 * Done sinks, then alphabetical by domain. Both are properties of the row itself, so the same list
 * renders the same way every time regardless of what just happened on the other tab.
 */
function unusedServicesFromSnapshot(snapshot) {
  return (snapshot?.services || [])
    .filter((s) => getChoice(s.registrableDomain) === "delete")
    .sort((a, b) => {
      const da = isStatusOn(a.registrableDomain, "withdrawn") ? 1 : 0;
      const db = isStatusOn(b.registrableDomain, "withdrawn") ? 1 : 0;
      if (da !== db) return da - db;
      // Fewest mails first, same as the 후보 list: the service that sent twice is the one the user
      // is least sure about, and this tab is where they act. Domain breaks ties so the order is
      // total — two services with the same count must not swap places between renders.
      if (a.messageCount !== b.messageCount) return a.messageCount - b.messageCount;
      return normalizeDomain(a.registrableDomain).localeCompare(normalizeDomain(b.registrableDomain));
    });
}

/**
 * 미사용 탭 only. The 후보 list dropped this column: that list asks "which of these do you still
 * use", and an answer to a question the user has not been asked yet is clutter with a target on it.
 * Here the user has already said 미사용, so the withdrawal route is the next thing they want and
 * this tab exists to hand it to them.
 */
function deletionCell(s) {
  if (s.likelyClosed) {
    return `<span class="band band-closed">폐쇄 추정</span>`;
  }
  const name = s.displayName || s.registrableDomain || "";
  const domain = normalizeDomain(s.registrableDomain);
  const action = resolveCancelLink(s.registrableDomain, name);
  return `<a class="btn-row" href="${escapeHtml(action.url)}" data-out="cancel" data-cancel-type="${escapeHtml(
    action.type
  )}" data-domain="${escapeHtml(domain)}" target="_blank" rel="noopener noreferrer">${escapeHtml(action.label)}</a>`;
}

function unusedRowHtml(s, i) {
  const domain = normalizeDomain(s.registrableDomain);
  const d = escapeHtml(domain);
  const done = isStatusOn(domain, "withdrawn");
  // One button, and it asks before it commits. A checkbox records a fact the moment the pointer
  // lands on it, and this fact is "나는 이 서비스를 탈퇴했다" — a thing the user does elsewhere, on
  // the service's own site, and can only misclick here. The confirm is the gap between the two.
  const doneCell = done
    ? `<button type="button" class="btn-row is-done" data-withdraw="${d}" data-on="1">탈퇴 완료됨</button>`
    : `<button type="button" class="btn-row" data-withdraw="${d}" data-on="0">탈퇴 완료</button>`;
  return `<td class="cell-rank">${i + 1}</td>
      <td class="cell-service">${serviceCell(s)}</td>
      <td class="cell-domain">${escapeHtml(domain)}</td>
      <td class="cell-month" data-label="마지막 흔적">${escapeHtml(s.lastSeenMonth || "—")}</td>
      <td class="cell-action">${deletionCell(s)}</td>
      <td class="cell-done" data-label="완료">${doneCell}</td>`;
}

function renderUnusedList() {
  if (!unusedRows) return;
  const list = unusedServicesFromSnapshot(lastSnapshot);
  unusedRows.innerHTML = list
    .map((s, i) => {
      // 탈퇴, not 구독해지, dims the row: this tab exists to get people out of services, and
      // unsubscribing is housekeeping they may do without ever leaving.
      const trClass = isStatusOn(s.registrableDomain, "withdrawn") ? ' class="row-done"' : "";
      return `<tr${trClass}>${unusedRowHtml(s, i)}</tr>`;
    })
    .join("");

  const doneCount = list.filter((s) => isStatusOn(s.registrableDomain, "withdrawn")).length;
  if (unusedSummary) {
    unusedSummary.textContent = `미사용 ${list.length}개 · 탈퇴 완료 ${doneCount}개`;
  }
  unusedEmpty?.classList.toggle("hidden", list.length > 0);
}

function setActiveTab(tab) {
  activeTab = tab === "unused" ? "unused" : "all";
  const showUnused = activeTab === "unused";
  panelAll?.classList.toggle("hidden", showUnused);
  panelUnused?.classList.toggle("hidden", !showUnused);
  if (panelUnused) panelUnused.hidden = !showUnused;
  if (panelAll) panelAll.hidden = showUnused;
  tabAll?.classList.toggle("is-active", !showUnused);
  tabUnused?.classList.toggle("is-active", showUnused);
  tabAll?.setAttribute("aria-selected", String(!showUnused));
  tabUnused?.setAttribute("aria-selected", String(showUnused));
  if (showUnused) renderUnusedList();
}

// Service name opens the sender's site (https://{domain}). Personal free-mailbox domains stay
// plain text — https://gmail.com is not a product homepage worth sending anyone to.
function serviceCell(s) {
  // Gemini's name wins over the one we derived from the domain — that is the whole reason it is here
  // (§8). stripe.com is Cursor's mail estate, not Cursor's brand, and only the name changes: the row
  // is still keyed, scored and grouped by the domain underneath it, which is printed right below.
  const inferred = geminiByKey[s.key]?.realService;
  const name = escapeHtml(inferred || s.displayName || s.registrableDomain || "");
  const domain = String(s.registrableDomain || "")
    .toLowerCase()
    .replace(/\.$/, "");
  const nameHtml = `<span class="service-name">${name}</span>`;
  const domainHtml = domain ? `<span class="service-domain">${escapeHtml(domain)}</span>` : "";
  if (!domain || s.linkBlockedBy === "free_mailbox" || FREE_MAILBOX_SET.has(domain)) {
    return `${nameHtml}${domainHtml}`;
  }
  return `<a class="service-link" href="https://${escapeHtml(domain)}" data-out="list" data-safety="domain" target="_blank" rel="noopener noreferrer">${nameHtml}${domainHtml}</a>`;
}


function choiceCell(s) {
  const domain = normalizeDomain(s.registrableDomain);
  if (!domain) {
    return `<span class="cell-none">—</span>`;
  }
  const choice = getChoice(domain);
  const keepOn = choice === "keep" ? " is-on" : "";
  const delOn = choice === "delete" ? " is-on is-delete" : "";
  const tag = choice === "delete" ? `<span class="tag-delete">미사용</span>` : "";
  return `<div class="choice-btns">
    <button type="button" class="btn-choice${keepOn}" data-choice="keep" data-domain="${escapeHtml(domain)}">사용</button>
    <button type="button" class="btn-choice${delOn}" data-choice="delete" data-domain="${escapeHtml(domain)}">미사용</button>
    ${tag}
  </div>`;
}

/**
 * 비고 — what the user needs to decide 사용/미사용, and nothing else.
 *
 * This replaced two columns, 정리 우선도 and 신뢰, which each led with our verdict (a band and a
 * score) and put the evidence under it in small text. README §3 says the product is the other way
 * round: "우리 판단을 믿으라고 하지 않고, 근거를 보여주고 사용자가 판단하게 한다". 90점 asks to be
 * trusted; 28개월 방치 + 민감한 정보 is a fact they can act on.
 *
 * The 신뢰 evidence went with its column, deliberately. This screen asks one question — do you still
 * use this — and "did we correctly find an account" is ours to worry about, not theirs. A row whose
 * only evidence is a newsletter simply has nothing worth saying here; the 사용/미사용 buttons work on
 * it exactly the same.
 *
 * Both scores are alive and unchanged behind this: they rank the list (verdict.js), gate §4, and are
 * stored beside the label so the pilot can measure itself (§8). They just stopped being screen.
 */
function remarkCell(s) {
  const out = [];
  // The two facts that override everything below them.
  if (s.likelyClosed) {
    out.push(`<span class="band band-closed">폐쇄 추정</span>`);
  } else if (s.inUse) {
    out.push(`<span class="badge-inuse">최근 사용 흔적</span>`);
  }
  // Absent for anything §4 refuses to rank: closed, not high-band, or no actionable link.
  if (s.cleanupWhy) {
    out.push(`<span class="why why-cleanup">${escapeHtml(s.cleanupWhy)}</span>`);
  }
  // Gemini's sentence, under ours, and only where ours has nothing to say. §4 ranks high-band rows
  // only, so most of this column was a dash — the row was on screen with no reason to be. This is
  // what fills that, and it stays second because a computed axis outranks an inferred sentence.
  const g = geminiByKey[s.key];
  if (g?.reason) {
    out.push(`<span class="why why-inferred">${escapeHtml(g.reason)}</span>`);
  }
  if (!out.length) return `<span class="cell-none">—</span>`;
  return out.join("");
}

/**
 * The row's buttons and the GA events speak keep/delete — §8's analytics decision names `mark_keep`
 * and `mark_delete` by those words, and renaming them would orphan the funnel we just started
 * measuring. Everything past this line speaks §3's language instead: `cleanupChoice`, which
 * cleanup.js reads for the in-use guard and verdict.js sorts by, and which /api/choices persists.
 * One map, one direction, one place — so neither vocabulary leaks into the other's half.
 */
const CHOICE_TO_SPEC = { keep: "in_use", delete: "unused" };

function withCleanupChoices(snapshot) {
  return {
    ...snapshot,
    services: (snapshot.services || []).map((s) => ({
      ...s,
      cleanupChoice: CHOICE_TO_SPEC[getChoice(s.registrableDomain)] || null,
    })),
  };
}

function withCatalog(rawSnapshot) {
  // Order is forced: verdict moves buckets and clears hiddenRule, the catalog pass reads hiddenRule
  // to decide the link and only then can score cleanup, and the sort ranks by that score. Sorting
  // any earlier ranks by a field that does not exist yet.
  //
  // The label goes on before the catalog pass, not after: computeCleanupScore reads cleanupChoice
  // for the in-use guard, so a label applied later would be a label the score never saw.
  const overridden = withCleanupChoices(applyUserVerdict(rawSnapshot, userVerdict));
  if (!catalog) return overridden;
  return sortBuckets(upgradeSnapshot(overridden, catalog));
}

// data-label carries the column header down into the cell, because on a phone the table stacks
// into cards and the <thead> is gone. Without it "2025-01" and "2" sit in a card with nothing
// saying which is the last trace and which is the message count.
function rowHtml(s, i) {
  return `<td class="cell-rank">${i + 1}</td>
      <td class="cell-service">${serviceCell(s)}</td>
      <td class="cell-remark" data-label="비고">${remarkCell(s)}</td>
      <td class="cell-month" data-label="마지막 흔적">${escapeHtml(s.lastSeenMonth || "—")}</td>
      <td class="col-count" data-label="건수">${s.messageCount}</td>
      <td class="cell-choice" data-label="내 선택">${choiceCell(s)}</td>`;
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
    tr.classList.toggle("row-mark-delete", getChoice(s.registrableDomain) === "delete");
    existing.delete(s.key);
    frag.appendChild(tr);
  });
  for (const tr of existing.values()) tr.remove();
  rows.appendChild(frag);

  playRankMoves(before);
  updateChoiceSummary(services);
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
  renderUnusedList();
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

/**
 * Everything in memory that belongs to one signed-in user, dropped in one place.
 *
 * It used to live in `refreshMe`'s logged-out branch, which the logout button does not go through —
 * it calls `setLoggedOutUI` directly. So the labels were never actually dropped on the way out; the
 * screen was cleared and the answers stayed in memory for whoever signed in next.
 */
function clearSessionState() {
  cleanupChoices = {};
  cleanupStatus = {};
  // Names inferred from a mailbox describe that mailbox, and it was not this user's.
  geminiByKey = {};
}

function setLoggedOutUI() {
  clearSessionState();
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
  // Whoever this is, they are not the last person — so clear before the new session's UI goes up,
  // rather than after their labels arrive. The old order showed the signed-in screen and then went
  // to fetch the labels, leaving the previous user's answers in memory, and rendering, for as long
  // as /api/choices took to answer.
  const mySession = ++sessionGeneration;
  clearSessionState();
  if (data.loggedIn) {
    setLoggedInUI(data);
    const loaded = await fetchChoices();
    // The same guard the scan uses, for the same reason: two refreshMe calls can be in flight (page
    // load and a login), and the slower one must not land its labels on the session that replaced it.
    if (mySession !== sessionGeneration) return data;
    cleanupChoices = loaded.choices;
    cleanupStatus = loaded.status;
  } else {
    setLoggedOutUI();
  }
  if (lastSnapshot) renderSnapshot(lastSnapshot);
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
  const choiceBtn = ev.target.closest?.("[data-choice]");
  if (choiceBtn) {
    const domain = choiceBtn.getAttribute("data-domain") || "";
    const choice = choiceBtn.getAttribute("data-choice");
    if (!domain || (choice !== "keep" && choice !== "delete")) return;
    // The row as it stands right now: setChoice stores the scores we were showing when they answered.
    const item = lastSnapshot?.services?.find(
      (s) => normalizeDomain(s.registrableDomain) === normalizeDomain(domain)
    );
    setChoice(domain, choice, item);
    track(choice === "delete" ? "mark_delete" : "mark_keep", { domain });
    if (lastSnapshot) renderSnapshot(lastSnapshot);
    return;
  }

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
  if (link.dataset.out === "cancel") {
    track("click_unsubscribe", { domain: link.dataset.domain || "" });
  }
});

unusedRows?.addEventListener("click", (ev) => {
  const link = ev.target.closest?.("a[data-out]");
  if (!link) return;
  track("outbound_click", { link: link.dataset.out, safety: link.dataset.safety });
  if (link.dataset.out === "cancel") {
    track("click_unsubscribe", { domain: link.dataset.domain || "" });
  }
});

unusedRows?.addEventListener("click", (ev) => {
  const btn = ev.target.closest?.("[data-withdraw]");
  if (!btn) return;
  const domain = btn.getAttribute("data-withdraw") || "";
  const turningOn = btn.getAttribute("data-on") !== "1";
  const name = lastSnapshot?.services?.find(
    (s) => normalizeDomain(s.registrableDomain) === normalizeDomain(domain)
  );
  const label = geminiByKey[name?.key]?.realService || name?.displayName || domain;
  // Asked, not assumed. We cannot see a withdrawal happen — §4 is explicit that only the user marks
  // this done — so the one thing we can do is make sure they meant to say it.
  const ok = turningOn
    ? window.confirm(`${label} 탈퇴를 완료하셨나요?`)
    : window.confirm(`${label} 탈퇴 완료 표시를 취소할까요?`);
  if (!ok) return;
  // setStatus re-renders on both the optimistic write and the server's answer.
  setStatus(domain, "withdrawn", turningOn);
});

tabAll?.addEventListener("click", () => setActiveTab("all"));
tabUnused?.addEventListener("click", () => setActiveTab("unused"));

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
  // Names inferred from the last mailbox describe the last mailbox. Keeping them across a scan would
  // print a brand for a sender this scan may never even see.
  geminiByKey = {};
  if (choiceSummary) choiceSummary.classList.add("hidden");
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
        // aggregator above is this scan's own local, so a stale scan may keep filling it. The line
        // below is not: scannedAccount is module state the next session inherits, which is why
        // setLoggedOutUI clears it, and a profile resolving after logout would write it back.
        // Nothing reaches it that way today — while this request is in flight the scan never
        // settles, so scanBtn stays disabled, so the next user cannot scan, so there is no row to
        // open the guide that renders this address. That is two unrelated mechanisms happening to
        // cover it, not a rule. This guard is the rule.
        if (myScan !== scanGeneration) return;
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

    // After the scan renders, never before it: the list is already complete and correct here, so
    // this is a second pass that improves names and fills the 비고 column. Awaiting it earlier would
    // make a Gemini round trip part of "did my scan work", which it is not.
    classifySenders(finalSnap.services).then((results) => {
      if (myScan !== scanGeneration) return; // a newer scan (or a logout) owns the screen now
      geminiByKey = results;
      if (lastSnapshot) renderSnapshot(lastSnapshot);
    });

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
  // And disown the session, for the same reason one layer up: a /api/choices request sent moments
  // ago is still coming, and it must not restore this user's labels onto a signed-out page.
  sessionGeneration += 1;
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

  // Empty GA_MEASUREMENT_ID disables analytics entirely. The e2e does NOT run that way: the
  // harness serves a fake id and stubs gtag.js, so the boundary in analytics.js is exercised in a
  // real browser instead of only against a fake window in the unit tests.
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
