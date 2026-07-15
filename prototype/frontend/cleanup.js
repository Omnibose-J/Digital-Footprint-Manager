/**
 * cleanupScore: what to tackle first (PRODUCT_SPEC §4).
 *
 * A different question from discoveryScore, which asks whether the account exists at all. This one
 * assumes it does and asks whether it is worth removing. Keeping them apart is the point: a row can
 * be certainly yours and not worth touching (the mail client you are reading this in), or barely
 * evidenced and obviously junk.
 *
 * Every axis reads data the MVP already produces. v1's formula was cut because its two heaviest
 * axes needed breach data we have no source for; nothing here is dead, and breach association comes
 * back later as a badge beside the score, never as points inside it, so the number keeps meaning
 * the same thing when the data sources change.
 */

const AXIS_LABEL_KO = {
  dormancy: "방치",
  sensitivity: "민감한 정보",
  payment: "결제 정보 저장 가능성",
  readiness: "탈퇴 경로 확인됨",
};

/** §4: catalog category decides how much is parked there. */
const SENSITIVITY = {
  finance: 30,
  health: 30,
  identity: 30,
  cloud: 30,
  email: 30,
  shopping: 20,
  productivity: 15,
  social: 15,
  community: 8,
  other: 8,
};

/** §4: how much work leaving actually is. */
const READINESS = {
  self_service: 15,
  contact_form: 8,
  email_request: 8,
  public_service: 5,
  unavailable: 0,
};

/** Whole months from a YYYY-MM to now. Null month means no non-marketing evidence ever. */
export function monthsSince(month, now = new Date()) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ""));
  if (!m) return null;
  const then = Number(m[1]) * 12 + (Number(m[2]) - 1);
  const today = now.getUTCFullYear() * 12 + now.getUTCMonth();
  return Math.max(0, today - then);
}

/**
 * Dormancy, the heaviest axis and the least trustworthy input we have.
 *
 * §3 is explicit that email recency is a weak proxy for use, and its bias runs the wrong way: a
 * service used daily that sends no mail looks abandoned. That is why the ceiling is 40 rather than
 * enough to reach `recommended` alone, and why the in-use guard exists below.
 */
function dormancyPoints(lastSeenMonth, now) {
  const age = monthsSince(lastSeenMonth, now);
  // No non-marketing evidence at all. Not the same as old evidence: we know nothing, so this sits
  // between "12-24 months" and "24-36" rather than topping the axis out.
  if (age === null) return 25;
  if (age > 36) return 40;
  if (age >= 24) return 30;
  if (age >= 12) return 18;
  return 0;
}

function paymentPoints(transactionMonths) {
  const n = new Set((transactionMonths || []).filter(Boolean)).size;
  if (n >= 2) return 15;
  if (n === 1) return 8;
  return 0;
}

/**
 * Readiness counts only for a route we verified. An inferred https://domain guess is not a route,
 * and paying points for it would rank a service higher for the accident of having a guessable URL.
 */
function readinessPoints(entry, linkSafety) {
  if (!entry || linkSafety !== "verified") return 0;
  return READINESS[entry.deletion_route] ?? 0;
}

export function bandForCleanup(score) {
  const n = Number(score) || 0;
  if (n >= 60) return "recommended";
  if (n >= 30) return "review";
  return "keep_or_watch";
}

/**
 * §4 in-use guard. Recent mail, or a charge in the last two months, blocks `recommended` outright.
 *
 * A floor, not the whole defence. It cannot see a mail-silent service the user relies on, which is
 * why nothing reaches the deletion guide without the user deciding, and why the badge says 흔적
 * (a trace) rather than claiming use.
 */
export function inUseSignal(candidate, now = new Date()) {
  const age = monthsSince(candidate?.lastSeenMonth, now);
  if (age !== null && age < 3) return true;
  const charges = candidate?.families?.transaction?.months || [];
  return charges.some((m) => {
    const a = monthsSince(m, now);
    return a !== null && a < 2;
  });
}

/**
 * @param {any} candidate an upgraded ServiceCandidate (post-catalog)
 * @param {Date} [now]
 * @returns {{ cleanupScore: number|null, cleanupBand: string|null, inUse: boolean,
 *   cleanupWhy: string, axes: Record<string, number> } }
 */
export function computeCleanupScore(candidate, now = new Date()) {
  // §4: closed accounts are out entirely. Ordering a withdrawal you already completed is noise at
  // best and a wrong instruction at worst.
  if (!candidate || candidate.likelyClosed) {
    return { cleanupScore: null, cleanupBand: null, inUse: false, cleanupWhy: "", axes: {} };
  }
  // §4 scopes this to candidates we are confident about. Ranking "delete this first" above a row
  // we are not sure is even an account inverts the product: the user acts from the top down.
  if (candidate.discoveryBand !== "high") {
    return { cleanupScore: null, cleanupBand: null, inUse: false, cleanupWhy: "", axes: {} };
  }

  const entry = candidate.catalogEntry || null;
  const axes = {
    dormancy: dormancyPoints(candidate.lastSeenMonth, now),
    sensitivity: entry ? SENSITIVITY[entry.category] ?? 8 : 8,
    payment: paymentPoints(candidate.families?.transaction?.months),
    readiness: readinessPoints(entry, candidate.linkSafety),
  };

  const cleanupScore = Math.min(
    100,
    axes.dormancy + axes.sensitivity + axes.payment + axes.readiness
  );
  const inUse = inUseSignal(candidate, now);
  let cleanupBand = bandForCleanup(cleanupScore);
  // The guard demotes rather than rescores, so the number still explains itself and only the verdict
  // changes. A score that silently dropped would make the explanation below a lie.
  if (inUse && cleanupBand === "recommended") cleanupBand = "review";

  return { cleanupScore, cleanupBand, inUse, cleanupWhy: explain(axes, candidate, now), axes };
}

/** §4: name the top two axes in plain Korean, e.g. "30개월 방치 + 결제 정보 저장 가능성". */
function explain(axes, candidate, now) {
  const parts = Object.entries(axes)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([k]) => {
      if (k !== "dormancy") return AXIS_LABEL_KO[k];
      const age = monthsSince(candidate.lastSeenMonth, now);
      return age === null ? "메일 흔적 없음" : `${age}개월 방치`;
    });
  return parts.join(" + ");
}

export { SENSITIVITY, READINESS, AXIS_LABEL_KO };
