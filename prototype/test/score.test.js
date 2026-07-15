import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeDiscoveryScore,
  computeLikelyClosed,
  signupTierFromPhrase,
} from "../public/score.js";

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

  it("recurring subscription (3 months) + notifications (3 months) → 40 review", () => {
    const r = computeDiscoveryScore({
      transactionMonths: ["2024-01", "2024-02", "2024-03"],
      notificationMonths: ["2024-01", "2024-02", "2024-03"],
    });
    // tx: min(30, max(30, 25)) = 30; notification: 15; sum 45 — wait
    // Spec example: recurring subscription 25 + notifications 15 = 40 review
    // So the floor-at-25 for ≥3 months replaces 10*3=30? Or they mean the floor case
    // when using a different counting? Spec table: "10 per distinct month; recurring in ≥3
    // distinct months floors the family at 25" + cap 30.
    // Worked example says 25+15=40. So for ≥3 months they want 25 (floor as the score when
    // treating as "recurring subscription"), not 10*3=30.
    // Re-read: "floors the family at 25" means minimum 25, not set-to-25.
    // But worked example explicitly says 25+15=40.
    // So the worked example uses 25 for the 3-month subscription case.
    // I'll treat ≥3 months as exactly the recurring floor contribution of 25 unless
    // 10*n is used only below 3 months... That would mean: 1→10, 2→20, ≥3→25 (then cap 30
    // for more?). Or ≥3 → max(25, min(30, 10*n)) which is 30 for n=3.
    //
    // The worked example is authoritative for the SOW verify table (#4). Expect 40.
    assert.equal(r.discoveryScore, 40);
    assert.equal(r.discoveryBand, "review");
  });

  it("20 OTP mails in one day count auth once (distinct month)", () => {
    const r = computeDiscoveryScore({
      authMonths: Array(20).fill("2024-06"),
    });
    assert.equal(r.discoveryScore, 35);
    assert.equal(r.familyScores.auth, 35);
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

  it("signup tiers distinguishable", () => {
    assert.equal(signupTierFromPhrase("이메일 인증이 완료"), "verification");
    assert.equal(signupTierFromPhrase("회원가입이 완료"), "welcome");
  });

  it("notification cap stays 15 (F5)", () => {
    const r = computeDiscoveryScore({
      notificationMonths: ["2024-01", "2024-02", "2024-03", "2024-04", "2024-05"],
    });
    assert.equal(r.familyScores.notification, 15);
  });
});

describe("SOW 004 R5 likely_closed", () => {
  it("closure newer than positive → likely_closed", () => {
    assert.equal(
      computeLikelyClosed({
        signup: { months: ["2023-01"], count: 1 },
        closure: { months: ["2024-06"], count: 1 },
      }),
      true
    );
  });

  it("closure older than positive → not likely_closed", () => {
    assert.equal(
      computeLikelyClosed({
        signup: { months: ["2024-08"], count: 1 },
        closure: { months: ["2023-01"], count: 1 },
      }),
      false
    );
  });
});
