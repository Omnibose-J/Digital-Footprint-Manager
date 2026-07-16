import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveCancelLink, CANCEL_LABEL } from "../core/cancel-urls.js";

describe("resolveCancelLink", () => {
  it("maps known domains to their typed URLs", () => {
    const gh = resolveCancelLink("github.com", "GitHub");
    assert.equal(gh.type, "direct");
    assert.equal(gh.label, CANCEL_LABEL.direct);
    assert.equal(gh.url, "https://github.com/settings/admin");

    const vercel = resolveCancelLink("vercel.com", "Vercel");
    assert.equal(vercel.type, "settings");
    assert.equal(vercel.label, CANCEL_LABEL.settings);
    assert.equal(vercel.url, "https://vercel.com/account");
  });

  it("falls back to a search URL for unknown domains", () => {
    const r = resolveCancelLink("unknown-shop.co.kr", "Unknown Shop");
    assert.equal(r.type, "search");
    assert.equal(r.label, CANCEL_LABEL.search);
    assert.equal(
      r.url,
      "https://www.google.com/search?q=" + encodeURIComponent("Unknown Shop delete account")
    );
  });
});
