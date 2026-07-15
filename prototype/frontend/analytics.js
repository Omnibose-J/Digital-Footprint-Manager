/**
 * Google Analytics, with a boundary.
 *
 * THE RULE: nothing derived from the user's mailbox may leave this file's callers. Not a domain,
 * not a service name, not a sender address, not a count of what they have. The screen next to this
 * one promises "메일이 서버로 가지 않습니다", and shipping "탈퇴 안내 clicked · coupang.com" to
 * Google Analytics would break that promise more quietly than sending the mail itself, because
 * the account list is the thing the mail was only ever evidence for.
 *
 * So the events below carry shape, never content: that a guide was opened, not whose. Counts and
 * durations are fine (they describe our product); identifiers are not (they describe the user).
 * If a new event needs a mailbox-derived parameter to be useful, that event is the wrong event.
 *
 * gtag also collects page_location and referrer on its own. Both are constant here because this is
 * a single static page with no per-user routing, which is the only reason that is acceptable.
 */

const RESERVED = /^(google|ga_|firebase_)/i;

/**
 * String parameters are allowlisted by key AND by value, never by shape.
 *
 * Shape was the first attempt and it had a hole: "성균관대학교 SW전문인재양성사업단" is 22
 * characters with no dot and no @, so a length-and-punctuation filter waved a service name
 * straight through. There is no shape that separates an enum we wrote from a name we read out of
 * someone's mailbox. Only an explicit list does.
 *
 * Adding a key here means deciding, in the open, that its values are ours and not theirs.
 */
const STRING_PARAMS = {
  band: new Set(["high", "review", "low"]),
  route: new Set([
    "self_service",
    "contact_form",
    "email_request",
    "public_service",
    "unavailable",
    "none",
  ]),
};

let ready = false;

function gtag() {
  // eslint-disable-next-line prefer-rest-params
  window.dataLayer?.push(arguments);
}

/**
 * @param {string} measurementId e.g. G-0XB4PRBS82, served by /api/config
 */
export function initAnalytics(measurementId) {
  if (!measurementId || ready || typeof document === "undefined") return;
  window.dataLayer = window.dataLayer || [];

  const s = document.createElement("script");
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
  document.head.appendChild(s);

  gtag("js", new Date());
  // No ad signals from a privacy product, and no client id sitting in a cookie forever.
  gtag("config", measurementId, {
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
    anonymize_ip: true,
  });
  ready = true;
}

/**
 * Report that something happened, never what it happened to.
 *
 * Numbers and booleans pass: they count our product's behaviour. Strings pass only if both their
 * key and their value appear in STRING_PARAMS, because a string is the only way a domain, an
 * address, or a service name could get out of here.
 *
 * @param {string} name snake_case event name
 * @param {Record<string, number|boolean|string>} [params]
 */
export function track(name, params = {}) {
  if (!ready) return;
  const safe = {};
  for (const [k, v] of Object.entries(params)) {
    if (RESERVED.test(k)) continue;
    if (typeof v === "number" && Number.isFinite(v)) safe[k] = v;
    else if (typeof v === "boolean") safe[k] = v;
    else if (typeof v === "string" && STRING_PARAMS[k]?.has(v)) safe[k] = v;
  }
  gtag("event", name, safe);
}
