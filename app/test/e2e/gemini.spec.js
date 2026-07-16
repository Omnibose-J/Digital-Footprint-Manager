/**
 * PRODUCT_SPEC §8 (2026-07-16) — Gemini names a sender and does nothing else.
 *
 * The measured failure it exists for: Cursor's mail arrives from stripe.com, so the rules listed a
 * payment processor and the account the user actually has was never on screen under its own name.
 * The domain is the sender's mail estate, not the brand.
 *
 * The fences matter as much as the feature, so they are tested next to it: no score moves, and the
 * whole thing degrades to today's rules-only product when the route gives nothing back.
 */

import { test, expect } from "@playwright/test";
import { installFakeGoogle, gmailMessage, authenticated, runScan, readTable } from "./harness.js";

const SELF = "tester@gmail.com";

/**
 * Stripe's estate, two accounts behind it. The exact shape the rules cannot resolve: one domain, one
 * address, and the only thing separating Cursor from Notion is the display name.
 */
function mailbox() {
  return [
    gmailMessage({
      id: "g1",
      from: "Cursor via Stripe <receipts@stripe.com>",
      subject: "결제가 완료되었습니다",
      date: "2024-02-01",
      headers: authenticated("stripe.com"),
    }),
    gmailMessage({
      id: "g2",
      from: "Cursor via Stripe <receipts@stripe.com>",
      subject: "이메일 인증이 완료되었습니다",
      date: "2024-03-01",
      headers: authenticated("stripe.com"),
    }),
    gmailMessage({
      id: "g3",
      from: "Notion via Stripe <receipts@stripe.com>",
      subject: "결제가 완료되었습니다",
      date: "2024-04-01",
      headers: authenticated("stripe.com"),
    }),
  ];
}

const CURSOR = {
  "dom:stripe.com": {
    category: "가입서비스",
    realService: "Cursor",
    reason: "결제 대행사를 통해 오는 구독 서비스 메일",
  },
};

test.describe("Gemini names the sender", () => {
  test("it is sent every name the domain sent under, not just the one the row prints", async ({ page }) => {
    // The row shows one name because a cell holds one name. The classifier needs all of them: this
    // mailbox has Cursor and Notion behind a single Stripe address, and mostFrequentName's winner is
    // the one fact that identifies neither. Sending only that was the bug — asserted here on the
    // request body, because that is the only place the difference exists.
    await installFakeGoogle(page, { account: SELF, messages: mailbox(), classify: CURSOR });
    await page.goto("/");

    const [req] = await Promise.all([
      page.waitForRequest((r) => r.url().includes("/api/classify-senders") && r.method() === "POST"),
      runScan(page),
    ]);

    const stripe = req.postDataJSON().senders.find((s) => s.email.includes("stripe.com"));
    expect(stripe, "stripe.com should reach the classifier").toBeTruthy();
    expect(stripe.names).toContain("Cursor via Stripe");
    expect(stripe.names).toContain("Notion via Stripe");
    // Still the address, still no subject: §3's boundary did not move to make this work.
    expect(stripe.email).toBe("receipts@stripe.com");
    expect(JSON.stringify(req.postDataJSON())).not.toContain("결제가 완료되었습니다");
  });

  test("renames a row whose domain belongs to someone else's mail estate", async ({ page }) => {
    await installFakeGoogle(page, { account: SELF, messages: mailbox(), classify: CURSOR });
    await page.goto("/");
    await runScan(page);

    const row = page.locator("#rows tr", { hasText: "stripe.com" });
    // The name is Gemini's; the domain under it is still ours, because the row is keyed, scored and
    // grouped by that domain and pretending otherwise would make the two disagree.
    await expect(row.locator(".service-name")).toHaveText("Cursor");
    await expect(row).toContainText("stripe.com");
  });

  test("its sentence fills 비고 where our own axes have nothing to say", async ({ page }) => {
    await installFakeGoogle(page, { account: SELF, messages: mailbox(), classify: CURSOR });
    await page.goto("/");
    await runScan(page);

    const row = page.locator("#rows tr", { hasText: "stripe.com" });
    await expect(row.locator(".why-inferred")).toHaveText("결제 대행사를 통해 오는 구독 서비스 메일");
  });

  test("names do not move scores: the row ranks exactly as the rules left it", async ({ page }) => {
    // §5's surviving clause. Run the same mailbox twice — once with Gemini answering, once with it
    // silent — and every column the rules own must be identical. If a name could change a band, the
    // LLM would be in discovery, which is the thing §8 refused.
    await installFakeGoogle(page, { account: SELF, messages: mailbox(), classify: {} });
    await page.goto("/");
    const without = await runScan(page);

    await page.context().clearCookies();
    await installFakeGoogle(page, { account: SELF, messages: mailbox(), classify: CURSOR });
    await page.goto("/");
    const with_ = await runScan(page);

    expect(with_.services.length).toBe(without.services.length);
    expect(with_.services[0].domain).toBe(without.services[0].domain);
    expect(with_.services[0].month).toBe(without.services[0].month);
    expect(with_.services[0].count).toBe(without.services[0].count);
    // 비고 differs by exactly the inferred sentence, and the computed part is untouched.
    expect(without.services[0].remark).not.toContain("결제 대행사");
  });

  test("a silent classifier leaves the rules-only product standing", async ({ page }) => {
    // What a missing key or an outage looks like. It must be indistinguishable from before Gemini
    // existed — no error, no empty name, no gap where a row should be.
    await installFakeGoogle(page, { account: SELF, messages: mailbox(), classify: {} });
    await page.goto("/");
    const view = await runScan(page);

    expect(view.err).toBe("");
    expect(view.services.length).toBeGreaterThan(0);
    // The rules' own answer: mostFrequentName's winner, verbatim off the header. It is not wrong,
    // it is just the relay's label rather than the account's — which is the whole reason Gemini is
    // wired in, and exactly what the user sees when it cannot answer.
    await expect(page.locator("#rows tr", { hasText: "stripe.com" }).locator(".service-name")).toHaveText(
      "Cursor via Stripe"
    );
    await expect(page.locator(".why-inferred")).toHaveCount(0);
  });
});
