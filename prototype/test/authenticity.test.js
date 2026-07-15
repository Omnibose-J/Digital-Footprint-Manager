import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { authVerdict, splitAuthservBlocks } from "../public/authenticity.js";

describe("SOW 004 R1 authenticity gate", () => {
  it("absent header → not pass, reason no_authserv_id", () => {
    const r = authVerdict(undefined, "coupang.com");
    assert.equal(r.pass, false);
    assert.equal(r.reason, "no_authserv_id");
  });

  it("mx.google.com dmarc=pass header.from=coupang.com → pass", () => {
    const r = authVerdict(
      "mx.google.com; dkim=pass header.d=coupang.com; dmarc=pass header.from=coupang.com",
      "coupang.com"
    );
    assert.equal(r.pass, true);
    assert.equal(r.reason, "dmarc_pass");
  });

  it("upstream pass + mx.google.com fail → fail (only Gmail read)", () => {
    const r = authVerdict(
      [
        "evil.example.com; dmarc=pass header.from=coupang.com",
        "mx.google.com; dmarc=fail header.from=coupang.com",
      ],
      "coupang.com"
    );
    assert.equal(r.pass, false);
    assert.ok(r.reason === "dmarc_fail" || r.reason === "no_pass");
  });

  it("never takes the first authserv-id when it is not mx.google.com", () => {
    const blocks = splitAuthservBlocks(
      "upstream.mail; dmarc=pass header.from=x.com\nmx.google.com; dmarc=pass header.from=x.com"
    );
    assert.ok(blocks.length >= 2);
    assert.equal(blocks[0].authservId, "upstream.mail");
    assert.ok(blocks.some((b) => b.authservId === "mx.google.com"));
    const r = authVerdict(
      "upstream.mail; dmarc=pass header.from=x.com\nmx.google.com; dmarc=fail header.from=x.com",
      "x.com"
    );
    assert.equal(r.pass, false);
  });

  it("ARC-Authentication-Results alone is not a pass (R1)", () => {
    // Callers must not feed ARC-*; empty Authentication-Results ⇒ not pass.
    const r = authVerdict(null, "coupang.com");
    assert.equal(r.pass, false);
    // Even if ARC-shaped text is mistakenly passed without mx.google.com:
    const r2 = authVerdict(
      "arc.example.com; dmarc=pass header.from=coupang.com",
      "coupang.com"
    );
    assert.equal(r2.pass, false);
  });

  it("multiple dkim= with different header.d= are all parsed", () => {
    const r = authVerdict(
      "mx.google.com; dkim=pass header.d=mailer.coupang.com; dkim=pass header.d=coupang.com; dmarc=pass header.from=coupang.com",
      "coupang.com"
    );
    assert.equal(r.pass, true);
    assert.ok(Array.isArray(r.dkimResults));
    assert.ok(r.dkimResults.length >= 2);
    const domains = r.dkimResults.map((d) => d.headerD);
    assert.ok(domains.includes("mailer.coupang.com"));
    assert.ok(domains.includes("coupang.com"));
  });
});
