import { test, expect } from "@playwright/test";
import { installFakeGoogle, gmailMessage, authenticated, runScan } from "./harness.js";

/**
 * The phone, at the width most Korean users actually hold (iPhone 12/13/14/15 mini and the SE are
 * 375, the standard iPhone is 390, the Galaxy S is 360). 360 is checked because it is the tightest
 * of the three and anything that survives it survives the others.
 */
const PHONE = { width: 390, height: 844 };
const NARROW = { width: 360, height: 780 };

function mailbox() {
  return [
    gmailMessage({
      id: "p1",
      from: "Spotify <no-reply@spotify.com>",
      subject: "이메일 인증이 완료되었습니다",
      date: "2024-01-10",
      headers: authenticated("spotify.com"),
    }),
    gmailMessage({
      id: "p2",
      from: "Spotify <no-reply@spotify.com>",
      subject: "비밀번호 재설정 안내",
      date: "2024-03-10",
      headers: authenticated("spotify.com"),
    }),
    // The longest display name in the real 2026-07-15 scan. If anything overflows a 360px screen
    // it is this, and it is a real sender, not a stress-test string.
    gmailMessage({
      id: "p3",
      from: "Psychological Research Participation System @ SKKU <noreply@sona-systems.net>",
      subject: "가입이 완료되었습니다",
      date: "2025-11-02",
      headers: authenticated("sona-systems.net"),
    }),
  ];
}

/** Phone-sized BEFORE the first paint, the way a phone actually arrives. */
async function openAt(page, size) {
  await page.setViewportSize(size);
  await installFakeGoogle(page, { account: "tester@gmail.com", messages: mailbox() });
  await page.goto("/");
  await expect(page.locator("#appPanel")).toBeVisible();
}

test.describe("the phone", () => {
  for (const [label, size] of [
    ["390", PHONE],
    ["360", NARROW],
  ]) {
    test(`${label}px: the page itself never scrolls sideways`, async ({ page }) => {
      await openAt(page, size);
      await runScan(page);
      // The document is the thing that must not scroll horizontally. A table wider than the phone
      // is fine as long as the table is what scrolls, because the user can still read the page.
      const overflow = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        body: document.body.scrollWidth - document.body.clientWidth,
      }));
      expect(overflow.doc).toBeLessThanOrEqual(0);
      expect(overflow.body).toBeLessThanOrEqual(0);
    });
  }

  test("390px: the cancel link is reachable without scrolling the table sideways", async ({
    page,
  }) => {
    await openAt(page, PHONE);
    await runScan(page);
    const btn = page.locator("#rows tr", { hasText: "spotify.com" }).locator('a[data-out="cancel"]');
    await expect(btn).toBeVisible();

    // Visible to Playwright is not visible to a person: an element inside an overflow-x container
    // can sit past the right edge and still report visible. This asks where it actually is.
    const box = await btn.boundingBox();
    expect(box, "the cancel link has no box on a phone").toBeTruthy();
    expect(box.x + box.width, "the cancel link sits off the right edge of the phone").toBeLessThanOrEqual(
      PHONE.width
    );
  });

  test("390px: the cancel link is tappable and readable", async ({ page }) => {
    await openAt(page, PHONE);
    await runScan(page);

    const link = page.locator("#rows tr", { hasText: "spotify.com" }).locator('a[data-out="cancel"]');
    await expect(link).toBeVisible();
    const linkBox = await link.boundingBox();
    expect(linkBox.height, "cancel link is smaller than a fingertip").toBeGreaterThanOrEqual(44);
    expect(linkBox.x + linkBox.width).toBeLessThanOrEqual(PHONE.width);

    const paint = await link.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { color: cs.color, background: cs.backgroundColor, text: el.textContent.trim() };
    });
    expect(paint.text.length).toBeGreaterThan(0);
    expect(paint.color, "the cancel link's label is the same colour as the button").not.toBe(
      paint.background
    );
  });

  test("390px: the service name link stays on screen", async ({ page }) => {
    await openAt(page, PHONE);
    await runScan(page);
    const link = page.locator("#rows tr", { hasText: "spotify.com" }).locator('a[data-out="list"]');
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "https://spotify.com");
    const box = await link.boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
  });
});
