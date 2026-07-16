/**
 * E2E harness: the real app against a fake Gmail.
 *
 * Everything the product actually owns runs for real here — app.js, filter.js, score.js,
 * verdict.js, catalog.json, the DOM. Only the two things we do not own are faked: Google Identity
 * Services and the Gmail API. That is the boundary worth mocking (§8: mock external boundaries,
 * never internal implementation), and it is also the only way to e2e a product whose entire job
 * happens inside someone's mailbox.
 *
 * The unit suite proves the rules. This proves the wiring, which is where every defect this
 * project has shipped actually lived: a render that threw because a button was gone, an
 * aggregator that was null on the first message, ids the markup no longer had.
 */

/** A Gmail message as messages.get(format=metadata) returns it. */
export function gmailMessage({ id, from, subject, date = "2026-03-02", labelIds = [], headers = {} }) {
  const h = [
    { name: "From", value: from },
    { name: "Subject", value: subject },
  ];
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) for (const v of value) h.push({ name, value: v });
    else h.push({ name, value });
  }
  return {
    id,
    internalDate: String(Date.parse(`${date}T00:00:00Z`)),
    labelIds,
    payload: { headers: h },
  };
}

/** Gmail says this passed DMARC. Without it every message is unauthenticated and scores zero. */
export function authenticated(domain) {
  return { "Authentication-Results": `mx.google.com; dmarc=pass header.from=${domain}` };
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {{ account?: string, messages?: any[], failWith?: {status: number, reason?: string} }} opts
 */
export async function installFakeGoogle(
  page,
  { account = "tester@gmail.com", messages = [], failWith, classify = {} } = {}
) {
  // GIS never loads under CSP in a test, and app.js polls window.google until it does. Inject the
  // surface it actually calls: initialize/renderButton for the sign-in UI, initTokenClient for the
  // Gmail token. requestAccessToken resolves immediately, which is the consented path.
  await page.addInitScript(() => {
    window.__gisCalls = [];
    window.google = {
      accounts: {
        id: {
          initialize: (cfg) => window.__gisCalls.push(["initialize", cfg.client_id]),
          renderButton: (el) => {
            window.__gisCalls.push(["renderButton"]);
            el.innerHTML = '<button id="fakeGoogleBtn">Google 계정으로 로그인</button>';
          },
          disableAutoSelect: () => {},
        },
        oauth2: {
          initTokenClient: (cfg) => ({
            requestAccessToken: () => {
              window.__gisCalls.push(["requestAccessToken", cfg.scope]);
              cfg.callback({ access_token: "fake-gmail-token" });
            },
          }),
          revoke: () => {},
        },
      },
    };
  });

  await page.route("**/gsi/client", (route) => route.fulfill({ status: 200, body: "" }));

  // gtag.js is stubbed, not loaded: the tests must never reach Google, and what we assert is what
  // our code PUSHES, which lands in window.dataLayer whether or not the real tag ever answers.
  await page.route("**/gtag/js**", (route) => route.fulfill({ status: 200, body: "" }));

  await page.route("**/api/config", (route) =>
    route.fulfill({
      json: {
        clientId: "fake-client-id.apps.googleusercontent.com",
        maxMessages: 0,
        concurrency: 4,
        gmailScope: "https://www.googleapis.com/auth/gmail.readonly",
        // Without this initAnalytics returns early and every track() call is a no-op, so the
        // analytics path had no browser coverage at all: the unit tests drive a fake window.
        gaMeasurementId: "G-E2ETEST",
      },
    })
  );

  await page.route("**/api/me", (route) =>
    route.fulfill({ json: { loggedIn: true, email: account, name: "테스터" } })
  );

  /**
   * The label store, faked at the same layer /api/me already is.
   *
   * This harness has no server session — it fulfils /api/me itself rather than minting a cookie —
   * so the real /api/choices would 401 every write and the screen would roll every label back. The
   * routes, their auth and their ownership checks are covered against the real createApp in
   * choices.test.js; what these tests own is the screen: that a click reaches the API with the
   * scores we were showing, and that what comes back on load lands on the right rows.
   */
  const STAMP = "2026-07-16T00:00:00.000Z";
  const labels = new Map();
  await page.route("**/api/choices", (route) =>
    route.fulfill({ json: { choices: Object.fromEntries(labels) } })
  );
  await page.route("**/api/choices/*", (route) => {
    const req = route.request();
    const domain = decodeURIComponent(req.url().split("/api/choices/")[1] || "");
    if (req.method() === "PUT") {
      const body = req.postDataJSON() || {};
      const prev = labels.get(domain) || {};
      labels.set(domain, { ...prev, choice: body.choice, labeledAt: STAMP });
      return route.fulfill({ json: { ok: true } });
    }
    if (req.method() === "DELETE") {
      labels.delete(domain);
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ status: 405, json: {} });
  });

  // SOW 002 §3a. The server stamps the time; the client only ever sends booleans, so this returns a
  // fixed stamp rather than echoing anything the page sent.
  await page.route("**/api/choices/*/status", (route) => {
    const req = route.request();
    const domain = decodeURIComponent(
      (req.url().split("/api/choices/")[1] || "").replace(/\/status.*$/, "")
    );
    const row = labels.get(domain);
    // §3a: a completion for a domain with no label row is the client being out of sync.
    if (!row) return route.fulfill({ status: 404, json: {} });
    const body = req.postDataJSON() || {};
    if ("withdrawn" in body) row.withdrawnAt = body.withdrawn ? STAMP : null;
    if ("unsubscribed" in body) row.unsubscribedAt = body.unsubscribed ? STAMP : null;
    labels.set(domain, row);
    return route.fulfill({
      json: {
        ok: true,
        withdrawnAt: row.withdrawnAt ?? null,
        unsubscribedAt: row.unsubscribedAt ?? null,
      },
    });
  });

  // E2E must not call the real Gemini API. Default is empty results = the rules-only fallback, which
  // is what a missing key or an outage leaves behind and therefore what most tests should see.
  // Pass `classify` to hand back a canned answer keyed by ServiceCandidate.key.
  await page.route("**/api/classify-senders", (route) =>
    route.fulfill({ json: { results: classify } })
  );

  await page.route("**gmail.googleapis.com/**", (route) => {
    const url = route.request().url();
    if (url.includes("/profile")) {
      return route.fulfill({ json: { emailAddress: account, messagesTotal: messages.length } });
    }
    if (/\/messages\?/.test(url)) {
      return route.fulfill({ json: { messages: messages.map((m) => ({ id: m.id })) } });
    }
    const id = url.match(/\/messages\/([^?]+)/)?.[1];
    if (failWith) {
      return route.fulfill({
        status: failWith.status,
        json: { error: { errors: [{ reason: failWith.reason || "backendError" }] } },
      });
    }
    const msg = messages.find((m) => m.id === id);
    return msg ? route.fulfill({ json: msg }) : route.fulfill({ status: 404, json: {} });
  });
}

