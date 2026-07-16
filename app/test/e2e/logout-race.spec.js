/**
 * Logging out mid-scan, with reads still in flight.
 *
 * The product's whole trust argument is that the mailbox stays in the browser. That argument dies
 * if the browser hands one user's mailbox to the next one, and a shared or family PC is exactly
 * where this product gets used. Logout is not a navigation here — it is a DOM swap in a single
 * page — so whatever a late callback writes is still on screen when the next person signs in.
 *
 * The scan is parked at messages.get on purpose: that is the real window, since a scan the user
 * abandons is a slow scan by definition.
 */
import { test, expect } from "@playwright/test";
import { installFakeGoogle, gmailMessage, authenticated } from "./harness.js";

const ALICE = "alice@gmail.com";
const BOB = "bob@gmail.com";

function mailbox() {
  return [
    gmailMessage({
      id: "m1",
      from: "no-reply@coupang.com",
      subject: "쿠팡 가입을 환영합니다",
      date: "2024-10-01",
      headers: authenticated("coupang.com"),
    }),
    gmailMessage({
      id: "m2",
      from: "no-reply@spotify.com",
      subject: "Spotify 가입이 완료되었습니다",
      date: "2024-10-02",
      headers: authenticated("spotify.com"),
    }),
  ];
}

/** Domains the table is holding, whether or not a panel currently hides it. */
function tableDomains(page) {
  return page.evaluate(() =>
    [...document.getElementById("rows").children].map((tr) => tr.children[2]?.innerText.trim())
  );
}

test("a scan that lands after logout never reaches the next user in the same tab", async ({ page }) => {
  await installFakeGoogle(page, { account: ALICE, messages: mailbox() });

  // Sign the second user in without reloading. A reload resets module state, which is why this
  // bug survives manual testing: refreshing between accounts hides it.
  await page.addInitScript(() => {
    const id = window.google.accounts.id;
    const initialize = id.initialize;
    id.initialize = (cfg) => {
      window.__credentialCallback = cfg.callback;
      return initialize(cfg);
    };
  });

  // Park every messages.get. Counting them is what proves the reads are genuinely in flight when
  // the logout lands — a timing assumption would make this test lie when it passes.
  let parked = 0;
  let release = () => {};
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**gmail.googleapis.com/**", async (route) => {
    if (/\/messages\/[^/?]+\?/.test(route.request().url())) {
      parked += 1;
      await held;
    }
    await route.fallback();
  });

  await page.goto("/");
  await expect(page.locator("#appPanel")).toBeVisible();

  await page.click("#scan");
  await expect.poll(() => parked, { timeout: 10000 }).toBeGreaterThan(0);

  await page.click("#logout");
  await expect(page.locator("#loginPanel")).toBeVisible();
  expect(await tableDomains(page), "logout must clear the table").toEqual([]);

  // Alice's reads come back now — after she left.
  release();
  await page.waitForTimeout(1500);

  expect(await tableDomains(page), "a late scan callback must not repopulate the table").toEqual([]);

  // Bob signs in on the same tab.
  await page.route("**/api/auth/login", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/me", (route) =>
    route.fulfill({ json: { loggedIn: true, email: BOB, name: "밥" } })
  );
  await page.evaluate(() => window.__credentialCallback({ credential: "jwt-for-bob" }));
  await expect(page.locator("#appPanel")).toBeVisible();

  expect(await tableDomains(page), "Bob must not inherit Alice's services").toEqual([]);
  await expect(page.locator("#meta"), "Bob must not see Alice's Gmail address").not.toContainText(ALICE);
});
