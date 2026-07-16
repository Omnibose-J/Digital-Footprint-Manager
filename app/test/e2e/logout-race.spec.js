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

/**
 * The same rule as above, one layer in: the labels, not the table.
 *
 * Clearing the table on logout is not clearing the session. `setLoggedOutUI` emptied the screen and
 * `cleanupChoices` was emptied in `refreshMe`'s logged-out branch — which the logout button never
 * reaches, because it calls `setLoggedOutUI` directly. So Alice's answers outlived Alice, invisibly,
 * and the next scan in the tab was where they reappeared.
 *
 * Bob's own labels are held on the wire on purpose. That gap — signed in, labels not back yet — is
 * the entire window, and the old code rendered Alice's into it.
 */
test("logging out drops the last user's labels, not just their screen", async ({ page }) => {
  await installFakeGoogle(page, { account: ALICE, messages: mailbox() });
  await page.addInitScript(() => {
    const id = window.google.accounts.id;
    const initialize = id.initialize;
    id.initialize = (cfg) => {
      window.__credentialCallback = cfg.callback;
      return initialize(cfg);
    };
  });

  await page.goto("/");
  await expect(page.locator("#appPanel")).toBeVisible();
  await page.click("#scan");

  const coupang = '#rows button[data-choice="delete"][data-domain="coupang.com"]';
  await page.locator(coupang).waitFor();
  await page.locator(coupang).click();
  await expect(page.locator(coupang), "Alice's own label should stick").toHaveClass(/is-on/);

  await page.click("#logout");
  await expect(page.locator("#loginPanel")).toBeVisible();

  // Bob's labels are parked, not merely slowed. A delay races the scan — and lost: the first
  // version of this test used 1500ms, Bob's empty labels landed before his rows rendered, and it
  // passed against the unfixed code. Holding the request and counting it is what makes the window
  // real, the same reason messages.get is parked above.
  //
  // Registered after the harness's route, so it wins: Playwright matches the newest handler first.
  let bobAsked = 0;
  let releaseChoices = () => {};
  const choicesHeld = new Promise((resolve) => {
    releaseChoices = resolve;
  });
  await page.route("**/api/choices", async (route) => {
    bobAsked += 1;
    await choicesHeld;
    await route.fulfill({ json: { choices: {} } });
  });
  await page.route("**/api/auth/login", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/me", (route) =>
    route.fulfill({ json: { loggedIn: true, email: BOB, name: "밥" } })
  );
  // Not awaited: awaiting the callback would wait out the 1500ms and skip past the only moment
  // this test is about.
  await page.evaluate(() => {
    window.__credentialCallback({ credential: "jwt-for-bob" });
  });
  await expect(page.locator("#appPanel")).toBeVisible();

  // Bob is signed in and his own labels are still on the wire. Assert that, rather than assume it.
  await expect.poll(() => bobAsked, { timeout: 10000 }).toBeGreaterThan(0);

  await page.click("#scan");
  await page.locator(coupang).waitFor();
  await expect(
    page.locator('#rows button[data-choice="delete"].is-on'),
    "Bob must not inherit Alice's 미사용"
  ).toHaveCount(0);

  releaseChoices();
});
