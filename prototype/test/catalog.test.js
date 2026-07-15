import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  matchService,
  upgradeCandidate,
  isStale,
  VALID_ROUTES,
  VALID_CATEGORIES,
} from "../public/catalog.js";
import { createAggregator } from "../public/filter.js";

const root = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(
  readFileSync(join(root, "../public/catalog.json"), "utf8")
);

function msg({
  from,
  subject = "",
  labelIds = [],
  internalDate = String(Date.UTC(2024, 5, 15)),
} = {}) {
  return {
    id: "m1",
    internalDate,
    labelIds,
    headers: { from, subject },
  };
}

describe("catalog matchService", () => {
  // SOW §5.1 #1 named coupang.com; coupang was excluded under E4 (no openable
  // official deletion how-to). Same predicate against a verified seed entry.
  it("matchService(spotify.com) → spotify entry (§5.1 #1, coupang substituted)", () => {
    const entry = matchService("spotify.com", catalog);
    assert.ok(entry);
    assert.equal(entry.service_id, "spotify");
  });

  it("matchService(unknown-shop.co.kr) → null", () => {
    assert.equal(matchService("unknown-shop.co.kr", catalog), null);
  });

  it("free_mailbox candidate is never catalog-matched (E2)", () => {
    const { add, snapshot } = createAggregator({
      selfEmail: "me@gmail.com",
    });
    add(
      msg({
        from: "Shop <shopname@naver.com>",
        subject: "회원가입이 완료되었습니다",
      })
    );
    const candidate = snapshot().services.find(
      (s) => s.registrableDomain === "naver.com"
    );
    assert.ok(candidate, "rescued naver.com candidate expected");
    assert.equal(candidate.linkBlockedBy, "free_mailbox");
    const upgraded = upgradeCandidate(candidate, catalog);
    assert.equal(upgraded.linkSafety, "none");
    assert.equal(upgraded.catalogEntry, null);
    assert.notEqual(upgraded.serviceId, "naver");
  });

  it("relay candidate is never catalog-matched (E2)", () => {
    const { add, snapshot } = createAggregator({
      selfEmail: "me@gmail.com",
    });
    add(msg({ from: "ESP <noreply@sendgrid.net>", subject: "hello" }));
    const candidate =
      snapshot().unresolved.find((s) => s.registrableDomain === "sendgrid.net") ||
      snapshot().services.find((s) => s.registrableDomain === "sendgrid.net");
    assert.ok(candidate);
    assert.equal(candidate.linkBlockedBy, "relay");
    const upgraded = upgradeCandidate(candidate, catalog);
    assert.equal(upgraded.linkSafety, "none");
    assert.equal(upgraded.catalogEntry, null);
  });

  it("matched candidate → linkSafety verified and siteUrl = entry.url", () => {
    const { add, snapshot } = createAggregator({
      selfEmail: "me@gmail.com",
    });
    add(
      msg({
        from: "Spotify <noreply@mail.spotify.com>",
        subject: "회원가입이 완료되었습니다",
      })
    );
    const candidate = snapshot().services.find(
      (s) => s.registrableDomain === "spotify.com"
    );
    assert.ok(candidate);
    assert.equal(candidate.linkSafety, "inferred");
    const entry = matchService("spotify.com", catalog);
    const upgraded = upgradeCandidate(candidate, catalog);
    assert.equal(upgraded.linkSafety, "verified");
    assert.equal(upgraded.siteUrl, entry.url);
    assert.equal(upgraded.serviceId, "spotify");
  });

  it("unmatched candidate keeps inferred", () => {
    const { add, snapshot } = createAggregator({
      selfEmail: "me@gmail.com",
    });
    add(
      msg({
        from: "Shop <a@unknown-shop.co.kr>",
        subject: "회원가입이 완료되었습니다",
      })
    );
    const candidate = snapshot().services.find(
      (s) => s.registrableDomain === "unknown-shop.co.kr"
    );
    assert.ok(candidate);
    const upgraded = upgradeCandidate(candidate, catalog);
    assert.equal(upgraded.linkSafety, "inferred");
    assert.equal(upgraded.siteUrl, "https://unknown-shop.co.kr");
    assert.equal(upgraded.catalogEntry, null);
  });
});

describe("catalog staleness and schema", () => {
  it("review_due_at in the past → stale (R5)", () => {
    const staleEntry = {
      review_due_at: "2020-01-01",
      last_verified_at: "2019-12-01",
    };
    assert.equal(isStale(staleEntry, new Date("2026-07-15T12:00:00Z")), true);
    const fresh = { review_due_at: "2099-01-01" };
    assert.equal(isStale(fresh, new Date("2026-07-15T12:00:00Z")), false);
  });

  it("every catalog entry has required fields and valid enums", () => {
    assert.ok(Array.isArray(catalog.services));
    assert.ok(catalog.services.length >= 8 && catalog.services.length <= 12);
    for (const entry of catalog.services) {
      assert.ok(entry.service_id);
      assert.ok(entry.official_source_url?.startsWith("http"));
      assert.ok(entry.last_verified_at);
      assert.ok(entry.review_due_at);
      assert.ok(VALID_ROUTES.has(entry.deletion_route), entry.service_id);
      assert.ok(VALID_CATEGORIES.has(entry.category), entry.service_id);
      assert.ok(entry.url);
      assert.ok(Array.isArray(entry.steps));
    }
    assert.ok(
      catalog.services.some((s) => s.deletion_route === "public_service"),
      "need at least one public_service"
    );
  });

  it("sender_domain_aliases are unique registrable domains", () => {
    const seen = new Map();
    for (const entry of catalog.services) {
      for (const alias of entry.sender_domain_aliases || []) {
        assert.ok(
          String(alias).includes("."),
          `alias should look registrable: ${alias}`
        );
        assert.ok(
          !String(alias).includes("/"),
          `alias must be a domain, not a path: ${alias}`
        );
        assert.equal(
          seen.has(alias),
          false,
          `domain claimed twice: ${alias} (${seen.get(alias)} vs ${entry.service_id})`
        );
        seen.set(alias, entry.service_id);
      }
    }
  });
});
