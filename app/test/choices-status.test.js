/**
 * SOW 002 §3 / §3a — completion status on user_service_choice.
 * New tests only; does not edit SOW 001 tests.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../server/server.js";
import { createMemoryChoicesStore } from "../server/choices-db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function sessionFor(sub) {
  return {
    sub,
    email: `${sub}@example.com`,
    name: sub,
    picture: null,
  };
}

async function withServer(store, getSession, fn) {
  const app = createApp({ choicesDb: store, getSession });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

async function json(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

async function putLabel(base, domain, choice = "unused") {
  const res = await fetch(`${base}/api/choices/${domain}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ choice }),
  });
  assert.equal(res.status, 200);
}

describe("SOW 002 §3a completion status API", () => {
  it("withdrawn and unsubscribed are independently settable and persisted", async () => {
    const store = createMemoryChoicesStore();
    await withServer(store, async () => sessionFor("user-a"), async (base) => {
      await putLabel(base, "coupang.com");

      const w = await fetch(`${base}/api/choices/coupang.com/status`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ withdrawn: true }),
      });
      assert.equal(w.status, 200);
      const wBody = await json(w);
      assert.equal(wBody.ok, true);
      assert.ok(typeof wBody.withdrawnAt === "string" && wBody.withdrawnAt.length > 0);
      assert.equal(wBody.unsubscribedAt, null);

      const u = await fetch(`${base}/api/choices/coupang.com/status`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ unsubscribed: true }),
      });
      assert.equal(u.status, 200);
      const uBody = await json(u);
      assert.ok(typeof uBody.withdrawnAt === "string");
      assert.ok(typeof uBody.unsubscribedAt === "string" && uBody.unsubscribedAt.length > 0);
      // Clearing one must not clear the other.
      assert.notEqual(uBody.withdrawnAt, null);

      const get = await json(await fetch(`${base}/api/choices`));
      assert.equal(get.choices["coupang.com"].withdrawnAt, uBody.withdrawnAt);
      assert.equal(get.choices["coupang.com"].unsubscribedAt, uBody.unsubscribedAt);
    });
  });

  it("omitted fields leave the other completion alone; false clears to null", async () => {
    const store = createMemoryChoicesStore();
    await withServer(store, async () => sessionFor("user-a"), async (base) => {
      await putLabel(base, "naver.com");
      await fetch(`${base}/api/choices/naver.com/status`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ withdrawn: true, unsubscribed: true }),
      });

      const clearW = await json(
        await fetch(`${base}/api/choices/naver.com/status`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ withdrawn: false }),
        })
      );
      assert.equal(clearW.withdrawnAt, null);
      assert.ok(typeof clearW.unsubscribedAt === "string");

      const get = await json(await fetch(`${base}/api/choices`));
      assert.equal(get.choices["naver.com"].withdrawnAt, null);
      assert.ok(typeof get.choices["naver.com"].unsubscribedAt === "string");
    });
  });

  it("server stamps time — client timestamps in the body are ignored", async () => {
    const store = createMemoryChoicesStore();
    await withServer(store, async () => sessionFor("user-a"), async (base) => {
      await putLabel(base, "coupang.com");
      const before = Date.now();
      const res = await fetch(`${base}/api/choices/coupang.com/status`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          withdrawn: true,
          withdrawnAt: "1999-01-01T00:00:00.000Z",
          unsubscribedAt: "1999-01-01T00:00:00.000Z",
          labeled_at: "1999-01-01T00:00:00.000Z",
        }),
      });
      const after = Date.now();
      assert.equal(res.status, 200);
      const body = await json(res);
      assert.notEqual(body.withdrawnAt, "1999-01-01T00:00:00.000Z");
      const stamped = Date.parse(body.withdrawnAt);
      assert.ok(stamped >= before - 1000 && stamped <= after + 1000);
    });
  });

  it("PATCH without a label row → 404 and does not create a row", async () => {
    const store = createMemoryChoicesStore();
    await withServer(store, async () => sessionFor("user-a"), async (base) => {
      const res = await fetch(`${base}/api/choices/ghost.com/status`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ withdrawn: true }),
      });
      assert.equal(res.status, 404);
      assert.equal((await store.listByUser("user-a")).length, 0);
    });
  });

  it("body user_id is ignored on PATCH status", async () => {
    const store = createMemoryChoicesStore();
    await withServer(store, async () => sessionFor("real-user"), async (base) => {
      await putLabel(base, "coupang.com");
      const res = await fetch(`${base}/api/choices/coupang.com/status`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          withdrawn: true,
          user_id: "attacker-sub",
          userId: "attacker-sub",
        }),
      });
      assert.equal(res.status, 200);
      assert.equal((await store.listByUser("attacker-sub")).length, 0);
      const rows = await store.listByUser("real-user");
      assert.equal(rows.length, 1);
      assert.ok(rows[0].withdrawnAt);
    });
  });

  it("unauthenticated PATCH /status → 401", async () => {
    const store = createMemoryChoicesStore();
    await withServer(store, async () => null, async (base) => {
      const res = await fetch(`${base}/api/choices/coupang.com/status`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ withdrawn: true }),
      });
      assert.equal(res.status, 401);
    });
  });

  it("second user cannot patch the first user's status", async () => {
    const store = createMemoryChoicesStore();
    let current = "user-a";
    await withServer(store, async () => sessionFor(current), async (base) => {
      current = "user-a";
      await putLabel(base, "coupang.com");
      await fetch(`${base}/api/choices/coupang.com/status`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ withdrawn: true }),
      });

      current = "user-b";
      const patchB = await fetch(`${base}/api/choices/coupang.com/status`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ withdrawn: false }),
      });
      // No label row for B → 404, A's row untouched.
      assert.equal(patchB.status, 404);

      current = "user-a";
      const getA = await json(await fetch(`${base}/api/choices`));
      assert.ok(typeof getA.choices["coupang.com"].withdrawnAt === "string");
    });
  });

  it("SQL migration 002 adds both columns separately", () => {
    const sql = readFileSync(
      path.resolve(__dirname, "../server/sql/002_completion_timestamps.sql"),
      "utf8"
    );
    assert.match(sql, /withdrawn_at/);
    assert.match(sql, /unsubscribed_at/);
    assert.doesNotMatch(sql, /completed_at/);
  });
});
