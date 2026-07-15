import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

/**
 * The boundary these guard is the product's whole promise. The screen says "메일이 서버로 가지
 * 않습니다", and an event like { service: "coupang.com" } would ship the account list to Google
 * Analytics instead, which is the thing the mail was only ever evidence for. A comment saying
 * "never send a domain" is not a control; this is.
 */

async function loadAnalytics() {
  const sent = [];
  const head = { appendChild() {} };
  globalThis.window = { dataLayer: [] };
  globalThis.document = { createElement: () => ({}), head };
  const mod = await import(`../frontend/analytics.js?t=${Math.random()}`);
  mod.initAnalytics("G-TEST");
  // gtag pushes arguments objects onto dataLayer; read the events back out of it.
  const events = () =>
    window.dataLayer
      .map((a) => Array.from(a))
      .filter((a) => a[0] === "event")
      .map((a) => ({ name: a[1], params: a[2] }));
  return { ...mod, events, sent };
}

describe("analytics never carries anything read out of the mailbox", () => {
  beforeEach(() => {
    delete globalThis.window;
    delete globalThis.document;
  });

  it("drops a domain, an address, and a service name", async () => {
    const { track, events } = await loadAnalytics();
    track("guide_opened", {
      band: "high",
      service: "coupang.com",
      sender: "no-reply@coupang.com",
      account: "beomjin1@g.skku.edu",
      siteUrl: "https://coupang.com",
    });
    const [ev] = events();
    assert.equal(ev.name, "guide_opened");
    assert.deepEqual(ev.params, { band: "high" });
  });

  it("keeps counts and booleans, which describe the product and not the user", async () => {
    const { track, events } = await loadAnalytics();
    track("scan_completed", { messages: 811, candidates: 62, high: 2, errors: 0, catalogued: true });
    assert.deepEqual(events()[0].params, {
      messages: 811,
      candidates: 62,
      high: 2,
      errors: 0,
      catalogued: true,
    });
  });

  it("a Korean service name is not a loophole: any long string is dropped", async () => {
    const { track, events } = await loadAnalytics();
    track("guide_opened", {
      band: "review",
      name: "성균관대학교 SW전문인재양성사업단",
      route: "self_service",
    });
    // route is a short enum we authored; the display name is the user's data.
    assert.deepEqual(events()[0].params, { band: "review", route: "self_service" });
  });

  it("an allowlisted key does not launder an unlisted value", async () => {
    // The realistic leak is a bug upstream, not malice: track("guide_opened", { band:
    // candidate.displayName }) passes a key we allow and a value we never wrote. Checking the key
    // alone would ship it, so the value is checked against the enum too.
    const { track, events } = await loadAnalytics();
    track("guide_opened", { band: "성균관대학교 SW전문인재양성사업단", route: "coupang.com" });
    assert.deepEqual(events()[0].params, {});
  });

  it("refuses GA's reserved prefixes", async () => {
    const { track, events } = await loadAnalytics();
    track("scan_completed", { google_x: 1, ga_y: 2, firebase_z: 3, messages: 5 });
    assert.deepEqual(events()[0].params, { messages: 5 });
  });

  it("sends nothing at all without a measurement id", async () => {
    globalThis.window = { dataLayer: [] };
    globalThis.document = { createElement: () => ({}), head: { appendChild() {} } };
    const mod = await import(`../frontend/analytics.js?t=${Math.random()}`);
    mod.initAnalytics("");
    mod.track("scan_completed", { messages: 811 });
    assert.equal(window.dataLayer.length, 0);
  });

  it("debug_mode is on for localhost and OFF everywhere else", async () => {
    // debug_mode on production tags real users' traffic as debug, which routes it into DebugView
    // and distorts the very reports it exists to verify. The default must be off, so the assertion
    // that matters is the production one.
    const configFor = async (hostname) => {
      delete globalThis.window;
      delete globalThis.document;
      globalThis.window = { dataLayer: [] };
      globalThis.document = { createElement: () => ({}), head: { appendChild() {} } };
      globalThis.location = { hostname };
      const mod = await import(`../frontend/analytics.js?t=${Math.random()}`);
      mod.initAnalytics("G-TEST");
      return window.dataLayer.map((a) => Array.from(a)).find((a) => a[0] === "config")[2];
    };

    assert.equal((await configFor("localhost")).debug_mode, true);
    assert.equal((await configFor("127.0.0.1")).debug_mode, true);
    assert.equal((await configFor("dfm-prototype.vercel.app")).debug_mode, undefined);
    assert.equal((await configFor("localhost.evil.com")).debug_mode, undefined);
    delete globalThis.location;
  });

  it("turns off ad signals and personalisation", async () => {
    const { events } = await loadAnalytics();
    const config = window.dataLayer.map((a) => Array.from(a)).find((a) => a[0] === "config");
    assert.equal(config[2].allow_google_signals, false);
    assert.equal(config[2].allow_ad_personalization_signals, false);
    assert.equal(events().length, 0);
  });
});
