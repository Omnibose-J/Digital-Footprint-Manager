import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { headerMap, gmailFetch, isRateLimitReason } from "../public/scan.js";
import { authVerdict } from "../public/authenticity.js";
import { createAggregator } from "../public/filter.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

describe("SOW 005 R4 Authentication-Results array through headerMap", () => {
  it("upstream pass first + mx.google.com fail → dmarc_fail (never first-wins)", () => {
    const mapped = headerMap([
      {
        name: "Authentication-Results",
        value: "evil.example.com; dmarc=pass header.from=coupang.com",
      },
      {
        name: "Authentication-Results",
        value: "mx.google.com; dmarc=fail header.from=coupang.com",
      },
    ]);
    assert.ok(Array.isArray(mapped.authenticationResults));
    assert.equal(mapped.authenticationResults.length, 2);
    const r = authVerdict(mapped.authenticationResults, "coupang.com");
    assert.equal(r.pass, false);
    assert.equal(r.reason, "dmarc_fail");
  });
});

describe("SOW 005 R6 gmailFetch status handling", () => {
  it("isRateLimitReason only accepts rate-limit reasons", () => {
    assert.equal(isRateLimitReason("rateLimitExceeded"), true);
    assert.equal(isRateLimitReason("userRateLimitExceeded"), true);
    assert.equal(isRateLimitReason("insufficientPermissions"), false);
    assert.equal(isRateLimitReason(null), false);
  });

  it("403 insufficientPermissions does not look like a rate limit", async () => {
    const prev = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          error: { errors: [{ reason: "insufficientPermissions" }] },
        }),
        { status: 403 }
      );
    };
    try {
      await assert.rejects(
        () => gmailFetch("tok", "users/me/profile"),
        (err) => err.status === 403 && err.reason === "insufficientPermissions"
      );
      assert.equal(calls, 1);
      assert.equal(isRateLimitReason("insufficientPermissions"), false);
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("403 rateLimitExceeded is retryable by reason", async () => {
    const prev = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: { errors: [{ reason: "rateLimitExceeded" }] },
        }),
        { status: 403 }
      );
    try {
      await assert.rejects(
        () => gmailFetch("tok", "users/me/profile"),
        (err) => err.status === 403 && isRateLimitReason(err.reason)
      );
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("401 surfaces as unauthorized abort signal", async () => {
    const prev = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { status: "UNAUTHENTICATED" } }), {
        status: 401,
      });
    try {
      await assert.rejects(
        () => gmailFetch("tok", "users/me/profile"),
        (err) => err.status === 401
      );
    } finally {
      globalThis.fetch = prev;
    }
  });
});

describe("SOW 005 R7 selfEmail from Gmail profile account", () => {
  it("/api/me loggedIn:false must not be the selfEmail source — p.account is", () => {
    const meData = { loggedIn: false };
    // Simulate the fixed wiring: ignore meData.email, use p.account.
    const p = { account: "real.user@gmail.com" };
    const selfEmail = p.account; // app.js createAggregator({ selfEmail: p.account })
    assert.notEqual(meData.email || "", selfEmail);
    const agg = createAggregator({ selfEmail });
    agg.add({
      id: "1",
      internalDate: String(Date.UTC(2024, 0, 1)),
      labelIds: [],
      headers: { from: "Me <real.user@gmail.com>", subject: "note to self" },
    });
    const snap = agg.snapshot();
    assert.ok(snap.hidden.some((h) => h.hiddenRule === "self"));
    assert.equal(snap.services.length, 0);
  });

  it("app.js no longer seeds selfEmail from meData.email", () => {
    const root = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(root, "../public/app.js"), "utf8");
    assert.ok(src.includes("selfEmail: p.account"));
    assert.ok(!src.includes("selfEmail: meData.email"));
  });
});
