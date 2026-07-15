import { test, expect } from "@playwright/test";
import { installFakeGoogle, gmailMessage, authenticated, runScan, readTable } from "./harness.js";

const SELF = "tester@gmail.com";

/** A mailbox shaped like the real one this product was measured against. */
function mailbox() {
  return [
    // A service with signup + auth: the only shape that reached high before the auth fix.
    gmailMessage({
      id: "m1",
      from: "Spotify <no-reply@spotify.com>",
      subject: "이메일 인증이 완료되었습니다",
      date: "2024-01-10",
      headers: authenticated("spotify.com"),
    }),
    gmailMessage({
      id: "m2",
      from: "Spotify <no-reply@spotify.com>",
      subject: "비밀번호 재설정 안내",
      date: "2024-03-10",
      headers: authenticated("spotify.com"),
    }),
    // An old account with no signup mail left: auth across three months plus notifications.
    // This is the GitHub case, 65 points and capped, until auth started accumulating.
    gmailMessage({
      id: "m3",
      from: "GitHub <noreply@github.com>",
      subject: "비밀번호가 변경되었습니다",
      date: "2023-04-01",
      headers: authenticated("github.com"),
    }),
    gmailMessage({
      id: "m4",
      from: "GitHub <noreply@github.com>",
      subject: "새로운 기기에서 로그인",
      date: "2024-01-05",
      headers: authenticated("github.com"),
    }),
    gmailMessage({
      id: "m5",
      from: "GitHub <noreply@github.com>",
      subject: "임시 비밀번호 발급 안내",
      date: "2025-06-02",
      headers: authenticated("github.com"),
    }),
    gmailMessage({
      id: "m6",
      from: "GitHub <noreply@github.com>",
      subject: "휴면계정 전환 안내",
      date: "2024-02-01",
      labelIds: ["CATEGORY_UPDATES"],
      headers: authenticated("github.com"),
    }),
    gmailMessage({
      id: "m7",
      from: "GitHub <noreply@github.com>",
      subject: "개인정보 이용내역 안내",
      date: "2024-03-01",
      headers: authenticated("github.com"),
    }),
    gmailMessage({
      id: "m8",
      from: "GitHub <noreply@github.com>",
      subject: "이용약관 개정 안내",
      date: "2024-04-01",
      headers: authenticated("github.com"),
    }),
    gmailMessage({
      id: "m9",
      from: "GitHub <noreply@github.com>",
      subject: "이번 주 새 소식",
      date: "2024-05-01",
      labelIds: ["CATEGORY_PROMOTIONS"],
      headers: authenticated("github.com"),
    }),
    // A person, not a service. Must be excluded, not listed.
    gmailMessage({
      id: "m10",
      from: "김철수 <chulsoo@gmail.com>",
      subject: "안녕하세요",
      date: "2025-02-01",
      headers: authenticated("gmail.com"),
    }),
    // The user's own address. MAJOR 1: this must not take the whole domain down with it.
    gmailMessage({
      id: "m11",
      from: `테스터 <${SELF}>`,
      subject: "메모",
      date: "2025-02-02",
      headers: authenticated("gmail.com"),
    }),
    // A closed account: closure newer than the signup that precedes it.
    gmailMessage({
      id: "m12",
      from: "옥션 <no-reply@auction.co.kr>",
      subject: "회원가입이 완료되었습니다",
      date: "2022-01-01",
      headers: authenticated("auction.co.kr"),
    }),
    gmailMessage({
      id: "m13",
      from: "옥션 <no-reply@auction.co.kr>",
      subject: "[옥션] 회원탈퇴 처리 완료 및 환불 안내",
      date: "2023-05-01",
      headers: authenticated("auction.co.kr"),
    }),
  ];
}

