/** Deletion guide modal: route blocks, checklist, warnings, Korean template. */

import { escapeHtml } from "./html.js";

const CHECKLIST = [
  "진행 중인 구독·정기결제·예약·환불",
  "포인트·쿠폰·잔액·적립금",
  "내보낼 데이터 (주문내역, 게시글, 사진, 파일)",
  "소유권 이전 (팀, 채널, 가족, 상점)",
  "SSO·복구 이메일 의존성",
];

const WARNINGS = [
  "소셜 로그인 연결 해제는 탈퇴가 아닙니다. 로그인 경로만 끊길 뿐 계정과 데이터는 그대로 남습니다. 카카오 공식 문서도 연결 끊기 ≠ 회원탈퇴라고 명시합니다.",
  "앱을 지워도 계정은 삭제되지 않습니다.",
  "마케팅 수신거부는 계정 폐쇄가 아닙니다.",
  "비활성화가 곧 삭제는 아닙니다.",
  "탈퇴 후에도 법령상 보존이 필요한 기록은 남을 수 있습니다.",
];

const TEMPLATE_BODY = [
  "안녕하세요. 본 메일 주소와 연결된 계정의 회원탈퇴 및 개인정보 삭제를 요청합니다.",
  "법령상 보존이 필요한 정보가 있다면 보존 항목·근거·기간과 나머지 정보의 삭제 예정일을 알려주세요.",
  "본인확인이 필요하면 비밀번호나 신분증을 일반 이메일로 요구하지 말고 공식 보안 절차를 안내해 주세요.",
  "처리 결과는 이 메일로 회신 부탁드립니다.",
].join("\n");

/**
 * A link into the user's own Gmail, pre-searched for this sender (§8).
 *
 * This is the whole answer to "where do I delete the mail". Deleting it from here would need
 * gmail.modify, whose narrowest form also grants send-as-the-user, and no trash-only scope exists.
 * So the product does what it does everywhere else: prepares, routes, explains, and lets the user
 * act on the official surface. No new scope, nothing irreversible done by us, and Gmail's own
 * delete UI is a better confirmation step than one we could build, with a 30-day trash behind it.
 *
 * `u/{email}` rather than `u/0`, because `u/0` is a positional index and opens whichever account
 * the browser happens to have first. §8 asked for that to be verified before shipping; the address
 * used is the one the scan actually read (users/me/profile), not the product session, so a
 * multi-account user lands in the mailbox these results came from.
 *
 * @param {string} account the scanned Gmail address
 * @param {string} domain registrable domain of the sender
 * @returns {string|null} null when there is nothing safe to search for
 */
export function gmailSearchUrl(account, domain) {
  const acct = String(account || "").trim();
  const dom = String(domain || "").trim().toLowerCase();
  if (!acct.includes("@") || !dom.includes(".")) return null;
  return `https://mail.google.com/mail/u/${encodeURIComponent(acct)}/#search/${encodeURIComponent(
    `from:${dom}`
  )}`;
}

/**
 * Mask local-part keeping first two chars when long enough: so****@gmail.com
 * @param {string} email
 */
