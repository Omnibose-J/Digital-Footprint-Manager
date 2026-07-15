import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  headerMap,
  gmailFetch,
  isRateLimitReason,
  shouldRetryGmail,
  collectSenders,
} from "../frontend/scan.js";
import { authVerdict } from "../frontend/authenticity.js";
import { createAggregator } from "../frontend/filter.js";

/**
 * Stub Gmail so collectSenders can be driven end to end. `perMessage` decides what each
 * messages.get answers, which is where the retry and abort branches actually live.
 */
function stubGmail({ messageIds = ["m1"], perMessage }) {
  const calls = { profile: 0, list: 0, get: 0 };
  const prev = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const ok = (body) => new Response(JSON.stringify(body), { status: 200 });
    if (u.includes("/profile")) {
      calls.profile += 1;
      return ok({ emailAddress: "me@gmail.com", messagesTotal: messageIds.length });
    }
    if (u.includes("/messages?") || /\/messages\?/.test(u) || u.endsWith("/messages")) {
      calls.list += 1;
      return ok({ messages: messageIds.map((id) => ({ id })) });
    }
    calls.get += 1;
    return perMessage(calls.get);
  };
  return { calls, restore: () => (globalThis.fetch = prev) };
}

const errBody = (reason) =>
  new Response(JSON.stringify({ error: { errors: [{ reason }] } }), { status: 403 });

describe("SOW 005 R4 Authentication-Results array through headerMap", () => {
  it("upstream pass first + mx.google.com fail → dmarc_fail (never first-wins)", () => {
    const mapped = headerMap([
      { name: "Authentication-Results", value: "evil.example.com; dmarc=pass header.from=coupang.com" },
      { name: "Authentication-Results", value: "mx.google.com; dmarc=fail header.from=coupang.com" },
    ]);
    assert.ok(Array.isArray(mapped.authenticationResults));
    assert.equal(mapped.authenticationResults.length, 2);
    const r = authVerdict(mapped.authenticationResults, "coupang.com");
    assert.equal(r.pass, false);
    assert.equal(r.reason, "dmarc_fail");
  });

  it("the real defect was a false negative: gmail's block second must still be read", () => {
    // Before R4 only the first instance survived headerMap, so this scored as unauthenticated
    // even though Gmail passed it. The old code failed closed, it did not let evil vouch.
    const mapped = headerMap([
      { name: "Authentication-Results", value: "relay.example.net; spf=pass smtp.mailfrom=coupang.com" },
      { name: "Authentication-Results", value: "mx.google.com; dmarc=pass header.from=coupang.com" },
    ]);
    const r = authVerdict(mapped.authenticationResults, "coupang.com");
    assert.equal(r.pass, true);
    assert.equal(r.reason, "dmarc_pass");
  });
});

describe("SOW 005 R6 retry decision", () => {
  it("isRateLimitReason only accepts rate-limit reasons", () => {
    assert.equal(isRateLimitReason("rateLimitExceeded"), true);
    assert.equal(isRateLimitReason("userRateLimitExceeded"), true);
    assert.equal(isRateLimitReason("insufficientPermissions"), false);
    assert.equal(isRateLimitReason(null), false);
  });

  it("shouldRetryGmail: 403 is retried only when the body says rate limit", () => {
    assert.equal(shouldRetryGmail({ status: 403, reason: "rateLimitExceeded" }, 1), true);
    assert.equal(shouldRetryGmail({ status: 403, reason: "insufficientPermissions" }, 1), false);
    assert.equal(shouldRetryGmail({ status: 429 }, 1), true);
    assert.equal(shouldRetryGmail({ status: 401 }, 1), false);
    assert.equal(shouldRetryGmail({ status: 403, reason: "rateLimitExceeded" }, 4), false);
  });

  it("gmailFetch surfaces the reason from the body", async () => {
    const s = stubGmail({ perMessage: () => errBody("insufficientPermissions") });
    try {
      await assert.rejects(
        () => gmailFetch("tok", "users/me/messages/m1"),
        (err) => err.status === 403 && err.reason === "insufficientPermissions"
      );
    } finally {
      s.restore();
    }
  });
});

describe("SOW 005 R6 collectSenders retry and abort behaviour", () => {
  it("a permanent 403 is fetched once, not four times", async () => {
    const s = stubGmail({ perMessage: () => errBody("insufficientPermissions") });
    try {
      const r = await collectSenders("tok", { concurrency: 1 });
      assert.equal(s.calls.get, 1, "insufficientPermissions must not be retried");
      assert.equal(r.errors, 1);
      assert.equal(r.fetched, 0);
    } finally {
      s.restore();
    }
  });

  it("a rate-limited 403 is retried up to four attempts", async () => {
    const s = stubGmail({ perMessage: () => errBody("rateLimitExceeded") });
    try {
      await collectSenders("tok", { concurrency: 1 });
      assert.equal(s.calls.get, 4, "rate limits must be retried");
    } finally {
      s.restore();
    }
  });

  it("401 aborts the scan instead of counting every remaining message as an error", async () => {
    const s = stubGmail({
      messageIds: ["m1", "m2", "m3", "m4", "m5"],
      perMessage: () => new Response("{}", { status: 401 }),
    });
    try {
      await assert.rejects(
        () => collectSenders("tok", { concurrency: 1 }),
        (err) => /Gmail 인증이 만료/.test(err.message)
      );
      assert.ok(s.calls.get < 5, `aborted early, got ${s.calls.get} fetches`);
    } finally {
      s.restore();
    }
  });
});

describe("SOW 005 R7 selfEmail comes from the Gmail profile", () => {
  it("onProfile fires before any onMessage, so the aggregator can never be missing", async () => {
    const order = [];
    const s = stubGmail({
      messageIds: ["m1", "m2"],
      perMessage: () =>
        new Response(
          JSON.stringify({
            internalDate: String(Date.UTC(2024, 0, 1)),
            labelIds: [],
            payload: { headers: [{ name: "From", value: "Me <me@gmail.com>" }] },
          }),
          { status: 200 }
        ),
    });
    try {
      await collectSenders("tok", {
        concurrency: 1,
        onProfile: ({ account }) => order.push(`profile:${account}`),
        onMessage: () => order.push("message"),
      });
    } finally {
      s.restore();
    }
    assert.equal(order[0], "profile:me@gmail.com");
    assert.equal(order.filter((o) => o.startsWith("profile:")).length, 1);
    assert.ok(order.slice(1).every((o) => o === "message"));
  });

  it("the profile address, not the app session, is what excludes the user's own mail", () => {
    // /api/me answers {loggedIn:false} with a 200 when the session expires; seeding selfEmail
    // from it yields "", the self rule no-ops, and the user's own address becomes a service.
    const agg = createAggregator({ selfEmail: "me@gmail.com" });
    const bare = createAggregator({ selfEmail: "" });
    const msg = {
      id: "1",
      internalDate: String(Date.UTC(2024, 0, 1)),
      labelIds: [],
      headers: { from: "Me <me@gmail.com>", subject: "note to self" },
    };
    agg.add(msg);
    bare.add({ ...msg });

    assert.ok(agg.snapshot().hidden.some((h) => h.hiddenRule === "self"));
    assert.equal(agg.snapshot().services.length, 0);
    assert.equal(bare.snapshot().hidden.filter((h) => h.hiddenRule === "self").length, 0);
  });
});
