/** Classification and exclusion rule tables for the filtering module. */

export const PUBLIC_SUFFIXES = [
  "co.kr",
  "ne.kr",
  "or.kr",
  "re.kr",
  "pe.kr",
  "go.kr",
  "ac.kr",
  "hs.kr",
  "ms.kr",
  "es.kr",
  "sc.kr",
  "kg.kr",
  "mil.kr",
  "co.jp",
  "ne.jp",
  "or.jp",
  "ac.jp",
  "go.jp",
  "co.uk",
  "org.uk",
  "ac.uk",
  "com.cn",
  "net.cn",
  "org.cn",
  "com.au",
  "net.au",
  "org.au",
  "com.br",
  "com.tw",
  "co.nz",
  "co.in",
  "com.sg",
  "com.hk",
];

export const FREE_MAILBOX_DOMAINS = [
  "gmail.com",
  "googlemail.com",
  "naver.com",
  "daum.net",
  "hanmail.net",
  "kakao.com",
  "nate.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "yahoo.co.kr",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
];

export const RELAY_DOMAINS = [
  "sendgrid.net",
  "amazonses.com",
  "mailgun.org",
  "mandrillapp.com",
  "sparkpostmail.com",
  "postmarkapp.com",
  "mailjet.com",
  "mailchimpapp.net",
  "stibee.email",
  "sendy.co.kr",
];

/** Pure B2B payment processors observed in the pilot scan. Not consumer wallets (R3). */
export const PAYMENT_GATEWAY_DOMAINS = [
  "kcp.co.kr",
  "nicepay.co.kr",
  "kicc.co.kr",
  "easypay.co.kr",
  "mobilians.co.kr",
  "inicis.com",
  "tosspayments.com",
  "payple.kr",
];

export const MACHINE_LOCALPART =
  /^(no-?reply|do-?not-?reply|notification|notice|alert|auto|mailer|system|admin|info|support|help|team|hello|contact|service|cs|master)([-_.].*)?$/i;

/**
 * Order matters: the first family whose phrase hits wins, one family per message.
 *
 * signup before closure: "탈퇴 후 재가입이 완료되었습니다" is a signup, and a closure-first
 * order would read the 탈퇴 and mark a live account closed.
 * closure before transaction: "[쿠팡] 회원탈퇴 처리 완료 및 환불 안내" is a closure, but
 * transaction owns 환불 and used to steal it, which cost the candidate its likely_closed badge.
 * notification last: it is the weakest family, so every other reading gets first refusal.
 *
 * Signup entries carry the score tier (verification=55 / welcome=40).
 * Other families remain plain phrase strings.
 * @type {Record<string, Array<string|{phrase: string, tier: 'verification'|'welcome'}>>}
 */