test.describe("the scan a user actually sees", () => {
  test.beforeEach(async ({ page }) => {
    await installFakeGoogle(page, { account: SELF, messages: mailbox() });
    await page.goto("/");
    await expect(page.locator("#appPanel")).toBeVisible();
  });

  test("a signed-in user scans and gets scored candidates", async ({ page }) => {
    const view = await runScan(page);

    expect(view.err).toBe("");
    expect(view.progress).toContain("완료:");
    expect(view.services.length).toBeGreaterThan(0);

    const spotify = view.services.find((s) => s.domain === "spotify.com");
    expect(spotify, "spotify should be a candidate").toBeTruthy();
    // verification 55 + auth 35 = 90
    expect(spotify.band).toContain("높음");
    expect(spotify.band).toContain("이메일 인증 완료");
    expect(spotify.band).toContain("비밀번호 재설정");
  });

  test("an old account with no signup mail still reaches high on auth alone plus corroboration", async ({ page }) => {
    // The measured failure this exists to guard: GitHub sat at 65 because auth froze at 45.
    const view = await runScan(page);
    const gh = view.services.find((s) => s.domain === "github.com");
    expect(gh).toBeTruthy();
    expect(gh.band).not.toContain("가입");
    expect(gh.band).toContain("높음");
  });

  test("a person is excluded and the user's own address does not take its domain with it", async ({ page }) => {
    const view = await runScan(page);

    expect(view.services.some((s) => s.name.includes("김철수"))).toBe(false);
    expect(view.excluded.some((s) => s.name.includes("김철수") && s.reason === "개인 메일함")).toBe(true);
    expect(view.excluded.some((s) => s.reason === "본인 주소")).toBe(true);
    // MAJOR 1: self is keyed per address, so gmail.com survives as a bucket for others.
    expect(view.excluded.filter((s) => s.domain === "gmail.com").length).toBe(2);
  });

  test("a withdrawal confirmation newer than the signup marks the account closed", async ({ page }) => {
    const view = await runScan(page);
    const auction = view.services.find((s) => s.domain === "auction.co.kr");
    expect(auction).toBeTruthy();
    // The badge lives in the 탈퇴 column, not the 신뢰 one: it answers "can I leave", not
    // "how sure are we you joined". It used to render in both.
    expect(auction.action).toContain("폐쇄 추정");
    expect(auction.band).not.toContain("폐쇄 추정");
  });

  test("the guide modal opens with the catalog's verified content", async ({ page }) => {
    await runScan(page);
    const row = page.locator("#rows tr", { hasText: "spotify.com" });
    await row.getByRole("button").click();

    const modal = page.locator("#guideModal");
    await expect(modal).toBeVisible();
    await expect(modal).toContainText("Spotify");
    await expect(modal).toContainText("탈퇴 경로");
    await expect(modal).toContainText("탈퇴 전 체크리스트");
    // The warning the whole product exists to make: deactivate is not deletion.
    await expect(modal).toContainText("비활성화가 곧 삭제는 아닙니다");
    // Verified, not inferred: this domain is in the catalog and was read against its source.
    await expect(modal).toContainText("verified");

    await page.click("#guideClose");
    await expect(modal).toBeHidden();
  });

  test("the list leads with what to clean up, not with what we are surest about", async ({ page }) => {
    // The whole point of the reorder. Spotify (2024, dormant) and GitHub (2025, recent) are both
    // high-band, and confidence alone put GitHub near the top: the account being used every day.
    const view = await runScan(page);
    const ranked = view.services.filter((s) => !s.priority.startsWith("—"));
    expect(ranked.length).toBeGreaterThan(0);

    const scoreOf = (s) => Number(/\d+/.exec(s.priority)?.[0] ?? -1);
    for (let i = 1; i < ranked.length; i++) {
      expect(scoreOf(ranked[i - 1])).toBeGreaterThanOrEqual(scoreOf(ranked[i]));
    }
    // Unranked rows sink below every ranked one instead of mixing in.
    const firstUnranked = view.services.findIndex((s) => s.priority.startsWith("—"));
    if (firstUnranked !== -1) {
      expect(view.services.slice(firstUnranked).every((s) => s.priority.startsWith("—"))).toBe(true);
    }
  });

  test("a row we are not sure about shows a dash, not a rank of zero", async ({ page }) => {
    // "Not ranked" and "ranked last" are different sentences. §4 scores only high-band.
    const view = await runScan(page);
    const unsure = view.services.find((s) => !s.band.startsWith("높음"));
    expect(unsure).toBeTruthy();
    expect(unsure.priority).toContain("—");
  });

  test("an account with recent traces is never recommended, however sure we are of it", async ({ page }) => {
    // GitHub is the highest-confidence row in this mailbox and the one most obviously in use.
    const view = await runScan(page);
    const gh = view.services.find((s) => s.domain === "github.com");
    expect(gh.band).toContain("높음");
    expect(gh.priority).not.toContain("정리 권장");
  });

  test("the layout does not jump sideways when the scrollbar arrives", async ({ page }) => {
    // Rows stream in during a scan. The moment the page outgrows the viewport the vertical bar
    // appears, and without a reserved gutter it shoves everything left by its own width.
    await page.setViewportSize({ width: 1280, height: 400 });
    const before = await page.locator(".shell").evaluate((el) => el.getBoundingClientRect().left);
    await runScan(page);
    const after = await page.locator(".shell").evaluate((el) => el.getBoundingClientRect().left);
    expect(await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight)).toBe(true);
    expect(after).toBe(before);
  });

  test("the modal locks the page behind it instead of scrolling two things at once", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 400 });
    await runScan(page);
    await page.locator("#rows tr", { hasText: "spotify.com" }).getByRole("button").click();
    await expect(page.locator("#guideModal")).toBeVisible();
    expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe("hidden");

    await page.click("#guideClose");
    expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).not.toBe("hidden");
  });

  test("the page never scrolls sideways, only the table does", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await runScan(page);
    const m = await page.evaluate(() => {
      const d = document.documentElement;
      const w = document.querySelector("#appPanel .table-wrap");
      return {
        pageH: d.scrollWidth > d.clientWidth + 1,
        tableScrollsInside: w.scrollWidth > w.clientWidth,
      };
    });
    expect(m.pageH).toBe(false);
    expect(m.tableScrollsInside).toBe(true);
  });

  test("a closed account offers no withdrawal guide, only the badge", async ({ page }) => {
    // Found by the e2e on its first run, and it is correct: §3 marks likely_closed and excludes it
    // from the cleanup list, so deletionCell renders the badge in place of the button. Guiding
    // someone to withdraw from an account they already closed is the wrong instruction.
    await runScan(page);
    const row = page.locator("#rows tr", { hasText: "auction.co.kr" });
    await expect(row).toContainText("폐쇄 추정");
    await expect(row.getByRole("button")).toHaveCount(0);
  });

  test("복구 puts an excluded sender back in the list", async ({ page }) => {
    await runScan(page);
    await page.click("#hiddenToggle");
    const row = page.locator("#hiddenRows tr", { hasText: "김철수" });
    await row.getByRole("button", { name: "복구" }).click();

    const view = await readTable(page);
    expect(view.services.some((s) => s.name.includes("김철수"))).toBe(true);
    expect(view.excluded.some((s) => s.name.includes("김철수"))).toBe(false);
  });

  test("the progress bar tracks real fetch progress and finishes full", async ({ page }) => {
    await expect(page.locator("#progressTrack")).toBeHidden();
    await runScan(page);
    await expect(page.locator("#progressTrack")).toBeVisible();
    const scale = await page.locator("#progressBar").evaluate((el) => el.style.transform);
    expect(scale).toBe("scaleX(1)");
  });
});

