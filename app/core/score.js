/**
 * discoveryScore + bands (PRODUCT_SPEC §3 / SOW 004 R3–R5).
 * Counting is by distinct month. No time decay (R4). notification cap stays 15 (F5/G1).
 */

const FAMILY_LABEL_KO = {
  signup: "가입·인증",
  signup_verification: "이메일 인증 완료",
  signup_welcome: "가입 완료",
  auth: "비밀번호 재설정",
  transaction: "거래",
  notification: "알림",
  marketing: "마케팅",
  closure: "탈퇴",
  unknown: "미분류",
};

/**
 * Score authenticated evidence only. Months are distinct YYYY-MM strings.
 *
 * @param {{
 *   signupVerificationMonths?: string[],
 *   signupWelcomeMonths?: string[],
 *   authMonths?: string[],
 *   transactionMonths?: string[],
 *   notificationMonths?: string[],
 *   hasMarketing?: boolean,
 * }} evidence
 */
export function computeDiscoveryScore(evidence = {}) {
  const signupVerificationMonths = uniqueMonths(evidence.signupVerificationMonths);
  const signupWelcomeMonths = uniqueMonths(evidence.signupWelcomeMonths);
  const authMonths = uniqueMonths(evidence.authMonths);
  const transactionMonths = uniqueMonths(evidence.transactionMonths);
  const notificationMonths = uniqueMonths(evidence.notificationMonths);
  const hasMarketing = Boolean(evidence.hasMarketing);

  const familyScores = {
    signup: 0,
    auth: 0,
    transaction: 0,
    notification: 0,
    marketing: 0,
    unknown: 0,
    closure: 0,
  };

  const contributions = [];

  // Signup: verification 55 XOR welcome 40; cap 55 (do not sum).
  if (signupVerificationMonths.length > 0) {
    familyScores.signup = 55;
    contributions.push({
      family: "signup",
      key: "signup_verification",
      points: 55,
      labelKo: FAMILY_LABEL_KO.signup_verification,
    });
  } else if (signupWelcomeMonths.length > 0) {
    familyScores.signup = 40;
    contributions.push({
      family: "signup",
      key: "signup_welcome",
      points: 40,
      labelKo: FAMILY_LABEL_KO.signup_welcome,
    });
  }

  // Auth: 35 first distinct month, +10 each additional; cap 55.
  //
  // The old rule was `length >= 2 ? 45 : 35`, which threw the month count away: two months and
  // twenty months both scored 45. With the cap at 45 that also put a ceiling under the family,
  // so no quantity of password-reset evidence over any span could reach high. The table was
  // asserting that a password reset never makes us confident an account exists, and that is
  // backwards. The service honoured the reset, which is the service itself confirming the account
  // is there and that this user holds it: the most conclusive signal we get, and unlike a signup
  // mail it is still arriving for accounts older than the mailbox.
  //
  // 55 keeps auth alone below high on purpose. An OTP can reach someone with no account (guest
  // checkout, phone verification), so auth still needs corroboration to clear 70. What it no
  // longer needs is a signup mail that no longer exists.
  if (authMonths.length >= 1) {
    familyScores.auth = Math.min(55, 35 + 10 * (authMonths.length - 1));
    contributions.push({
      family: "auth",
      key: "auth",
      points: familyScores.auth,
      labelKo: FAMILY_LABEL_KO.auth,
    });
  }

  // Transaction: 10 per distinct month, cap 30 — the §3 table, not the worked example.
  //
  // The two contradict each other and only one can hold. The table's "recurring renewals in
  // >= 3 distinct months floor the family at 25" is already inoperative as written: 3 months
  // scores 30 on its own, so a floor of 25 can never bind. Taking the example's 25 as a ceiling
  // instead (what this used to do) made the table's own cap of 30 unreachable and left
  // transaction ∈ {0,10,20,25}, which cost "welcome + receipts in 4 distinct months" its high
  // band at 65. Following the table costs the example its arithmetic but not its conclusion:
  // 30 + notifications 15 = 45 is still review, still "correctly not high", and transaction
  // still cannot reach high without signup or auth (30 + 15 + marketing 5 = 50).
  if (transactionMonths.length > 0) {
    familyScores.transaction = Math.min(30, 10 * transactionMonths.length);
    contributions.push({
      family: "transaction",
      key: "transaction",
      points: familyScores.transaction,
      labelKo: FAMILY_LABEL_KO.transaction,
    });
  }

  // Notification: 5 per month; cap 15 — do not raise (F5/G1).
  if (notificationMonths.length > 0) {
    familyScores.notification = Math.min(15, 5 * notificationMonths.length);
    contributions.push({
      family: "notification",
      key: "notification",
      points: familyScores.notification,
      labelKo: FAMILY_LABEL_KO.notification,
    });
  }

  // Marketing: flat 5.
  if (hasMarketing) {
    familyScores.marketing = 5;
    contributions.push({
      family: "marketing",
      key: "marketing",
      points: 5,
      labelKo: FAMILY_LABEL_KO.marketing,
    });
  }

  const discoveryScore = Math.min(
    100,
    familyScores.signup +
      familyScores.auth +
      familyScores.transaction +
      familyScores.notification +
      familyScores.marketing
  );

  const discoveryBand = bandForScore(discoveryScore);
  contributions.sort((a, b) => b.points - a.points);
  const topTwo = contributions.filter((c) => c.points > 0).slice(0, 2);
  const scoreExplanation = formatExplanation(discoveryScore, topTwo);

  return {
    discoveryScore,
    discoveryBand,
    familyScores,
    scoreExplanation,
  };
}