/** Wait for the scan to finish, then read what the user can actually see. */
export async function runScan(page) {
  await page.click("#scan");
  await page.waitForFunction(() => /완료:/.test(document.getElementById("progress")?.textContent || ""), null, {
    timeout: 15000,
  });
  return readTable(page);
}

export async function readTable(page) {
  return page.evaluate(() => {
    const cells = (tr) => [...tr.children].map((td) => td.innerText.trim().replace(/\s+/g, " "));
    return {
      progress: document.getElementById("progress").textContent,
      meta: document.getElementById("meta").textContent,
      err: document.getElementById("err").textContent,
      // # / 서비스 / 비고 / 마지막 흔적 / 건수 / 내 선택
      //
      // No 탈퇴 column: the 후보 list stopped offering a withdrawal for a service the user has not
      // said anything about yet — it lives on the 미사용 tab now.
      // No 정리 우선도 / 신뢰: one 비고 column carries the reasons and neither score is on screen.
      // The scores still exist and still rank this list; assert order here, not numbers.
      // No 도메인 column either — the 서비스 cell prints the domain under the name, so `domain` below
      // reads it from there. It was a duplicate holding 14% of a table that had none to spare.
      services: [...document.getElementById("rows").children].map((tr) => {
        const c = cells(tr);
        const svc = tr.querySelector(".cell-service");
        return {
          name: svc?.querySelector(".service-name")?.innerText.trim() || c[1],
          domain: svc?.querySelector(".service-domain")?.innerText.trim() || "",
          remark: c[2],
          month: c[3],
          count: c[4],
          choice: c[5],
        };
      }),
      excluded: [...document.getElementById("hiddenRows").children].map((tr) => {
        const c = cells(tr);
        return { name: c[1], domain: c[2], reason: c[3], count: c[4] };
      }),
    };
  });
}

/**
 * Label a service 미사용 and switch to the tab that lists them, returning its row there.
 *
 * The withdrawal link only exists on this path now: the 후보 list asks "do you still use this" and
 * offers nothing else until answered, so any test about 탈퇴 has to answer first. That is the real
 * user journey too — nobody reached a cancel link without deciding they were done with the service.
 */
export async function markUnusedAndOpenTab(page, domain) {
  await page.locator("#rows tr", { hasText: domain }).locator('button[data-choice="delete"]').click();
  await page.click("#tabUnused");
  const row = page.locator("#unusedRows tr", { hasText: domain });
  await row.waitFor();
  return row;
}
