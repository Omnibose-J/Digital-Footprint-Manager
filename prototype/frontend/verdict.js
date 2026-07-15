/**
 * Session overrides for the user's explicit verdicts, applied onto a fresh aggregator snapshot.
 *
 * Pure by design, and separate from app.js on purpose: every progress tick replaces the snapshot,
 * so this has to re-run on each render, and it has to be testable without a DOM.
 *
 * PRODUCT_SPEC §3 also defines owned and unsure. They are not here: nothing consumes them
 * yet. The cleanup list they feed (§4) does not exist, so they only ever set a badge.
 * Bring them back with that list, not before.
 */

/** Score desc, then messageCount desc — single shared comparator (SOW 005 R9). */
function compareByScoreThenCount(a, b) {
  const sa = a.discoveryScore || 0;
  const sb = b.discoveryScore || 0;
  if (sb !== sa) return sb - sa;
  return b.messageCount - a.messageCount;
}

function compareByCount(a, b) {
  return b.messageCount - a.messageCount;
}

function sortBuckets(snapshot) {
  return {
    ...snapshot,
    services: [...(snapshot.services || [])].sort(compareByScoreThenCount),
    hidden: [...(snapshot.hidden || [])].sort(compareByCount),
    unresolved: [...(snapshot.unresolved || [])].sort(compareByCount),
  };
}

/**
 * @param {any} snapshot aggregator snapshot
 * @param {Map<string, 'not_mine'|'candidate'>} verdicts keyed by ServiceCandidate.key
 */
export function applyUserVerdict(snapshot, verdicts) {
  if (!snapshot) return snapshot;
  if (!verdicts || verdicts.size === 0) {
    return sortBuckets(annotateDefaults(snapshot));
  }

  let services = [...(snapshot.services || [])];
  let hidden = [...(snapshot.hidden || [])];
  let unresolved = [...(snapshot.unresolved || [])];

  services = services.filter((s) => {
    if (verdicts.get(s.key) !== "not_mine") return true;
    hidden.push({
      ...s,
      verdict: "hidden",
      hiddenRule: "not_mine",
      userStatus: "not_mine",
    });
    return false;
  });

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

