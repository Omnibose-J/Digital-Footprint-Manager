/** Sender reduction + signal classification. Browser ESM; no bundler. */

import { defaultRules } from "./filter.rules.js";
import { authVerdict } from "./authenticity.js";
import { computeDiscoveryScore, computeLikelyClosed } from "./score.js";

const FAMILIES = [
  "signup",
  "auth",
  "transaction",
  "notification",
  "marketing",
  "closure",
  "unknown",
];

/** Trim, strip only surrounding quotes, unescape quoted-string, drop C0/C1 controls. */
function cleanDisplayName(rawName) {
  let s = String(rawName ?? "").trim();
  // Surrounding pair only — a lone leading/trailing quote is part of the name (SOW 003 §5.1 #5).
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1);
    // RFC 5322 quoted-string escapes inside the pair
    s = s.replace(/\\([\\"])/g, "$1");
  }
  s = s.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
  return s.trim();
}

function parseFromHeader(raw = "") {
  const text = String(raw).trim();
  if (!text) return null;

  const angle = text.match(/^(.*)<([^>]+)>\s*$/);
  if (angle) {
    const name = cleanDisplayName(angle[1]);
    const email = angle[2].trim().toLowerCase();
    return { name: name || email, email, raw: text };
  }

  const emailOnly = text.match(/[\w.+-]+@[\w.-]+\.\w+/);
  if (emailOnly) {
    const email = emailOnly[0].toLowerCase();
    return { name: email, email, raw: text };
  }

  return { name: cleanDisplayName(text), email: text.toLowerCase(), raw: text };
}

function domainFromEmail(email) {
  const at = String(email).lastIndexOf("@");
  if (at < 0) return null;
  return String(email)
    .slice(at + 1)
    .toLowerCase();
}

/** DNS label: /^[a-z0-9-]+$/, no leading/trailing hyphen (SOW 005 R5). */
export function isValidDnsLabel(label) {
  const s = String(label || "");
  if (!s || s.length > 63) return false;
  if (s.startsWith("-") || s.endsWith("-")) return false;
  return /^[a-z0-9-]+$/.test(s);
}

export function isValidDnsHost(host) {
  const labels = String(host || "")
    .toLowerCase()
    .replace(/\.$/, "")
    .split(".")
    .filter(Boolean);
  if (labels.length < 2) return false;
  return labels.every(isValidDnsLabel);
}

/**
 * Registrable domain = eTLD+1 against PUBLIC_SUFFIXES (longest match),
 * else last two labels, else null when no dot or invalid labels.
 */
export function registrableDomainFromHost(senderDomain, publicSuffixes = defaultRules.PUBLIC_SUFFIXES) {
  const host = String(senderDomain || "")
    .toLowerCase()
    .replace(/\.$/, "");
  if (!host || !host.includes(".")) return null;

  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return null;
  if (!labels.every(isValidDnsLabel)) return null;

  let bestSuffix = null;
  for (const suffix of publicSuffixes) {
    const s = String(suffix).toLowerCase();
    if (host === s || host.endsWith(`.${s}`)) {
      if (!bestSuffix || s.length > bestSuffix.length) bestSuffix = s;
    }
  }

  if (bestSuffix) {
    const suffixLabels = bestSuffix.split(".").length;
    if (labels.length <= suffixLabels) return null;
    return labels.slice(-(suffixLabels + 1)).join(".");
  }

  return labels.slice(-2).join(".");
}

export function normalizeSender(fromHeaderValue, rules = defaultRules) {
  const parsed = parseFromHeader(fromHeaderValue);
  if (!parsed?.email || !String(parsed.email).includes("@")) {
    // R4/D2: never silently discard — surface as invalid_domain in snapshot().
    return {
      email: parsed?.email ? String(parsed.email).toLowerCase() : "",
      localPart: "",
      senderDomain: null,
      registrableDomain: null,
      displayName: parsed?.name || parsed?.email || "(invalid from)",
    };
  }

  const email = parsed.email;
  const at = email.lastIndexOf("@");
  const localPart = email.slice(0, at);
  const senderDomain = domainFromEmail(email);
  if (!senderDomain) {
    return {
      email,
      localPart,
      senderDomain: null,
      registrableDomain: null,
      displayName: parsed.name || email,
    };
  }

  const registrableDomain = registrableDomainFromHost(
    senderDomain,
    rules.PUBLIC_SUFFIXES
  );

  return {
    email,
    localPart,
    senderDomain,
    registrableDomain,
    displayName: parsed.name || email,
  };
}

/** Rule-table order is documented in filter.rules.js; this is the order that enforces it. */
const SUBJECT_FAMILY_ORDER = ["signup", "closure", "auth", "transaction", "notification"];

function normalizeSubject(subject) {
  return String(subject || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function despace(text) {
  return text.replace(/\s+/g, "");
}

/**
 * Korean spacing is not stable: "회원 탈퇴가 완료" and "회원탈퇴가 완료" are the same subject,
 * and collapsing runs of whitespace does not make one contain the other. Comparing the despaced
 * forms too is purely additive — it can only ever turn a miss into a hit.
 */
function subjectMatches(haystack, needle) {
  if (!needle) return false;
  if (haystack.includes(needle)) return true;
  return despace(haystack).includes(despace(needle));
}

function subjectPhraseEntry(entry) {
  if (entry && typeof entry === "object") {
    return {
      phrase: String(entry.phrase || ""),
      tier: entry.tier === "verification" ? "verification" : "welcome",
    };
  }
  return { phrase: String(entry || ""), tier: "welcome" };
}

function classifyBySubject(subject, rules) {
  const normalized = normalizeSubject(subject);
  if (!normalized) return null;
  const subjectRules = rules.SUBJECT_RULES || {};

  for (const family of SUBJECT_FAMILY_ORDER) {
    for (const entry of subjectRules[family] || []) {
      const { phrase, tier } = subjectPhraseEntry(entry);
      if (subjectMatches(normalized, normalizeSubject(phrase))) {
        return { family, signupTier: family === "signup" ? tier : null };
      }
    }
  }
  return null;
}

function classifyByCategory(labelIds, rules) {
  const labels = Array.isArray(labelIds) ? labelIds : [];
  if (labels.includes(rules.CATEGORY_PURCHASES)) return "transaction";
  if (labels.includes(rules.CATEGORY_PROMOTIONS)) return "marketing";
  if (labels.includes(rules.CATEGORY_UPDATES)) return "notification";
  // Gmail files a service's own activity mail under Social/Forums, and services only send it to
  // members. Both were missing, so every such message fell through to unknown and scored zero —
  // the mechanism behind facebookmail.com landing 269 messages in the low band.
  if (labels.includes(rules.CATEGORY_SOCIAL)) return "notification";
  if (labels.includes(rules.CATEGORY_FORUMS)) return "notification";
  return null;
}

function isBulkPrecedence(value) {
  const v = String(value || "").trim().toLowerCase();
  return v === "bulk" || v === "list" || v === "junk";
}

/** RFC 3834: any value other than "no" means a machine sent this. Params follow a ";". */
function isAutoGenerated(value) {
  const v = String(value || "").split(";")[0].trim().toLowerCase();
  return Boolean(v) && v !== "no";
}

/**
 * Weighted marketing evidence from headers scan.js already pays for (§3).
 * @returns {number} weight; compare against rules.MARKETING_HEADER_THRESHOLD
 */
export function marketingHeaderWeight(headers = {}, rules = defaultRules) {
  const w = rules.MARKETING_HEADER_WEIGHTS || {};
  let total = 0;
  if (headers.listId) total += w.listId || 0;
  if (isBulkPrecedence(headers.precedence)) total += w.precedenceBulk || 0;
  if (headers.listUnsubscribePost) total += w.listUnsubscribePost || 0;
  if (headers.listUnsubscribe) total += w.listUnsubscribe || 0;
  return total;
}

function classifyByHeaders(headers, rules) {
  const weight = marketingHeaderWeight(headers, rules);
  const threshold = rules.MARKETING_HEADER_THRESHOLD ?? 3;
  if (weight >= threshold) return "marketing";
  // Machine-sent but not bulk enough to call marketing, and §3 is explicit that an ambiguous
  // message is not marketing: mislabelling transactional mail strips its lastSeenMonth and makes
  // a live account look dormant, which is the worst failure this product has.
  if (weight > 0 || isAutoGenerated(headers.autoSubmitted)) return "notification";
  return null;
}

export function classifyMessage(
  { labelIds = [], subject = "", headers = {} } = {},
  rules = defaultRules
) {
  const bySubject = classifyBySubject(subject, rules);
  if (bySubject) return bySubject;

  // Gmail's categories before our headers: language-independent and already computed by Google.
  const byCategory = classifyByCategory(labelIds, rules);
  if (byCategory) return { family: byCategory, signupTier: null };

  const byHeaders = classifyByHeaders(headers, rules);
  if (byHeaders) return { family: byHeaders, signupTier: null };

  return { family: "unknown", signupTier: null };
}

function monthFromInternalDate(internalDate) {
  if (internalDate === undefined || internalDate === null || internalDate === "") {
    return null;
  }
  const ms = Number(internalDate);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function emptyFamilies() {
  const out = {};
  for (const f of FAMILIES) out[f] = { months: [], count: 0 };
  return out;
}

function emptyScoreBuckets() {
  return {
    signupVerificationMonths: new Set(),
    signupWelcomeMonths: new Set(),
    authMonths: new Set(),
    transactionMonths: new Set(),
    notificationMonths: new Set(),
    // Scores nothing. It belongs on this side of the split because this is the authenticated
    // evidence, and §3's gate covers negative evidence too — see computeLikelyClosed.
    closureMonths: new Set(),
    hasMarketing: false,
  };
}

function lastSeenMonthFromFamilies(families) {
  let latest = null;
  for (const f of FAMILIES) {
    if (f === "marketing") continue;
    const months = families[f]?.months || [];
    for (const month of months) {
      if (!latest || month > latest) latest = month;
    }
  }
  return latest;
}

function mostFrequentName(nameCounts) {
  let best = "";
  let bestN = -1;
  for (const [name, n] of nameCounts.entries()) {
    if (n > bestN || (n === bestN && name < best)) {
      best = name;
      bestN = n;
    }
  }
  return best;
}

/**
 * Link fields for a candidate. Uses no aggregator instance state (SOW 005 R9).
 * @param {string|null} registrableDomain
 * @param {string|null} hiddenRule
 * @param {any|null} match catalog entry
 * @param {typeof defaultRules} [rules]
 */
export function linkFields(
  registrableDomain,
  hiddenRule,
  match = null,
  rules = defaultRules
) {
  if (match) {
    return {
      siteUrl: match.url || null,
      linkSafety: "verified",
      linkBlockedBy: null,
    };
  }

  const freeSet = new Set(rules.FREE_MAILBOX_DOMAINS);
  const relaySet = new Set(rules.RELAY_DOMAINS);

  let linkBlockedBy = null;
  if (hiddenRule === "self") linkBlockedBy = "self";
  else if (hiddenRule === "relay_domain" || (registrableDomain && relaySet.has(registrableDomain))) {
    linkBlockedBy = "relay";
  } else if (registrableDomain && freeSet.has(registrableDomain)) {
    linkBlockedBy = "free_mailbox";
  }

  if (linkBlockedBy) {
    return { siteUrl: null, linkSafety: "none", linkBlockedBy };
  }
  if (!registrableDomain) {
    return { siteUrl: null, linkSafety: "none", linkBlockedBy: null };
  }
  return {
    siteUrl: `https://${registrableDomain}`,
    linkSafety: "inferred",
    linkBlockedBy: null,
  };
}

/**
 * @param {{ selfEmail: string, rules?: typeof defaultRules }} opts
 */
export function createAggregator({ selfEmail, rules = defaultRules } = {}) {
  const self = String(selfEmail || "").trim().toLowerCase();
  const freeSet = new Set(rules.FREE_MAILBOX_DOMAINS);
  const relaySet = new Set(rules.RELAY_DOMAINS);
  const paymentGatewaySet = new Set(rules.PAYMENT_GATEWAY_DOMAINS || []);
  const machineRe = rules.MACHINE_LOCALPART;

  function aggregationKey(normalized) {
    if (!normalized.registrableDomain) return `invalid:${normalized.email}`;
    // The user's own address is an address-level fact, so it needs its own bucket.
    // Folded into `dom:`, it would hide every service on that domain — SENT mail puts
    // the user in From, so a custom/Workspace domain loses all of its services.
    if (self && normalized.email === self) return `addr:${normalized.email}`;
    if (freeSet.has(normalized.registrableDomain) || relaySet.has(normalized.registrableDomain)) {
      return `addr:${normalized.email}`;
    }
    return `dom:${normalized.registrableDomain}`;
  }

  /** @type {Map<string, any>} */
  const byKey = new Map();
  let messages = 0;
  let unknownFamily = 0;
  let unauthenticatedMessages = 0;

  function ensureService(key, normalized) {
    let svc = byKey.get(key);
    if (!svc) {
      svc = {
        key,
        registrableDomain: normalized.registrableDomain,
        emails: new Set(),
        localParts: new Set(),
        nameCounts: new Map(),
        messageCount: 0,
        families: emptyFamilies(),
        scoreBuckets: emptyScoreBuckets(),
      };
      byKey.set(key, svc);
    }
    return svc;
  }

  function add(message) {
    messages += 1;
    const headers = message?.headers || {};
    const normalized = normalizeSender(headers.from, rules);

    const { family, signupTier } = classifyMessage(
      {
        labelIds: message.labelIds || [],
        subject: headers.subject,
        headers,
      },
      rules
    );
    if (family === "unknown") unknownFamily += 1;

    const key = aggregationKey(normalized);
    const svc = ensureService(key, normalized);

    if (normalized.email && !svc.emails.has(normalized.email)) {
      svc.emails.add(normalized.email);
      svc.localParts.add(normalized.localPart);
    }

    const displayName = normalized.displayName || normalized.email;
    svc.nameCounts.set(displayName, (svc.nameCounts.get(displayName) || 0) + 1);
    svc.messageCount += 1;

    const month = monthFromInternalDate(message.internalDate);
    const bucket = svc.families[family] || (svc.families[family] = { months: [], count: 0 });
    bucket.count += 1;
    if (month && !bucket.months.includes(month)) {
      bucket.months.push(month);
      bucket.months.sort();
    }

    // R2/G2: gate zeroes score contribution only — never evidence or recency.
    const gate = authVerdict(headers.authenticationResults, normalized.registrableDomain);
    if (!gate.pass) {
      unauthenticatedMessages += 1;
    } else if (month || family === "marketing") {
      const sb = svc.scoreBuckets;
      if (family === "signup") {
        if (signupTier === "verification") {
          if (month) sb.signupVerificationMonths.add(month);
        } else if (month) {
          sb.signupWelcomeMonths.add(month);
        }
      } else if (family === "auth" && month) {
        sb.authMonths.add(month);
      } else if (family === "transaction" && month) {
        sb.transactionMonths.add(month);
      } else if (family === "notification" && month) {
        sb.notificationMonths.add(month);
      } else if (family === "closure" && month) {
        sb.closureMonths.add(month);
      } else if (family === "marketing") {
        sb.hasMarketing = true;
      }
    }
  }

  function verdictFor(svc) {
    const emails = [...svc.emails];
    if (self && emails.some((e) => e === self)) {
      return { verdict: "hidden", hiddenRule: "self" };
    }
    if (svc.registrableDomain === null || svc.registrableDomain === undefined) {
      return { verdict: "hidden", hiddenRule: "invalid_domain" };
    }
    // After self + invalid_domain, before personal_mailbox (SOW 003 R2).
    if (paymentGatewaySet.has(svc.registrableDomain)) {
      return { verdict: "hidden", hiddenRule: "payment_gateway" };
    }
    if (relaySet.has(svc.registrableDomain)) {
      return { verdict: "unresolved", hiddenRule: "relay_domain" };
    }

    const hasSignupOrAuth =
      (svc.families.signup?.count || 0) > 0 || (svc.families.auth?.count || 0) > 0;
    const localParts = [...svc.localParts];
    const allPersonalLooking =
      localParts.length > 0 && localParts.every((lp) => !machineRe.test(lp));

    if (
      freeSet.has(svc.registrableDomain) &&
      allPersonalLooking &&
      !hasSignupOrAuth
    ) {
      return { verdict: "hidden", hiddenRule: "personal_mailbox" };
    }

    return { verdict: "candidate", hiddenRule: null };
  }

  function toCandidate(svc) {
    const { verdict, hiddenRule } = verdictFor(svc);
    const families = {};
    for (const f of FAMILIES) {
      const src = svc.families[f] || { months: [], count: 0 };
      families[f] = {
        months: [...src.months].sort(),
        count: src.count,
      };
    }
    const sb = svc.scoreBuckets || emptyScoreBuckets();
    const scored = computeDiscoveryScore({
      signupVerificationMonths: [...sb.signupVerificationMonths],
      signupWelcomeMonths: [...sb.signupWelcomeMonths],
      authMonths: [...sb.authMonths],
      transactionMonths: [...sb.transactionMonths],
      notificationMonths: [...sb.notificationMonths],
      hasMarketing: sb.hasMarketing,
    });
    const likelyClosed = computeLikelyClosed(families, [...sb.closureMonths]);
    const links = linkFields(svc.registrableDomain, hiddenRule, null, rules);
    return {
      key: svc.key, // stable identity across snapshots; registrableDomain is not unique
      registrableDomain: svc.registrableDomain,
      displayName: mostFrequentName(svc.nameCounts) || svc.registrableDomain || "",
      messageCount: svc.messageCount,
      families,
      lastSeenMonth: lastSeenMonthFromFamilies(families),
      siteUrl: links.siteUrl,
      linkSafety: links.linkSafety,
      linkBlockedBy: links.linkBlockedBy,
      verdict,
      hiddenRule,
      discoveryScore: scored.discoveryScore,
      discoveryBand: scored.discoveryBand,
      scoreExplanation: scored.scoreExplanation,
      likelyClosed,
      userStatus: null,
    };
  }

  function snapshot() {
    const services = [];
    const hidden = [];
    const unresolved = [];

    for (const svc of byKey.values()) {
      const candidate = toCandidate(svc);
      if (candidate.verdict === "candidate") services.push(candidate);
      else if (candidate.verdict === "unresolved") unresolved.push(candidate);
      else hidden.push(candidate);
    }

    // Sort once in verdict.js (last hand on the list) — SOW 005 R9.
    return {
      services,
      hidden,
      unresolved,
      stats: {
        messages,
        services: services.length,
        hidden: hidden.length,
        unresolved: unresolved.length,
        unknownFamily,
        unauthenticatedMessages,
      },
    };
  }

  return { add, snapshot };
}

export { parseFromHeader };
