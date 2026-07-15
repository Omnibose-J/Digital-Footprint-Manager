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

function routeBlockHtml(entry) {
  if (!entry) {
    return `<section class="guide-section">
      <h3>탈퇴 경로</h3>
      <p><strong>공식 탈퇴 경로 미확인.</strong> 이 서비스는 아직 카탈로그에서 검증하지 않았습니다. 아래 체크리스트·주의사항·요청 템플릿을 사용해 공식 경로를 직접 확인하세요.</p>
    </section>`;
  }

  const route = entry.deletion_route;
  const url = escapeHtml(entry.url || "");
  const steps = (entry.steps || [])
    .map((s) => `<li>${escapeHtml(s)}</li>`)
    .join("");
  const prereq = (entry.prerequisites || [])
    .map((s) => `<li>${escapeHtml(s)}</li>`)
    .join("");

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

  return `
    <div class="guide-header">
      <h2 id="guideTitle">${name}</h2>
      <p class="guide-meta">${domain} · ${safetyBadge(candidate, entry, stale)} · 확인일 ${verifiedAt}</p>
      ${staleNote}
    </div>
    ${routeBlockHtml(entry)}
    ${identity}
    <section class="guide-section">
      <h3>탈퇴 전 체크리스트</h3>
      <ul>${checklist}</ul>
    </section>
    <section class="guide-section">
      <h3>구분 주의</h3>
      <ul>${warnings}</ul>
    </section>
    <section class="guide-section">
      <h3>한국어 요청 템플릿</h3>
      <pre class="guide-template" id="guideTemplateText">${escapeHtml(template.fullText)}</pre>
      <button type="button" id="guideCopyBtn">템플릿 복사</button>
    </section>
  `;
}

export { CHECKLIST, WARNINGS, TEMPLATE_BODY };
