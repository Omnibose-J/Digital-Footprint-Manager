import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeDiscoveryScore, computeLikelyClosed } from "../frontend/score.js";
import { classifyMessage } from "../frontend/filter.js";

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
