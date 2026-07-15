/**
 * Session overrides for the user's explicit verdicts, applied onto a fresh aggregator snapshot.
 *
 * Pure by design, and separate from app.js on purpose: every progress tick replaces the snapshot,
 * so this has to re-run on each render, and it has to be testable without a DOM.
 */

/**
 * @param {any} snapshot aggregator snapshot
 * @param {Map<string, 'candidate'|'not_mine'>} verdicts keyed by ServiceCandidate.key
 */
export function applyUserVerdict(snapshot, verdicts) {
  if (!snapshot) return snapshot;
  if (!verdicts || verdicts.size === 0) return snapshot;

  let services = [...(snapshot.services || [])];
  let hidden = [...(snapshot.hidden || [])];
  let unresolved = [...(snapshot.unresolved || [])];

  services = services.filter((s) => {
    if (verdicts.get(s.key) !== "not_mine") return true;
    hidden.push({ ...s, verdict: "hidden", hiddenRule: "not_mine" });
    return false;
  });

  // Link fields are left untouched: restoring says "this is a service", not "this URL is right".
  const pullToServices = (bucket) =>
    bucket.filter((s) => {
      if (verdicts.get(s.key) !== "candidate") return true;
      services.push({ ...s, verdict: "candidate", hiddenRule: null });
      return false;
    });
  hidden = pullToServices(hidden);
  unresolved = pullToServices(unresolved);

  services.sort((a, b) => b.messageCount - a.messageCount);
  hidden.sort((a, b) => b.messageCount - a.messageCount);
  unresolved.sort((a, b) => b.messageCount - a.messageCount);

  return {
    services,
    hidden,
    unresolved,
    stats: {
      ...snapshot.stats,
      services: services.length,
      hidden: hidden.length,
      unresolved: unresolved.length,
    },
  };
}
