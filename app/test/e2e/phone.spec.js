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

  test("390px: the withdraw button is reachable without scrolling the table sideways", async ({
    page,
  }) => {
    await openAt(page, PHONE);
    await runScan(page);
    const btn = page.locator("#rows tr", { hasText: "spotify.com" }).getByRole("button");
    await expect(btn).toBeVisible();

    // Visible to Playwright is not visible to a person: an element inside an overflow-x container
    // can sit past the right edge and still report visible. This asks where it actually is.
    const box = await btn.boundingBox();
    expect(box, "the withdraw button has no box on a phone").toBeTruthy();
    expect(box.x + box.width, "the withdraw button sits off the right edge of the phone").toBeLessThanOrEqual(
      PHONE.width
    );
  });

  test("390px: the guide modal fits, and its route link is tappable", async ({ page }) => {
    await openAt(page, PHONE);
    await runScan(page);
    await page.locator("#rows tr", { hasText: "spotify.com" }).getByRole("button").click();

    const dialog = page.locator(".modal-dialog");
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box.width).toBeLessThanOrEqual(PHONE.width);
    expect(box.x).toBeGreaterThanOrEqual(0);

    // 44px is Apple's minimum touch target and the one Android's 48dp rounds to. A link people are
    // meant to follow to actually close an account should not need a careful tap.
    const link = page.locator('#guideBody a[data-out="route"]');
    const linkBox = await link.boundingBox();
    expect(linkBox.height, "route link is smaller than a fingertip").toBeGreaterThanOrEqual(44);
    expect(linkBox.x + linkBox.width).toBeLessThanOrEqual(PHONE.width);

    // The first version of this test passed while the label was invisible: .guide-section a beats
    // .btn-primary on specificity, so the text was painted accent-on-accent. Size and position say
    // nothing about whether a person can read the thing.
    const paint = await link.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { color: cs.color, background: cs.backgroundColor, text: el.textContent.trim() };
    });
    expect(paint.text.length).toBeGreaterThan(0);
    expect(paint.color, "the route button's label is the same colour as the button").not.toBe(
      paint.background
    );
  });

  test("390px: the template is readable without a horizontal scrollbar of its own", async ({
    page,
  }) => {
    await openAt(page, PHONE);
    await runScan(page);
    await page.locator("#rows tr", { hasText: "spotify.com" }).getByRole("button").click();
    await page.locator("summary", { hasText: "개인정보 삭제 요청문" }).click();

    // <pre> does not wrap by default, and this one holds Korean sentences long enough to run off
    // any phone. It is the thing the user is meant to copy and send.
    const pre = page.locator("#guideTemplateText");
    await expect(pre).toBeVisible();
    const overflow = await pre.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow, "the request template scrolls sideways inside the modal").toBeLessThanOrEqual(1);
  });
});
