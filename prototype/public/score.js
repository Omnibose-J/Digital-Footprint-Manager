/**
 * discoveryScore + bands (PRODUCT_SPEC §3 / SOW 004 R3–R5).
 * Counting is by distinct month. No time decay (R4). notification cap stays 15 (F5/G1).
 */

/** Phrases that count as verification-complete (55). Matched against classifyMessage matchedRules. */
export const SIGNUP_VERIFICATION_PHRASES = [
  "이메일 인증이 완료",
  "인증이 완료",
  "verify your email",
  "confirm your email",
  "activate your account",
];

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
 * @param {string[]} matchedRules from classifyMessage
 * @returns {'verification'|'welcome'|null}
 */
export function signupTierFromMatchedRules(matchedRules = []) {
  for (const rule of matchedRules) {
    if (!String(rule).startsWith("subject:signup:")) continue;
    const phrase = String(rule).slice("subject:signup:".length);
    const needle = phrase.toLowerCase();
    for (const v of SIGNUP_VERIFICATION_PHRASES) {
      if (needle.includes(v.toLowerCase()) || v.toLowerCase().includes(needle)) {
        // Exact: the matched phrase IS a verification phrase
        if (SIGNUP_VERIFICATION_PHRASES.some((p) => p.toLowerCase() === needle)) {
          return "verification";
        }
      }
    }
    if (SIGNUP_VERIFICATION_PHRASES.some((p) => p.toLowerCase() === needle)) {
      return "verification";
    }
    return "welcome";
  }
  return null;
}

/** Cleaner tier helper used by filter.js */
export function signupTierFromPhrase(phrase) {
  const needle = String(phrase || "").toLowerCase();
  if (!needle) return "welcome";
  for (const v of SIGNUP_VERIFICATION_PHRASES) {
    if (needle === v.toLowerCase()) return "verification";
  }
  return "welcome";
}

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
    contributions.push({ family: "signup", key: "signup_verification", points: 55, labelKo: FAMILY_LABEL_KO.signup_verification });
  } else if (signupWelcomeMonths.length > 0) {
    familyScores.signup = 40;
    contributions.push({ family: "signup", key: "signup_welcome", points: 40, labelKo: FAMILY_LABEL_KO.signup_welcome });
  }

  // Auth: 35 first month, +10 second; cap 45.
  if (authMonths.length >= 1) {
    familyScores.auth = authMonths.length >= 2 ? 45 : 35;
    contributions.push({ family: "auth", key: "auth", points: familyScores.auth, labelKo: FAMILY_LABEL_KO.auth });
  }

  // Transaction: 10 per month; ≥3 distinct months → recurring floor 25 (worked example);
  // cap 30. The §3 example is 25+15=40 review — use the floor as the recurring score.
  if (transactionMonths.length > 0) {
    let tx = 10 * transactionMonths.length;
    if (transactionMonths.length >= 3) tx = 25;
    familyScores.transaction = Math.min(30, tx);
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
    topContributors: topTwo,
    scoreExplanation,
  };
}

export function bandForScore(score) {
  const n = Number(score) || 0;
  if (n >= 70) return "high";
  if (n >= 40) return "review";
  return "low";
}

/**
 * Closure newer than latest positive evidence → likely_closed (R5).
 * Positive = signup, auth, transaction, notification, unknown (not marketing, not closure).
 */
export function computeLikelyClosed(families = {}) {
  const closureMonths = families.closure?.months || [];
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
