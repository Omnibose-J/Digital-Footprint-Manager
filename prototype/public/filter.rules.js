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
 * Signup entries carry the score tier (verification=55 / welcome=40).
 * Other families remain plain phrase strings.
 * @type {Record<string, Array<string|{phrase: string, tier: 'verification'|'welcome'}>>}
 */
export const SUBJECT_RULES = {
  signup: [
    { phrase: "가입이 완료", tier: "welcome" },
    { phrase: "회원가입이 완료", tier: "welcome" },
    { phrase: "회원가입을 환영", tier: "welcome" },
    { phrase: "가입해 주셔서 감사", tier: "welcome" },
    { phrase: "이메일 인증이 완료", tier: "verification" },
    { phrase: "인증이 완료", tier: "verification" },
    { phrase: "계정이 생성", tier: "welcome" },
    { phrase: "welcome to", tier: "welcome" },
    { phrase: "verify your email", tier: "verification" },
    { phrase: "confirm your email", tier: "verification" },
    { phrase: "activate your account", tier: "verification" },
    { phrase: "your account has been created", tier: "welcome" },
  ],
  auth: [
    "비밀번호 재설정",
    "비밀번호를 변경",
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
    "주문이 완료",
    "주문 확인",
    "영수증",
    "배송이 시작",
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
  closure: [
    "회원탈퇴가 완료",
    "탈퇴 처리",
    "계정이 삭제",
    "account has been deleted",
    "account closed",
  ],
};

export const CATEGORY_PURCHASES = "CATEGORY_PURCHASES";
export const CATEGORY_PROMOTIONS = "CATEGORY_PROMOTIONS";
export const CATEGORY_UPDATES = "CATEGORY_UPDATES";

export const defaultRules = {
  PUBLIC_SUFFIXES,
  FREE_MAILBOX_DOMAINS,
  RELAY_DOMAINS,
  PAYMENT_GATEWAY_DOMAINS,
  MACHINE_LOCALPART,
  SUBJECT_RULES,
  CATEGORY_PURCHASES,
  CATEGORY_PROMOTIONS,
  CATEGORY_UPDATES,
};
