/**
 * /api/classify-senders is a Gemini proxy on our quota (PRODUCT_SPEC §8, 2026-07-16). Same-origin
 * only stops another site's page from calling it in a browser; it never stopped a signed-out visitor
 * to our own page, and the route was harmless only for as long as it 503'd for want of a key.
 *
 * These assert the gate, not the classifier. The key is blanked for the duration: server.js loads
 * .env, so a developer with a real GEMINI_API_KEY would otherwise have this suite spending their
 * quota on every `npm test` — and the one assertion that needs the route to proceed would depend on
 * Google being up. With no key, past-auth lands on 503, and "401 before 503" is the whole claim.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createApp } from "../server/server.js";

let realKey;
before(() => {
  realKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "";
});
after(() => {
  if (realKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = realKey;
});

async function withServer(getSession, fn) {
  const app = createApp({ getSession });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

const BODY = {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ senders: [{ key: "dom:x.com", displayName: "X", email: "no-reply@x.com" }] }),
};

describe("/api/classify-senders auth", () => {
  it("refuses a signed-out caller", async () => {
    await withServer(
      async () => null,
      async (base) => {
        const res = await fetch(`${base}/api/classify-senders`, BODY);
        assert.equal(res.status, 401);
      }
    );
  });

  it("refuses a signed-out caller even with senders it could bill us for", async () => {
    await withServer(
      async () => null,
      async (base) => {
        const senders = Array.from({ length: 500 }, (_, i) => ({
          key: `dom:s${i}.com`,
          displayName: `S${i}`,
          email: `no-reply@s${i}.com`,
        }));
        const res = await fetch(`${base}/api/classify-senders`, {
          ...BODY,
          body: JSON.stringify({ senders }),
        });
        assert.equal(res.status, 401);
      }
    );
  });

  it("lets a signed-in caller through the gate", async () => {
    // 503 = past auth, stopped by the blanked key. Asserted exactly, not as "anything but 401":
    // the gate rejecting a valid session is the other way this breaks, and only a specific code
    // proves the request reached the step after it.
    await withServer(
      async () => ({ sub: "user-1", email: "u@example.com", name: "u", picture: null }),
      async (base) => {
        const res = await fetch(`${base}/api/classify-senders`, BODY);
        assert.equal(res.status, 503);
      }
    );
  });

  it("still refuses cross-origin before it looks at the session", async () => {
    await withServer(
      async () => ({ sub: "user-1", email: "u@example.com", name: "u", picture: null }),
      async (base) => {
        const res = await fetch(`${base}/api/classify-senders`, {
          ...BODY,
          headers: { ...BODY.headers, Origin: "https://evil.example" },
        });
        assert.equal(res.status, 403);
      }
    );
  });
});