export function maskAccount(email) {
  const raw = String(email || "").trim();
  const at = raw.indexOf("@");
  if (at <= 0) return raw || "(계정 미상)";
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}****@${domain}`;
}

/**
 * Interpolate only {서비스명} and {마스킹된 계정} (E6).
 * @param {{ serviceName: string, maskedAccount: string }} opts
 */
export function renderRequestTemplate({ serviceName, maskedAccount }) {
  const name = String(serviceName || "").trim() || "(서비스명)";
  const account = String(maskedAccount || "").trim() || "(마스킹된 계정)";
  const subject = `[회원탈퇴 및 개인정보 삭제 요청] ${name} / ${account}`;
  const body = TEMPLATE_BODY;
  return { subject, body, fullText: `제목: ${subject}\n\n${body}` };
}

function safetyBadge(candidate, entry, stale) {
  if (entry && candidate.linkSafety === "verified") {
    return stale
      ? `<span class="guide-badge guide-badge-stale">검토 필요</span>`
      : `<span class="guide-badge guide-badge-verified">verified</span>`;
  }
  if (candidate.linkSafety === "inferred") {
    return `<span class="guide-badge guide-badge-inferred">inferred</span>`;
  }
  return `<span class="guide-badge guide-badge-unchecked">공식 탈퇴 경로 미확인</span>`;
}

/**
 * The service-specific warnings, on their own and first.
 *
 * These used to sit inside the route block, below the steps, in the same bullet style as the five
 * generic reminders that follow every service. So "토스머니 잔액이 0원이어야 합니다" and "앱을
 * 지워도 계정은 삭제되지 않습니다" looked identical, and one of them was read against 토스's own
 * documentation this week while the other is true of everything. This is the single most useful
 * thing the catalog knows, and it belongs above the button, not under it.
 */
function prereqBlockHtml(entry) {
  const items = entry?.prerequisites || [];
  if (!items.length) return "";
  return `<section class="guide-section guide-prereq">
      <h3>먼저 확인하세요</h3>
      <ul>${items.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>
    </section>`;
}

function routeBlockHtml(entry) {
  if (!entry) {
    return `<section class="guide-section">
      <h3>탈퇴 경로</h3>
      <p><strong>공식 탈퇴 경로 미확인.</strong> 이 서비스는 아직 확인하지 못했습니다. 아래 일반 체크리스트와 요청 템플릿으로 공식 경로를 직접 찾아 진행하세요.</p>
    </section>`;
  }

  const route = entry.deletion_route;
  const url = escapeHtml(entry.url || "");
  const steps = (entry.steps || [])
    .map((s) => `<li>${escapeHtml(s)}</li>`)
    .join("");
  // Prerequisites now render above, in their own block. Kept empty here so the branches below
  // that still interpolate it stay honest rather than duplicating the section.
  const prereq = "";

  if (route === "unavailable") {
    return `<section class="guide-section">
      <h3>탈퇴 경로: 공식 경로 없음(검증됨)</h3>
      <p>${escapeHtml(entry.grace_period || "공식 자가 탈퇴 경로가 확인되지 않았습니다.")}</p>
      <p>안전한 대안: 데이터 최소화, 계정 비활성화(가능한 경우), 공식 고객지원 에스컬레이션.</p>
      ${prereq ? `<ul>${prereq}</ul>` : ""}
      ${entry.official_source_url ? `<p>근거: <a href="${escapeHtml(entry.official_source_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(entry.official_source_url)}</a></p>` : ""}
    </section>`;
  }

  if (route === "public_service") {
    return `<section class="guide-section">
      <h3>탈퇴 경로: 정보주체 권리행사</h3>
      <p>한국 공공 레일(privacy.go.kr)로 본인확인 이력이 있는 사이트 탈퇴를 신청합니다. eprivacy.go.kr를 진입점으로 쓰지 마세요.</p>
      <p><a href="${url}" target="_blank" rel="noopener noreferrer">웹사이트 회원 탈퇴 신청</a></p>
      ${steps ? `<ol>${steps}</ol>` : ""}
      ${prereq ? `<p>자격·제한</p><ul>${prereq}</ul>` : ""}
    </section>`;
  }

  if (route === "email_request") {
    return `<section class="guide-section">
      <h3>탈퇴 경로: 이메일 요청</h3>
      <p>아래 한국어 템플릿을 검토한 뒤 본인 메일 클라이언트에서 발송하세요. 자동 발송하지 않습니다.</p>
      ${entry.url ? `<p>안내: <a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a></p>` : ""}
      ${prereq ? `<ul>${prereq}</ul>` : ""}
    </section>`;
  }

  if (route === "contact_form") {
    return `<section class="guide-section">
      <h3>탈퇴 경로: 공식 양식</h3>
      <p><a href="${url}" target="_blank" rel="noopener noreferrer">공식 문의/신청 양식</a></p>
      ${prereq ? `<p>준비 사항</p><ul>${prereq}</ul>` : ""}
      ${steps ? `<ol>${steps}</ol>` : ""}
    </section>`;
  }

  // self_service default
  return `<section class="guide-section">
    <h3>탈퇴 경로: 자가 탈퇴</h3>
    <p><a href="${url}" target="_blank" rel="noopener noreferrer">공식 탈퇴/삭제 페이지</a></p>
    ${entry.grace_period ? `<p>유예: ${escapeHtml(entry.grace_period)}</p>` : ""}
    ${steps ? `<ol>${steps}</ol>` : ""}
    ${prereq ? `<p>사전 조건</p><ul>${prereq}</ul>` : ""}
  </section>`;
}

/**
 * Build modal inner HTML for a candidate.
 * @param {{ candidate: any, entry: any|null, stale: boolean, serviceName: string, maskedAccount: string }} opts
 */
export function renderGuideHtml({
  candidate,
  entry,
  stale,
  serviceName,
  maskedAccount,
  scannedAccount,
}) {
  const name = escapeHtml(serviceName || candidate.displayName || "");
  const domain = escapeHtml(candidate.registrableDomain || "");
  const verifiedAt = entry?.last_verified_at
    ? escapeHtml(entry.last_verified_at)
    : "—";
  const template = renderRequestTemplate({ serviceName, maskedAccount });

  const checklist = CHECKLIST.map((c) => `<li>${escapeHtml(c)}</li>`).join("");
  const warnings = WARNINGS.map((w) => `<li>${escapeHtml(w)}</li>`).join("");

  // Route-independent, so it sits outside routeBlockHtml's five branches rather than being
  // repeated in each. The catalog has carried this field since the seed entries and nothing
  // ever rendered it: what you must prove to close an account is worth knowing before you start.
  const identity = entry?.identity_verification
    ? `<section class="guide-section">
      <h3>본인확인</h3>
      <p>${escapeHtml(entry.identity_verification)}</p>
    </section>`
    : "";

  const staleNote =
    stale && entry
      ? `<p class="guide-stale-note">이 안내의 검토 기한이 지났습니다 (last_verified_at: ${verifiedAt}). 링크는 보여 드리지만 최신으로 단정하지 마세요.</p>`
      : "";

  // The template is the whole point of an email_request route and a footnote everywhere else, so it
  // only opens by default where sending it IS the withdrawal.
  const templateIsTheRoute = entry?.deletion_route === "email_request" || !entry;

  // Only for a real service domain. A rescued free-mailbox sender keys on gmail.com, and
  // "from:gmail.com" would hand the user a search matching most of their inbox and an invitation
  // to delete it. linkBlockedBy is already the fence that says the domain is not the service.
  const mailUrl = candidate?.linkBlockedBy
    ? null
    : gmailSearchUrl(scannedAccount, candidate?.registrableDomain);
  const mailBlock = mailUrl
    ? `<section class="guide-section">
      <h3>탈퇴한 뒤 남은 메일</h3>
      <p class="note">저희는 메일을 지울 수 없습니다. 지우려면 Google이 "이 앱이 회원님 이름으로 메일을 보낼 수 있도록 허용"까지 함께 요구하고, 휴지통 전용 권한은 존재하지 않습니다. 대신 본인 Gmail에서 이 발신자만 검색된 상태로 열어 드립니다.</p>
      <p><a class="btn btn-quiet" href="${escapeHtml(mailUrl)}" target="_blank" rel="noopener noreferrer">Gmail에서 이 발신자 메일 보기</a></p>
      <p class="note">탈퇴 확인 메일까지 지우면 재스캔했을 때 이 계정을 정리했다는 사실이 남지 않습니다.</p>
    </section>`
    : "";

  return `
    <div class="guide-header">
      <h2 id="guideTitle">${name}</h2>
      <p class="guide-meta">${domain} · ${safetyBadge(candidate, entry, stale)} · 확인일 ${verifiedAt}</p>
      ${staleNote}
    </div>
    ${prereqBlockHtml(entry)}
    ${routeBlockHtml(entry)}
    ${identity}
    ${mailBlock}
    <details class="guide-fold"${templateIsTheRoute ? " open" : ""}>
      <summary>개인정보 삭제 요청문 (복사해서 보내세요)</summary>
      <pre class="guide-template" id="guideTemplateText">${escapeHtml(template.fullText)}</pre>
      <button type="button" id="guideCopyBtn" class="btn btn-quiet">템플릿 복사</button>
    </details>
    <details class="guide-fold">
      <summary>모든 서비스에 해당하는 일반 안내</summary>
      <h4>탈퇴 전 확인할 것</h4>
      <ul>${checklist}</ul>
      <h4>이건 탈퇴가 아닙니다</h4>
      <ul>${warnings}</ul>
    </details>
  `;
}

export { CHECKLIST, WARNINGS, TEMPLATE_BODY };