test.describe("when Gmail says no", () => {
  test("a permanent 403 surfaces as errors, not a silent empty list", async ({ page }) => {
    await installFakeGoogle(page, {
      account: SELF,
      messages: mailbox(),
      failWith: { status: 403, reason: "insufficientPermissions" },
    });
    await page.goto("/");
    await page.click("#scan");
    await page.waitForFunction(() => /완료:/.test(document.getElementById("progress")?.textContent || ""), null, {
      timeout: 15000,
    });
    await expect(page.locator("#meta")).toContainText("읽지 못한 메일");
    await expect(page.locator("#emptyState")).toBeVisible();
  });

  test("an expired Gmail token aborts with a message telling the user what to do", async ({ page }) => {
    await installFakeGoogle(page, { account: SELF, messages: mailbox(), failWith: { status: 401 } });
    await page.goto("/");
    await page.click("#scan");
    await expect(page.locator("#err")).toContainText("다시 로그인");
  });
});

test.describe("the page a logged-out visitor lands on", () => {
  test("the trust block answers the permission question before the button asks it", async ({ page }) => {
    await installFakeGoogle(page, { account: SELF, messages: [] });
    await page.route("**/api/me", (route) => route.fulfill({ json: { loggedIn: false } }));
    await page.goto("/");

    await expect(page.locator("#loginPanel")).toBeVisible();
    await expect(page.locator("#appPanel")).toBeHidden();
    await expect(page.locator(".trust")).toContainText("메일 본문은 읽지 않습니다");
    await expect(page.locator(".trust")).toContainText("메일이 서버로 가지 않습니다");

    // Above the button, not below it. This is the whole trust argument.
    const trustBottom = await page.locator(".trust").evaluate((el) => el.getBoundingClientRect().bottom);
    const btnTop = await page.locator("#googleBtn").evaluate((el) => el.getBoundingClientRect().top);
    expect(trustBottom).toBeLessThanOrEqual(btnTop);
  });

  test("nothing on the page asks for a credential we removed", async ({ page }) => {
    await installFakeGoogle(page, { account: SELF, messages: [] });
    await page.goto("/");
    await expect(page.locator("body")).not.toContainText("credentials.json");
    await expect(page.locator("body")).not.toContainText("도메인 후보 저장");
    await expect(page.locator("body")).not.toContainText("내 계정 아님");
  });
});
