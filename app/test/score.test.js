import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeDiscoveryScore, computeLikelyClosed } from "../core/score.js";
import { classifyMessage } from "../core/filter.js";

describe("SOW 004 R3 discoveryScore", () => {
  it("verification 55 + reset 35 → 90 high", () => {
    const r = computeDiscoveryScore({
      signupVerificationMonths: ["2024-01"],
      authMonths: ["2024-02"],
    });
    assert.equal(r.discoveryScore, 90);
    assert.equal(r.discoveryBand, "high");
  });

  it("welcome 40 + reset 35 → 75 high", () => {
    const r = computeDiscoveryScore({
      signupWelcomeMonths: ["2024-01"],
      authMonths: ["2024-02"],
    });
    assert.equal(r.discoveryScore, 75);
    assert.equal(r.discoveryBand, "high");
  });

  it("welcome alone → 40 review", () => {
    const r = computeDiscoveryScore({
      signupWelcomeMonths: ["2024-01"],
    });
    assert.equal(r.discoveryScore, 40);
    assert.equal(r.discoveryBand, "review");
  });

  it("recurring subscription (3 months) + notifications (3 months) → 45 review", () => {
    // The §3 table (10/month, cap 30) and its worked example ("recurring subscription 25 +
    // notifications 15 = 40") disagree. This follows the table, so the number moved 40 -> 45.
    // The example's actual claim survives untouched: still review, still not high.
    const r = computeDiscoveryScore({
      transactionMonths: ["2024-01", "2024-02", "2024-03"],
      notificationMonths: ["2024-01", "2024-02", "2024-03"],
    });
    assert.equal(r.discoveryScore, 45);
    assert.equal(r.discoveryBand, "review");
  });

  it("transaction reaches its cap of 30, which the worked example made unreachable", () => {
    const four = computeDiscoveryScore({
      transactionMonths: ["2024-01", "2024-02", "2024-03", "2024-04"],
    });
    assert.equal(four.familyScores.transaction, 30);
    // The band this cost: welcome + receipts in 4 distinct months scored 65 review before.
    const withWelcome = computeDiscoveryScore({
      signupWelcomeMonths: ["2024-01"],
      transactionMonths: ["2024-01", "2024-02", "2024-03", "2024-04"],
    });
    assert.equal(withWelcome.discoveryScore, 70);
    assert.equal(withWelcome.discoveryBand, "high");
  });

  it("transaction alone can never reach high, cap or no cap", () => {
    const r = computeDiscoveryScore({
      transactionMonths: ["2024-01", "2024-02", "2024-03", "2024-04", "2024-05"],
      notificationMonths: ["2024-01", "2024-02", "2024-03"],
      hasMarketing: true,
    });
    assert.equal(r.discoveryScore, 50);
    assert.equal(r.discoveryBand, "review");
  });

  it("20 OTP mails in one day count auth once (distinct month)", () => {
    const r = computeDiscoveryScore({
      authMonths: Array(20).fill("2024-06"),
    });
    assert.equal(r.discoveryScore, 35);
    assert.equal(r.familyScores.auth, 35);
  });

  it("auth accumulates per distinct month instead of freezing at the second", () => {
    // The old rule was `length >= 2 ? 45 : 35`: two months and twenty both scored 45.
    const months = (n) => Array.from({ length: n }, (_, i) => `2024-${String(i + 1).padStart(2, "0")}`);
    assert.equal(computeDiscoveryScore({ authMonths: months(1) }).familyScores.auth, 35);
    assert.equal(computeDiscoveryScore({ authMonths: months(2) }).familyScores.auth, 45);
    assert.equal(computeDiscoveryScore({ authMonths: months(3) }).familyScores.auth, 55);
    assert.equal(computeDiscoveryScore({ authMonths: months(9) }).familyScores.auth, 55);
  });

  it("auth alone never reaches high: an OTP can reach someone with no account", () => {
    const r = computeDiscoveryScore({
      authMonths: ["2024-01", "2024-02", "2024-03", "2024-04", "2024-05"],
    });
    assert.equal(r.discoveryScore, 55);
    assert.equal(r.discoveryBand, "review");
  });

  it("an old account with no signup mail can still reach high on auth + notifications", () => {
    // The measured failure: GitHub, 252 messages, password resets across years, sat at 65 because
    // auth was capped at 45 and its signup mail predates the mailbox.
    const r = computeDiscoveryScore({
      authMonths: ["2023-04", "2024-01", "2025-06"],
      notificationMonths: ["2024-01", "2024-02", "2024-03"],
      hasMarketing: true,
    });
    assert.equal(r.discoveryScore, 75);
    assert.equal(r.discoveryBand, "high");
  });

  it("50 marketing only → 5 low, never high (G4)", () => {
    const r = computeDiscoveryScore({ hasMarketing: true });
    assert.equal(r.discoveryScore, 5);
    assert.equal(r.discoveryBand, "low");
  });

  it("signup 2015 still scores — no decay (R4)", () => {
    const r = computeDiscoveryScore({
      signupVerificationMonths: ["2015-03"],
    });
    assert.equal(r.discoveryScore, 55);
  });

  it("signup tiers come from SUBJECT_RULES phrase tags", () => {
    assert.equal(
      classifyMessage({ subject: "이메일 인증이 완료되었습니다" }).signupTier,
      "verification"
    );
    assert.equal(
      classifyMessage({ subject: "회원가입이 완료되었습니다" }).signupTier,
      "welcome"
    );
  });

  it("notification cap stays 15 (F5)", () => {
    const r = computeDiscoveryScore({
      notificationMonths: ["2024-01", "2024-02", "2024-03", "2024-04", "2024-05"],
    });
    assert.equal(r.familyScores.notification, 15);
  });
});

describe("SOW 004 R5 likely_closed", () => {
  // The authenticated closure months arrive as the second argument. families carries every closure
  // mail either way, so passing only families is what a forged mail looks like from here.
  it("closure newer than positive → likely_closed", () => {
    assert.equal(
      computeLikelyClosed(
        {
          signup: { months: ["2023-01"], count: 1 },
          closure: { months: ["2024-06"], count: 1 },
        },
        ["2024-06"]
      ),
      true
    );
  });

  it("closure older than positive → not likely_closed", () => {
    assert.equal(
      computeLikelyClosed(
        {
          signup: { months: ["2024-08"], count: 1 },
          closure: { months: ["2023-01"], count: 1 },
        },
        ["2023-01"]
      ),
      false
    );
  });

  it("a closure mail that failed the gate cannot close the account (§3)", () => {
    assert.equal(
      computeLikelyClosed(
        {
          signup: { months: ["2023-01"], count: 1 },
          closure: { months: ["2024-06"], count: 1 },
        },
        []
      ),
      false
    );
  });

  it("a forged closure newer than the authenticated one cannot extend the conclusion", () => {
    // The forged 2024-09 straddles the 2024-07 signup: reading families would close this account,
    // reading only the authenticated 2024-06 does not. That gap is the whole fix.
    assert.equal(
      computeLikelyClosed(
        {
          signup: { months: ["2024-07"], count: 1 },
          closure: { months: ["2024-06", "2024-09"], count: 2 },
        },
        ["2024-06"]
      ),
      false
    );
  });
});
