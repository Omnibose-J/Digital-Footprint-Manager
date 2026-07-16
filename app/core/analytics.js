/**
 * Google Analytics helpers.
 *
 * Most events still carry shape only (counts, enums) — not mailbox identifiers.
 * Owner-requested cleanup events (mark_delete / mark_keep / click_unsubscribe) may
 * include a `domain` string so the product owner can see which services were chosen.
 */

const RESERVED = /^(google|ga_|firebase_)/i;

/** Events that may carry a registrable domain (owner request). */
const DOMAIN_EVENTS = new Set(["mark_delete", "mark_keep", "click_unsubscribe"]);

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
  link: new Set(["route", "source", "mail", "list", "cancel"]),
  safety: new Set(["verified", "inferred", "domain"]),
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

function isDebugHost() {
  if (typeof location === "undefined") return false;
  const h = location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

/** Loose domain shape: no @, no spaces, capped length. */
function isDomainParam(value) {
  const v = String(value || "").trim().toLowerCase();
  if (!v || v.length > 253 || v.includes("@") || /\s/.test(v)) return false;
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(v);
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
  gtag("config", measurementId, {
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
    anonymize_ip: true,
    ...(isDebugHost() ? { debug_mode: true } : {}),
  });
  ready = true;
}

/**
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
    else if (typeof v === "string") {
      if (STRING_PARAMS[k]?.has(v)) safe[k] = v;
      else if (k === "domain" && DOMAIN_EVENTS.has(name) && isDomainParam(v)) {
        safe.domain = String(v).trim().toLowerCase();
      }
    }
  }
  gtag("event", name, safe);
}
