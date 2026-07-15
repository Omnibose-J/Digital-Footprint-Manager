import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSender,
  classifyMessage,
  createAggregator,
  registrableDomainFromHost,
} from "../public/filter.js";

function msg({
  from,
  subject = "",
  labelIds = [],
  internalDate = String(Date.UTC(2024, 5, 15)),
  headers = {},
} = {}) {
  return {
    id: "m1",
    internalDate,
    labelIds,
    headers: {
      from,
      subject,
      ...headers,
    },
  };
}

describe("R3 registrable domain", () => {
  it("shop.example.co.kr → example.co.kr (not co.kr)", () => {
    assert.equal(registrableDomainFromHost("shop.example.co.kr"), "example.co.kr");
    const n = normalizeSender("Shop <a@shop.example.co.kr>");
    assert.equal(n.registrableDomain, "example.co.kr");
  });

  it("mailer.coupang.com → coupang.com", () => {
    assert.equal(registrableDomainFromHost("mailer.coupang.com"), "coupang.com");
    const n = normalizeSender("Coupang <noreply@mailer.coupang.com>");
    assert.equal(n.registrableDomain, "coupang.com");
  });
});

describe("R5 classifyMessage", () => {
  it("marketing subject with bare 가입 is not signup", () => {
    const r = classifyMessage({
      subject: "[이벤트] 지금 가입하면 5,000원!",
      labelIds: [],
    });
    assert.notEqual(r.family, "signup");
  });

  it("회원가입이 완료되었습니다 → signup", () => {
    const r = classifyMessage({
      subject: "회원가입이 완료되었습니다",
      labelIds: [],
    });
    assert.equal(r.family, "signup");
  });

  it("CATEGORY_PROMOTIONS + verification subject → signup (D4)", () => {
    const r = classifyMessage({
      subject: "이메일 인증이 완료되었습니다",
      labelIds: ["CATEGORY_PROMOTIONS"],
    });
    assert.equal(r.family, "signup");
  });

  it("no rule match → unknown, not marketing (D5)", () => {
    const r = classifyMessage({
      subject: "배송 관련 안내드립니다",
      labelIds: [],
    });
    assert.equal(r.family, "unknown");
    assert.notEqual(r.family, "marketing");
  });

  it("List-Unsubscribe alone does not force marketing", () => {
    const r = classifyMessage({
      subject: "주간 소식입니다",
      labelIds: [],
      headers: { listUnsubscribe: "<mailto:unsub@example.com>" },
    });
    assert.equal(r.family, "unknown");
    assert.notEqual(r.family, "marketing");
  });
});

describe("R6 aggregation + D1/D3/D6", () => {
  it("only unknown evidence keeps lastSeenMonth (D6)", () => {
    const agg = createAggregator({ selfEmail: "me@gmail.com" });
    agg.add(
      msg({
        from: "Service <noreply@shop.example.com>",
        subject: "배송 관련 안내드립니다",
        internalDate: String(Date.UTC(2023, 0, 10)),
      })
    );
    const snap = agg.snapshot();
    assert.equal(snap.services.length, 1);
    assert.ok(snap.services[0].lastSeenMonth);
    assert.equal(snap.services[0].lastSeenMonth, "2023-01");
  });

  it("only marketing evidence → lastSeenMonth null (D6)", () => {
    const agg = createAggregator({ selfEmail: "me@gmail.com" });
    agg.add(
      msg({
        from: "Promo <news@shop.example.com>",
        subject: "이번 주 특가",
        labelIds: ["CATEGORY_PROMOTIONS"],
        internalDate: String(Date.UTC(2023, 0, 10)),
      })
    );
    const snap = agg.snapshot();
    assert.equal(snap.services.length, 1);
    assert.equal(snap.services[0].lastSeenMonth, null);
  });

  it("single signup message stays candidate (D1)", () => {
    const agg = createAggregator({ selfEmail: "me@gmail.com" });
    agg.add(
      msg({
        from: "Brand <hello@brand.example.com>",
        subject: "회원가입이 완료되었습니다",
      })
    );
    const snap = agg.snapshot();
    assert.equal(snap.services.length, 1);
    assert.equal(snap.services[0].verdict, "candidate");
    assert.equal(snap.services[0].messageCount, 1);
  });

  it("shopname@naver.com + signup → candidate (D3 rescue)", () => {
    const agg = createAggregator({ selfEmail: "me@gmail.com" });
    agg.add(
      msg({
        from: "Shop <shopname@naver.com>",
        subject: "회원가입이 완료되었습니다",
      })
    );
    const snap = agg.snapshot();
    assert.equal(snap.services.length, 1);
    assert.equal(snap.services[0].verdict, "candidate");
    assert.equal(snap.services[0].hiddenRule, null);
  });

  it("friend@naver.com + unknown → hidden personal_mailbox", () => {
    const agg = createAggregator({ selfEmail: "me@gmail.com" });
    agg.add(
      msg({
        from: "Friend <friend@naver.com>",
        subject: "오늘 저녁 어때?",
      })
    );
    const snap = agg.snapshot();
    assert.equal(snap.services.length, 0);
    assert.equal(snap.hidden.length, 1);
    assert.equal(snap.hidden[0].hiddenRule, "personal_mailbox");
    assert.equal(snap.hidden[0].verdict, "hidden");
  });

  it("self on a custom domain hides only the user's own address, not the domain", () => {
    // SENT mail puts the user in From, so a Workspace/custom-domain user would otherwise
    // lose every service on their own domain to the `self` rule.
    const agg = createAggregator({ selfEmail: "me@company.com" });
    agg.add(msg({ from: "Me <me@company.com>", subject: "보낸 메일" }));
    agg.add(
      msg({
        from: "HR Portal <noreply@hr.company.com>",
        subject: "회원가입이 완료되었습니다",
      })
    );
    const snap = agg.snapshot();

    assert.equal(snap.services.length, 1);
    assert.equal(snap.services[0].registrableDomain, "company.com");
    assert.equal(snap.services[0].families.signup.count, 1);
    assert.equal(snap.hidden.length, 1);
    assert.equal(snap.hidden[0].hiddenRule, "self");
    assert.equal(snap.hidden[0].messageCount, 1);
  });

  it("noreply@sendgrid.net → linkSafety none, siteUrl null", () => {
    const agg = createAggregator({ selfEmail: "me@gmail.com" });
    agg.add(
      msg({
        from: "Relay <noreply@sendgrid.net>",
        subject: "Hello",
      })
    );
    const snap = agg.snapshot();
    assert.equal(snap.unresolved.length, 1);
    const u = snap.unresolved[0];
    assert.equal(u.linkSafety, "none");
    assert.equal(u.siteUrl, null);
    assert.equal(u.linkBlockedBy, "relay");
    assert.equal(u.hiddenRule, "relay_domain");
  });

  it("unparseable From is hidden with invalid_domain (D2)", () => {
    const agg = createAggregator({ selfEmail: "me@gmail.com" });
    agg.add(
      msg({
        from: "Mailing List",
        subject: "hello",
      })
    );
    const snap = agg.snapshot();
    assert.equal(snap.services.length, 0);
    assert.equal(snap.hidden.length, 1);
    assert.equal(snap.hidden[0].hiddenRule, "invalid_domain");
    assert.equal(snap.hidden[0].registrableDomain, null);
  });
});
