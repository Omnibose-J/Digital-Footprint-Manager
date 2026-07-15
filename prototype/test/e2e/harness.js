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
export async function installFakeGoogle(page, { account = "tester@gmail.com", messages = [], failWith } = {}) {
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

  await page.route("**/api/config", (route) =>
    route.fulfill({
      json: {
        clientId: "fake-client-id.apps.googleusercontent.com",
        maxMessages: 0,
        concurrency: 4,
        gmailScope: "https://www.googleapis.com/auth/gmail.readonly",
      },
    })
  );

  await page.route("**/api/me", (route) =>
    route.fulfill({ json: { loggedIn: true, email: account, name: "테스터" } })
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
      // # / 서비스 / 도메인 / 정리 우선도 / 신뢰 / 마지막 흔적 / 건수 / 탈퇴
      services: [...document.getElementById("rows").children].map((tr) => {
        const c = cells(tr);
        return { name: c[1], domain: c[2], priority: c[3], band: c[4], month: c[5], count: c[6], action: c[7] };
      }),
      excluded: [...document.getElementById("hiddenRows").children].map((tr) => {
        const c = cells(tr);
        return { name: c[1], domain: c[2], reason: c[3], count: c[4] };
      }),
    };
  });
}
