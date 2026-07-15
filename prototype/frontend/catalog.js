/** Catalog load, domain match, and verified-link upgrade. Browser ESM; no bundler. */

import { linkFields } from "./filter.js";

const VALID_ROUTES = new Set([
  "self_service",
  "contact_form",
  "email_request",
  "public_service",
  "unavailable",
]);

const VALID_CATEGORIES = new Set([
  "finance",
  "health",
  "identity",
  "cloud",
  "email",
  "shopping",
  "productivity",
  "social",
  "community",
  "other",
]);

/**
 * Exact match on sender_domain_aliases (registrable domains only).
 * Never fuzzy, never display-name.
 * @param {string} registrableDomain
 * @param {{ services?: any[] } | null | undefined} catalog
 * @returns {any | null}
 */
export function matchService(registrableDomain, catalog) {
  const domain = String(registrableDomain || "")
    .toLowerCase()
    .trim();
  if (!domain || !catalog?.services) return null;

  for (const entry of catalog.services) {
    const aliases = entry.sender_domain_aliases || [];
    for (const alias of aliases) {
      if (String(alias).toLowerCase() === domain) return entry;
    }
  }
  return null;
}

/** @param {string} isoDate YYYY-MM-DD */
function parseIsoDate(isoDate) {
  const m = String(isoDate || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Stale when review_due_at is strictly before today's UTC calendar date.
 * @param {{ review_due_at?: string }} entry
 * @param {Date} [today]
 */
export function isStale(entry, today = new Date()) {
  const due = parseIsoDate(entry?.review_due_at);
  if (!due) return false;
  const y = today.getUTCFullYear();
  const mo = today.getUTCMonth();
  const day = today.getUTCDate();
  const startOfToday = Date.UTC(y, mo, day);
  return due.getTime() < startOfToday;
}

/**
 * Apply catalog match to a candidate. Skips when linkBlockedBy is set (E2).
 * Uses filter.linkFields via the optional-match path (R3).
 * @param {any} candidate
 * @param {{ services?: any[] } | null | undefined} catalog
 */
export function upgradeCandidate(candidate, catalog) {
  if (!candidate) return candidate;
  if (candidate.linkBlockedBy) return { ...candidate, catalogEntry: null };

  const entry = matchService(candidate.registrableDomain, catalog);
  if (!entry) return { ...candidate, catalogEntry: null };

  const links = linkFields(candidate.registrableDomain, candidate.hiddenRule, entry);
  return {
    ...candidate,
    siteUrl: links.siteUrl,
    linkSafety: links.linkSafety,
    linkBlockedBy: links.linkBlockedBy,
    serviceId: entry.service_id,
    catalogEntry: entry,
  };
}

export function upgradeSnapshot(snapshot, catalog) {
  if (!snapshot) return snapshot;
  const map = (list) => (list || []).map((c) => upgradeCandidate(c, catalog));
  return {
    ...snapshot,
    services: map(snapshot.services),
    hidden: map(snapshot.hidden),
    unresolved: map(snapshot.unresolved),
  };
}

/** Fetch the static catalog asset. */
export async function loadCatalog(fetchImpl = fetch, url = "./catalog.json") {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`catalog load failed: ${res.status}`);
  return res.json();
}

export { VALID_ROUTES, VALID_CATEGORIES };
