import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeCleanupScore, monthsSince, bandForCleanup, inUseSignal } from "../core/cleanup.js";

const NOW = new Date("2026-07-16T00:00:00Z");

/** Months back from NOW, as YYYY-MM. Keeps the fixtures readable and the maths in one place. */
function monthsAgo(n) {
  const d = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function candidate(over = {}) {
  return {
    discoveryBand: "high",
    likelyClosed: false,
    lastSeenMonth: monthsAgo(40),
    linkSafety: "verified",
    families: { transaction: { months: [], count: 0 } },
    catalogEntry: { category: "shopping", deletion_route: "self_service" },
    ...over,
  };
}

describe("SPEC §4 cleanup score, worked examples from the spec itself", () => {
  it("40-month-dormant shopping mall with a verified self-service route = 90 recommended", () => {
    const r = computeCleanupScore(
      candidate({ families: { transaction: { months: [monthsAgo(41), monthsAgo(42)] } } }),
      NOW
    );
    // 40 + 20 + 15 + 15
    assert.equal(r.cleanupScore, 90);
    assert.equal(r.cleanupBand, "recommended");
  });

  it("dormant community account with only an email-request route = 56 review", () => {
    const r = computeCleanupScore(
      candidate({
        lastSeenMonth: monthsAgo(40),
        catalogEntry: { category: "community", deletion_route: "email_request" },
      }),
      NOW
    );
    // 40 + 8 + 0 + 8
    assert.equal(r.cleanupScore, 56);
    assert.equal(r.cleanupBand, "review");
  });

  it("actively used cloud storage = 45 review with the in-use signal, never recommended", () => {
    const r = computeCleanupScore(
      candidate({
        lastSeenMonth: monthsAgo(0),
        catalogEntry: { category: "cloud", deletion_route: "self_service" },
      }),
      NOW
    );
    // 0 + 30 + 0 + 15. Sensitive, but deletion is not the right action for it.
    assert.equal(r.cleanupScore, 45);
    assert.equal(r.cleanupBand, "review");
    assert.equal(r.inUse, true);
  });
});

describe("SPEC §4 in-use guard", () => {
  it("recent mail blocks recommended even at a score that would otherwise reach it", () => {
    // Everything maxed except dormancy, plus a fresh trace: 0 + 30 + 15 + 15 = 60.
    const c = candidate({
      lastSeenMonth: monthsAgo(1),
      catalogEntry: { category: "finance", deletion_route: "self_service" },
      families: { transaction: { months: [monthsAgo(20), monthsAgo(21)] } },
    });
    const r = computeCleanupScore(c, NOW);
    assert.equal(r.cleanupScore, 60);
    assert.equal(r.inUse, true);
    assert.notEqual(r.cleanupBand, "recommended");
  });

  it("a charge in the last two months blocks recommended even when the mail looks old", () => {
    const c = candidate({
      lastSeenMonth: monthsAgo(40),
      families: { transaction: { months: [monthsAgo(1)] } },
    });
    const r = computeCleanupScore(c, NOW);
    assert.equal(r.inUse, true);
    assert.notEqual(r.cleanupBand, "recommended");
  });

  it("the guard demotes the verdict and leaves the score alone", () => {
    // A silently lowered score would make its own explanation a lie.
    const c = candidate({ lastSeenMonth: monthsAgo(1) });
    const withGuard = computeCleanupScore(c, NOW);
    const noGuard = computeCleanupScore({ ...c, lastSeenMonth: monthsAgo(6) }, NOW);
    assert.equal(withGuard.axes.dormancy, 0);
    assert.equal(noGuard.axes.dormancy, 0);
    assert.equal(withGuard.cleanupScore, noGuard.cleanupScore);
    assert.equal(withGuard.inUse, true);
    assert.equal(noGuard.inUse, false);
  });

  it("3 months is the boundary, not 2 or 4", () => {
    assert.equal(inUseSignal({ lastSeenMonth: monthsAgo(2) }, NOW), true);
    assert.equal(inUseSignal({ lastSeenMonth: monthsAgo(3) }, NOW), false);
  });
});

describe("SPEC §4 dormancy bands", () => {
  it("follows the table at each edge", () => {
    const at = (n) => computeCleanupScore(candidate({ lastSeenMonth: monthsAgo(n) }), NOW).axes.dormancy;
    assert.equal(at(37), 40);
    assert.equal(at(36), 30);
    assert.equal(at(24), 30);
    assert.equal(at(23), 18);
    assert.equal(at(12), 18);
    assert.equal(at(11), 0);
    assert.equal(at(0), 0);
  });

  it("no non-marketing evidence at all scores 25, not the top of the axis", () => {
    // We know nothing, which is not the same as knowing it is 40 months old.
    const r = computeCleanupScore(candidate({ lastSeenMonth: null }), NOW);
    assert.equal(r.axes.dormancy, 25);
    assert.match(r.cleanupWhy, /메일 흔적 없음/);
  });
});

describe("SPEC §4 scope and exclusions", () => {
  it("likely_closed is excluded entirely", () => {
    const r = computeCleanupScore(candidate({ likelyClosed: true }), NOW);
    assert.equal(r.cleanupScore, null);
    assert.equal(r.cleanupBand, null);
  });

  it("only high-band candidates are scored", () => {
    // Ranking "delete this first" above a row we are not sure is an account inverts the product.
    for (const band of ["review", "low"]) {
      const r = computeCleanupScore(candidate({ discoveryBand: band }), NOW);
      assert.equal(r.cleanupScore, null, band);
    }
    assert.equal(typeof computeCleanupScore(candidate(), NOW).cleanupScore, "number");
  });

  it("an inferred link earns no readiness points", () => {
    // A guessable URL is not a verified route, and paying for it would rank a service higher for
    // the accident of having a guessable domain.
    const r = computeCleanupScore(candidate({ linkSafety: "inferred" }), NOW);
    assert.equal(r.axes.readiness, 0);
  });

  it("an uncatalogued service gets the floor on sensitivity, not a guess", () => {
    const r = computeCleanupScore(candidate({ catalogEntry: null, linkSafety: "inferred" }), NOW);
    assert.equal(r.axes.sensitivity, 8);
    assert.equal(r.axes.readiness, 0);
  });
});

describe("SPEC §4 explanation names the top two axes in Korean", () => {
  it("says why, in the spec's own shape", () => {
    // The spec's example is "30개월 방치 + 결제 정보 저장 가능성", which only lands when payment
    // outranks sensitivity, so the category has to be one of the cheap ones. On a shopping mall
    // (20) the honest answer is "30개월 방치 + 민감한 정보", and the test below says so.
    const r = computeCleanupScore(
      candidate({
        lastSeenMonth: monthsAgo(30),
        catalogEntry: { category: "community", deletion_route: "self_service" },
        families: { transaction: { months: [monthsAgo(31), monthsAgo(32)] } },
      }),
      NOW
    );
    assert.equal(r.cleanupWhy, "30개월 방치 + 결제 정보 저장 가능성");
  });

  it("names the axes that actually scored, not the ones the spec's example happened to have", () => {
    const r = computeCleanupScore(
      candidate({
        lastSeenMonth: monthsAgo(30),
        catalogEntry: { category: "shopping", deletion_route: "self_service" },
        families: { transaction: { months: [monthsAgo(31), monthsAgo(32)] } },
      }),
      NOW
    );
    // dormancy 30 > sensitivity 20 > payment 15.
    assert.equal(r.cleanupWhy, "30개월 방치 + 민감한 정보");
  });

  it("never names an axis that scored nothing", () => {
    const r = computeCleanupScore(
      candidate({ lastSeenMonth: monthsAgo(40), families: { transaction: { months: [] } } }),
      NOW
    );
    assert.doesNotMatch(r.cleanupWhy, /결제/);
  });
});

describe("bands and month maths", () => {
  it("bandForCleanup follows §4", () => {
    assert.equal(bandForCleanup(60), "recommended");
    assert.equal(bandForCleanup(59), "review");
    assert.equal(bandForCleanup(30), "review");
    assert.equal(bandForCleanup(29), "keep_or_watch");
  });

  it("monthsSince handles a missing or malformed month", () => {
    assert.equal(monthsSince(null, NOW), null);
    assert.equal(monthsSince("2026", NOW), null);
    assert.equal(monthsSince("2026-07", NOW), 0);
    assert.equal(monthsSince("2025-07", NOW), 12);
  });
});

describe("a row we can do nothing about is not ranked first", () => {
  it("a free-mailbox candidate gets no cleanup rank, however dormant", () => {
    // 성균관대학교 SW전문인재양성사업단 took #1 of 63 on the 2026-07-15 scan from a gmail.com
    // address: 보류 26, dormant 18 months, and 경로 미확인 in the one column that says what to do.
    // A blocked link means the domain is not a company, so there is no route, no site link and no
    // Gmail search this row could ever carry. "Deal with this first" needs a second half.
    const r = computeCleanupScore(
      {
        discoveryBand: "high",
        lastSeenMonth: "2025-01",
        registrableDomain: "gmail.com",
        linkSafety: "none",
        linkBlockedBy: "free_mailbox",
        families: {},
      },
      new Date("2026-07-15T00:00:00Z")
    );
    assert.equal(r.cleanupScore, null);
    assert.equal(r.cleanupBand, null);
  });

  it("an uncatalogued REAL domain is still ranked, because that gap is ours and not theirs", () => {
    // The distinction this rests on. vercel.com is a company we have not written up; gmail.com is
    // not a company. Withholding a rank for the first would sort by our catalog's coverage.
    const r = computeCleanupScore(
      {
        discoveryBand: "high",
        lastSeenMonth: "2024-02",
        registrableDomain: "vercel.com",
        linkSafety: "inferred",
        linkBlockedBy: null,
        families: {},
      },
      new Date("2026-07-15T00:00:00Z")
    );
    assert.ok(r.cleanupScore > 0, `expected a rank, got ${r.cleanupScore}`);
  });
});
