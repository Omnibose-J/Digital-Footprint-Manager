/**
 * Google Analytics, with a boundary.
 *
 * THE RULE: no identifier read out of the mailbox may leave this file's callers. Not a domain, not
 * a service name, not a sender address. The screen next to this one promises "메일이 서버로 가지
 * 않습니다", and shipping "탈퇴 안내 clicked · coupang.com" to Google Analytics would break that
 * promise more quietly than sending the mail itself, because the account list is the thing the mail
 * was only ever evidence for.
 *
 * Aggregate counts DO leave, and saying otherwise would be a lie about the code below:
 * scan_completed carries how many messages were read and how many candidates came back. That is a
 * fact about their mailbox, weakly, and it is sent knowingly. It buys the band distribution and the
 * catalog miss rate, which is what tells us the product is wrong; a count of 63 names nothing and
 * reaches no one. An identifier would. That line, not the count/no-count line, is the boundary.
 *
 * So the events carry shape, never content: that a guide was opened, not whose. If a new event
 * needs a name, a domain, or an address to be useful, that event is the wrong event.
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
  // Which kind of link was followed, never which URL. "route" is the official withdrawal page,
  // "source" the evidence we read it from, "mail" the user's own Gmail search, "list" the service
  // name in the table. The href is the one thing on that anchor we must never send, and it is a
  // string, so it is not in this list.
  link: new Set(["route", "source", "mail", "list"]),
  // How much we trust the link that was followed. The list renders a catalogued service and a
  // guessed one identically, and this is the difference: whether people follow an address we
  // inferred from a sender domain is a question about our own warning, not about their mail.
  safety: new Set(["verified", "inferred"]),
  // Which of our exclusion rules the user overrode with 복구. This is the rule's own name, ours,
  // and it is the only way to learn which rule is wrong: a rule restored half the time is a bug
  // report we would otherwise never receive.
  reason: new Set([
    "self",
    "invalid_domain",
    "relay_domain",
    "personal_mailbox",
    "payment_gateway",
    "unresolved",
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
