/**
 * SOW 001 §6 — cleanup labels API. Integration tests against the real Express
 * surface with an in-memory store (same contract as Supabase). Existing tests
 * are not touched.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createApp } from "../server/server.js";
import { createMemoryChoicesStore } from "../server/choices-db.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

describe("SOW 001 §6 cleanup labels API", () => {
  it("PUT then GET round-trips a label for the signed-in user", async () => {
    const store = createMemoryChoicesStore();
    await withServer(store, async () => sessionFor("user-a"), async (base) => {
      const put = await fetch(`${base}/api/choices/coupang.com`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          choice: "unused",
          cleanupScore: 90,
          cleanupBand: "recommended",
          discoveryScore: 75,
          discoveryBand: "high",
        }),
      });
      assert.equal(put.status, 200);
      assert.deepEqual(await json(put), { ok: true });

      const get = await fetch(`${base}/api/choices`);
      assert.equal(get.status, 200);
      const body = await json(get);
      assert.equal(body.choices["coupang.com"].choice, "unused");
      assert.ok(typeof body.choices["coupang.com"].labeledAt === "string");
      assert.ok(body.choices["coupang.com"].labeledAt.length > 0);
    });
  });

  it("GET returns empty choices object for a signed-in user with no labels (not 404)", async () => {
    const store = createMemoryChoicesStore();
    await withServer(store, async () => sessionFor("user-empty"), async (base) => {
      const get = await fetch(`${base}/api/choices`);
      assert.equal(get.status, 200);
      assert.deepEqual(await json(get), { choices: {} });
    });
  });

  it("a second user's session cannot read or write the first user's rows", async () => {
    const store = createMemoryChoicesStore();
    let current = "user-a";
    await withServer(store, async () => sessionFor(current), async (base) => {
      current = "user-a";
      const putA = await fetch(`${base}/api/choices/coupang.com`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ choice: "in_use" }),
      });
      assert.equal(putA.status, 200);

      current = "user-b";
      const getB = await fetch(`${base}/api/choices`);
      assert.equal(getB.status, 200);
      const bodyB = await json(getB);
      // Empty for B — not A's row, not 403 with a leak.
      assert.deepEqual(bodyB.choices, {});

      const putB = await fetch(`${base}/api/choices/coupang.com`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ choice: "unused" }),
      });
      assert.equal(putB.status, 200);

      current = "user-a";
      const getA = await fetch(`${base}/api/choices`);
      assert.equal(getA.status, 200);
      const bodyA = await json(getA);
      assert.equal(bodyA.choices["coupang.com"].choice, "in_use");
    });
  });

  it("a user_id supplied in the request body is ignored", async () => {
    const store = createMemoryChoicesStore();
    await withServer(store, async () => sessionFor("real-user"), async (base) => {
      const put = await fetch(`${base}/api/choices/naver.com`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          choice: "unused",
          user_id: "attacker-sub",
          userId: "attacker-sub",
        }),
      });
      assert.equal(put.status, 200);

      const rows = await store.listByUser("real-user");
      assert.equal(rows.length, 1);
      assert.equal(rows[0].domain, "naver.com");

      const attackerRows = await store.listByUser("attacker-sub");
      assert.equal(attackerRows.length, 0);
    });
  });

  it('PUT with choice: "banana" → 400, row unchanged', async () => {
    const store = createMemoryChoicesStore();
    await withServer(store, async () => sessionFor("user-a"), async (base) => {
      await fetch(`${base}/api/choices/coupang.com`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ choice: "unused" }),
      });

      const bad = await fetch(`${base}/api/choices/coupang.com`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ choice: "banana" }),
      });
      assert.equal(bad.status, 400);

      const get = await fetch(`${base}/api/choices`);
      const body = await json(get);
      assert.equal(body.choices["coupang.com"].choice, "unused");
    });
  });

  it("DELETE /api/me/data removes exactly that user's rows and no one else's", async () => {
    const store = createMemoryChoicesStore();
    let current = "user-a";
    await withServer(store, async () => sessionFor(current), async (base) => {
      current = "user-a";
      await fetch(`${base}/api/choices/coupang.com`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ choice: "unused" }),
      });
      await fetch(`${base}/api/choices/naver.com`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ choice: "in_use" }),
      });

      current = "user-b";
      await fetch(`${base}/api/choices/coupang.com`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ choice: "in_use" }),
      });

      current = "user-a";
      const del = await fetch(`${base}/api/me/data`, { method: "DELETE" });
      assert.equal(del.status, 200);
      assert.deepEqual(await json(del), { deleted: 2 });

      const getA = await fetch(`${base}/api/choices`);
      assert.deepEqual((await json(getA)).choices, {});

      current = "user-b";
      const getB = await fetch(`${base}/api/choices`);
      assert.equal((await json(getB)).choices["coupang.com"].choice, "in_use");
    });
  });

  it("unauthenticated request to every choices route → 401", async () => {
    const store = createMemoryChoicesStore();
    await withServer(store, async () => null, async (base) => {
      const routes = [
        ["GET", `${base}/api/choices`],
        [
          "PUT",
          `${base}/api/choices/coupang.com`,
          { choice: "unused" },
        ],
        ["DELETE", `${base}/api/choices/coupang.com`],
        ["DELETE", `${base}/api/me/data`],
      ];
      for (const [method, url, body] of routes) {
        const res = await fetch(url, {
          method,
          headers: body ? { "content-type": "application/json" } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        });
        assert.equal(res.status, 401, `${method} ${url} should be 401`);
      }
    });
  });

  it("app/.env.example lists every new Supabase key", () => {
    const example = readFileSync(path.resolve(__dirname, "../.env.example"), "utf8");
    assert.match(example, /SUPABASE_URL=/);
    assert.match(example, /SUPABASE_SERVICE_ROLE_KEY=/);
    assert.doesNotMatch(example, /NEXT_PUBLIC_.*SUPABASE/);
  });

  it("no *.supabase.co in server.js CSP", () => {
    const src = readFileSync(path.resolve(__dirname, "../server/server.js"), "utf8");
    const connectSrc = src.match(/"connect-src[^"]+"/);
    assert.ok(connectSrc, "connect-src directive present");
    assert.doesNotMatch(connectSrc[0], /supabase/i);
  });
});
