/**
 * Session overrides for the user's explicit verdicts, applied onto a fresh aggregator snapshot.
 *
 * Pure by design, and separate from app.js on purpose: every progress tick replaces the snapshot,
 * so this has to re-run on each render, and it has to be testable without a DOM.
 *
 * PRODUCT_SPEC §3 defines four: owned, unsure, not_mine, and the restore back to candidate. Only
 * the restore is here. The other three each set a badge and feed a cleanup list (§4) that does
 * not exist, so they were controls arriving ahead of the thing they serve. Bring them back with
 * that list, not before.
 */

/**
 * Cleanup priority first, then discovery confidence (SOW 005 R9: one shared comparator).
 *
 * The product is a cleanup tool, so the top of the list has to answer "what do I deal with first",
 * not "which of these is most certainly mine". Sorted by confidence alone the top was GitHub and
 * Google: the accounts the user opens every day, ranked highest precisely because they are the most
 * certainly theirs. That is the wrong end of the list to start from.
 *
 * Unscored rows (§4 computes cleanup only for high-band, never for likely_closed) fall below the
 * scored ones and keep their old confidence ordering among themselves. They are not "low priority",
 * they are "we are not confident enough to rank this", which is a different sentence, and the cell
 * says so with a dash rather than a number.
 */
function compareByScoreThenCount(a, b) {
  const pa = typeof a.cleanupScore === "number" ? a.cleanupScore : -1;
  const pb = typeof b.cleanupScore === "number" ? b.cleanupScore : -1;
  if (pb !== pa) return pb - pa;
  const sa = a.discoveryScore || 0;
  const sb = b.discoveryScore || 0;
  if (sb !== sa) return sb - sa;
  return b.messageCount - a.messageCount;
}

function compareByCount(a, b) {
  return b.messageCount - a.messageCount;
}

/**
 * Exported because the order cannot be decided here any more.
 *
 * cleanupScore is added by the catalog pass, which has to run after this file moves rows between
 * buckets (upgradeCandidate reads hiddenRule to decide the link, and restoring is what clears it).
 * So the pipeline is: move buckets, apply the catalog and score, then sort. Sorting here as well
 * would rank by a field that does not exist yet.
 */
export function sortBuckets(snapshot) {
  return {
    ...snapshot,
    services: [...(snapshot.services || [])].sort(compareByScoreThenCount),
    hidden: [...(snapshot.hidden || [])].sort(compareByCount),
    unresolved: [...(snapshot.unresolved || [])].sort(compareByCount),
  };
}

/**
 * @param {any} snapshot aggregator snapshot
 * @param {Map<string, 'candidate'>} verdicts keyed by ServiceCandidate.key
 */
export function applyUserVerdict(snapshot, verdicts) {
  if (!snapshot) return snapshot;
  if (!verdicts || verdicts.size === 0) {
    return sortBuckets(annotateDefaults(snapshot));
  }

  const services = [...(snapshot.services || [])];
  let hidden = [...(snapshot.hidden || [])];
  let unresolved = [...(snapshot.unresolved || [])];

  // Link fields are left untouched: restoring says "this is a service", not "this URL is right".
  const pullToServices = (bucket) =>
    bucket.filter((s) => {
      if (verdicts.get(s.key) !== "candidate") return true;
      services.push({
        ...s,
        verdict: "candidate",
        hiddenRule: null,
        userStatus: null,
      });
      return false;
    });
  hidden = pullToServices(hidden);
  unresolved = pullToServices(unresolved);


  return sortBuckets({
    services,
    hidden,
    unresolved,
    stats: {
      ...snapshot.stats,
      services: services.length,
      hidden: hidden.length,
      unresolved: unresolved.length,
    },
  });
}

function annotateDefaults(snapshot) {
  return {
    ...snapshot,
    services: (snapshot.services || []).map((s) => ({
      ...s,
      userStatus: s.userStatus ?? null,
    })),
  };
}