export const SUBJECT_RULES = {
  signup: [
    // Every phrase here needs an anchor (조사, or 회원). A bare "가입 완료" would read
    // "가입 완료 시 5,000원 지급" — a signup ad, not a signup — as 40 points. Family assignment
    // is lenient in this product, but signup is a strong signal and strong signals stay strict.
    { phrase: "가입이 완료", tier: "welcome" },
    { phrase: "회원가입 완료", tier: "welcome" },
    { phrase: "회원가입이 완료", tier: "welcome" },
    { phrase: "회원가입을 환영", tier: "welcome" },
    { phrase: "가입을 축하", tier: "welcome" },
    { phrase: "가입해 주셔서 감사", tier: "welcome" },
    // Must stay narrow. A bare "인증이 완료" also swallows 본인인증/계좌인증/휴대폰인증,
    // which guest checkout issues without an account, and each one minted a 55-point candidate.
    { phrase: "이메일 인증이 완료", tier: "verification" },
    { phrase: "이메일 주소 인증", tier: "verification" },
    { phrase: "이메일이 인증", tier: "verification" },
    { phrase: "계정이 생성", tier: "welcome" },
    { phrase: "welcome to", tier: "welcome" },
    { phrase: "verify your email", tier: "verification" },
    { phrase: "confirm your email", tier: "verification" },
    { phrase: "activate your account", tier: "verification" },
    { phrase: "your account has been created", tier: "welcome" },
  ],
  closure: [
    "탈퇴가 완료",
    "탈퇴 완료",
    "탈퇴 처리",
    "탈퇴가 정상적으로",
    "탈퇴 신청이 접수",
    "탈퇴 신청이 완료",
    "계정이 삭제",
    "계정 삭제가 완료",
    "account has been deleted",
    "account closed",
    "account deletion complete",
  ],
  auth: [
    "비밀번호 재설정",
    "비밀번호를 변경",
    "비밀번호가 변경",
    "비밀번호 변경 안내",
    "임시 비밀번호",
    "비밀번호 찾기",
    "로그인 알림",
    "새로운 기기에서 로그인",
    "인증번호",
    "일회용 비밀번호",
    "2단계 인증",
    "password reset",
    "reset your password",
    "new sign-in",
    "verification code",
    "security alert",
    "two-factor",
  ],
  transaction: [
    "결제가 완료",
    "결제 완료",
    "주문이 완료",
    "주문 완료",
    "주문 확인",
    "영수증",
    "배송이 시작",
    "배송 완료",
    "배송이 완료",
    "예약이 완료",
    "예약 완료",
    "환불",
    "정기 결제",
    "구독이 갱신",
    "receipt",
    "invoice",
    "your order",
    "payment",
    "subscription renew",
    "has shipped",
    "refund",
  ],
  // Korean law forces these onto REGISTERED MEMBERS only, so they are near-proof of an account.
  // The score table has no slot for that: they land in notification and cap at 15 (low band).
  // Filed rather than fixed here — raising the cap is a §3 scoring change, not a classifier one.
  notification: [
    "휴면계정",
    "휴면 계정",
    "휴면회원",
    "장기 미접속",
    "개인정보 분리보관",
    "개인정보 유효기간",
    "개인정보 이용내역",
    "이용약관 개정",
    "약관 변경",
    "개인정보처리방침 변경",
    "서비스 점검",
  ],
};

/**
 * Marketing is a WEIGHTED judgment, never a binary switch (SPEC §3).
 * Google mandates one-click unsubscribe only for marketing senders above 5,000/day, does not
 * forbid transactional senders from carrying it, and leaves the marketing/transactional call to
 * recipients [S25][S26] — so no single header is proof, and receipts routinely carry
 * List-Unsubscribe. Reaching the threshold takes corroboration.
 */
export const MARKETING_HEADER_WEIGHTS = {
  listId: 2,
  precedenceBulk: 2,
  listUnsubscribePost: 1,
  listUnsubscribe: 1,
};

/** Weight needed to call a message marketing. Below it, §3 says do not. */
export const MARKETING_HEADER_THRESHOLD = 3;

// Gmail system label IDs. PERSONAL is deliberately absent: it is the "no category" bucket.
export const CATEGORY_PROMOTIONS = "CATEGORY_PROMOTIONS";
export const CATEGORY_UPDATES = "CATEGORY_UPDATES";
export const CATEGORY_SOCIAL = "CATEGORY_SOCIAL";
export const CATEGORY_FORUMS = "CATEGORY_FORUMS";
/**
 * NOT a Gmail system label — purchases/reservations exist only as `q=category:purchases`
 * search operators, so this never appears in labelIds and the branch reading it is very
 * likely dead. SPEC §3 [S2] left exactly this unverified. Kept because it costs nothing and
 * is correct if Gmail ever promotes it; confirm against a real scan before relying on it.
 */
export const CATEGORY_PURCHASES = "CATEGORY_PURCHASES";

export const defaultRules = {
  PUBLIC_SUFFIXES,
  FREE_MAILBOX_DOMAINS,
  RELAY_DOMAINS,
  PAYMENT_GATEWAY_DOMAINS,
  MACHINE_LOCALPART,
  SUBJECT_RULES,
  MARKETING_HEADER_WEIGHTS,
  MARKETING_HEADER_THRESHOLD,
  CATEGORY_PURCHASES,
  CATEGORY_PROMOTIONS,
  CATEGORY_UPDATES,
  CATEGORY_SOCIAL,
  CATEGORY_FORUMS,
};