function bandForScore(score) {
  const n = Number(score) || 0;
  if (n >= 70) return "high";
  if (n >= 40) return "review";
  return "low";
}

/**
 * Closure newer than latest positive evidence → likely_closed (R5).
 * Positive = signup, auth, transaction, notification, unknown (not marketing, not closure).
 *
 * Closure months arrive already gated, separately from `families`. §3 binds the authenticity rule
 * to evidence and names closure mail negative evidence, so it binds here too: one spoofed
 * withdrawal mail must not close a real account, which §4 then drops from the cleanup list
 * entirely. `families.closure` still carries every closure mail because unauthenticated evidence
 * keeps counting for recency (R2/G2) — the gate narrows the conclusion, not the record.
 *
 * Positive months stay ungated deliberately. Widening what reads as "still alive" can only keep a
 * candidate on the list, never hide one, so an unauthenticated positive fails in the safe
 * direction; an unauthenticated closure does not.
 */
export function computeLikelyClosed(families = {}, authenticatedClosureMonths) {
  // No default: a caller that forgets the gated months should throw here, not quietly get "no
  // closure ever". The safe direction is not a reason to let the ungated path be reachable.
  const closureMonths = authenticatedClosureMonths;
  if (!closureMonths.length) return false;
  const latestClosure = maxMonth(closureMonths);
  if (!latestClosure) return false;

  const positive = ["signup", "auth", "transaction", "notification", "unknown"];
  let latestPositive = null;
  for (const f of positive) {
    for (const m of families[f]?.months || []) {
      if (!latestPositive || m > latestPositive) latestPositive = m;
    }
  }
  if (!latestPositive) return true;
  return latestClosure > latestPositive;
}

function uniqueMonths(list) {
  return [...new Set((list || []).filter(Boolean))].sort();
}

function maxMonth(months) {
  let best = null;
  for (const m of months || []) {
    if (!best || m > best) best = m;
  }
  return best;
}

function formatExplanation(score, topTwo) {
  if (!topTwo.length) return `${score}점`;
  const names = topTwo.map((c) => c.labelKo).join(" + ");
  return `${score}점 · ${names}`;
}
