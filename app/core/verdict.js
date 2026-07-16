/**
 * Session overrides for the user's explicit verdicts, applied onto a fresh aggregator snapshot.
 *
 * Pure by design, and separate from app.js on purpose: every progress tick replaces the snapshot,
 * so this has to re-run on each render, and it has to be testable without a DOM.
 *
 * §3 used to define owned/not_mine/unsure alongside the restore. They were removed from the product
 * on 2026-07-15 (7f0ff42) and struck from the spec on 2026-07-16: the owner ruled out bringing
 * 내 계정 아님 back, and the screen asks one question now — 사용/미사용, which is §4's question
 * ("clean this up first?"), never §3's ("did we find a real account?"). Nothing the user says moves
 * discoveryScore. The restore stays here; the label rides in as `cleanupChoice` from web/app.js and
 * this file only sorts by it.
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
  // An answered row sinks, whichever way it was answered. The list is a queue of open questions, and
  // ranking one the user has already settled — either way — above one they have not is asking twice.
  // It stays on the list rather than disappearing: "I decided" is not "take it off my screen", and a
  // label is reversible.
  const la = a.cleanupChoice ? 1 : 0;
  const lb = b.cleanupChoice ? 1 : 0;
  if (la !== lb) return la - lb;

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

