import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSender,
  classifyMessage,
  createAggregator,
  registrableDomainFromHost,
  parseFromHeader,
} from "../public/filter.js";
import { applyUserVerdict } from "../public/verdict.js";
import { PAYMENT_GATEWAY_DOMAINS } from "../public/filter.rules.js";

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

describe("SOW 003 R1 display-name repair", () => {
  it('quoted Korean name loses trailing quote', () => {
    const p = parseFromHeader('"삼성전자스토어" <no-reply@samsung.com>');
    assert.equal(p.name, "삼성전자스토어");
    assert.equal(normalizeSender('"삼성전자스토어" <no-reply@samsung.com>').displayName, "삼성전자스토어");
  });

  it("ASCII display name unchanged", () => {
    assert.equal(parseFromHeader("Google <no-reply@google.com>").name, "Google");
  });

  it("bare address unchanged", () => {
    assert.equal(parseFromHeader("no-reply@goodnotes.com").name, "no-reply@goodnotes.com");
  });

  it("quoted-string escape unwrapped", () => {
    assert.equal(parseFromHeader('"O\\"Brien" <a@x.com>').name, 'O"Brien');
  });

  it("lone leading quote is preserved", () => {
    assert.equal(parseFromHeader('"unbalanced <a@x.com>').name, '"unbalanced');
  });

  it("control characters stripped from display name", () => {
    const raw = `"Acme\u0007Corp" <a@acme.com>`;
    assert.equal(parseFromHeader(raw).name, "AcmeCorp");
  });
});

describe("SOW 003 R2/R3 payment gateway", () => {
  it("noreply@kcp.co.kr is hidden as payment_gateway", () => {
    const agg = createAggregator({ selfEmail: "me@gmail.com" });
    agg.add(msg({ from: "KCP <noreply@kcp.co.kr>", subject: "결제 영수증" }));
    const snap = agg.snapshot();
    assert.equal(snap.services.length, 0);
    assert.equal(snap.hidden.length, 1);
    assert.equal(snap.hidden[0].hiddenRule, "payment_gateway");
    assert.ok(snap.hidden[0].hiddenRule, "ruleId present (D2)");
  });

  it("payco.com with signup stays candidate (R3)", () => {
    assert.ok(!PAYMENT_GATEWAY_DOMAINS.includes("payco.com"));
    const agg = createAggregator({ selfEmail: "me@gmail.com" });
    agg.add(
      msg({
        from: "PAYCO <noreply@payco.com>",
        subject: "회원가입이 완료되었습니다",
      })
    );
    const snap = agg.snapshot();
    assert.equal(snap.services.length, 1);
    assert.equal(snap.services[0].registrableDomain, "payco.com");
    assert.equal(snap.services[0].verdict, "candidate");
  });

  it("payment_gateway appears in snapshot().hidden with ruleId (D2)", () => {
    const agg = createAggregator({ selfEmail: "me@gmail.com" });
    for (const domain of ["nicepay.co.kr", "tosspayments.com"]) {
      agg.add(msg({ from: `PG <n@${domain}>`, subject: "receipt" }));
    }
    const snap = agg.snapshot();
    assert.ok(snap.hidden.length >= 2);
    for (const h of snap.hidden) {
      assert.equal(h.hiddenRule, "payment_gateway");
      assert.equal(h.verdict, "hidden");
    }
  });
});

describe("SOW 003 R4 applyUserVerdict", () => {
  function seededSnapshot() {
    const agg = createAggregator({ selfEmail: "me@gmail.com" });
    agg.add(
      msg({
        from: "Brand <hello@brand-shop.com>",
        subject: "회원가입이 완료되었습니다",
      })
    );
    agg.add(msg({ from: "KCP <noreply@kcp.co.kr>", subject: "영수증" }));
    return agg.snapshot();
  }

  it("not_mine moves candidate to excluded with reason 내 계정 아님", () => {
    const snap = seededSnapshot();
    const target = snap.services.find((s) => s.registrableDomain === "brand-shop.com");
    assert.ok(target);
    const verdicts = new Map([[target.key, "not_mine"]]);
    const out = applyUserVerdict(snap, verdicts);
    assert.ok(!out.services.some((s) => s.key === target.key));
    const excluded = out.hidden.find((s) => s.key === target.key);
    assert.ok(excluded);
    assert.equal(excluded.hiddenRule, "not_mine");
  });

  it("candidate override round-trips not_mine back to services", () => {
    const snap = seededSnapshot();
    const key = snap.services.find((s) => s.registrableDomain === "brand-shop.com").key;
    const mid = applyUserVerdict(snap, new Map([[key, "not_mine"]]));
    const back = applyUserVerdict(mid, new Map([[key, "candidate"]]));
    assert.ok(back.services.some((s) => s.key === key));
    assert.ok(!back.hidden.some((s) => s.key === key));
  });

  it("not_mine survives a fresh snapshot (progress tick)", () => {
    const snap1 = seededSnapshot();
    const key = snap1.services.find((s) => s.registrableDomain === "brand-shop.com").key;
    const verdicts = new Map([[key, "not_mine"]]);
    applyUserVerdict(snap1, verdicts);

    const snap2 = seededSnapshot(); // fresh tick — aggregator knows nothing
    const out = applyUserVerdict(snap2, verdicts);
    assert.ok(!out.services.some((s) => s.key === key));
    assert.ok(out.hidden.some((s) => s.key === key && s.hiddenRule === "not_mine"));
  });

  it("save payload omits not_mine domains", () => {
    const snap = seededSnapshot();
    const target = snap.services.find((s) => s.registrableDomain === "brand-shop.com");
    const out = applyUserVerdict(snap, new Map([[target.key, "not_mine"]]));
    const domains = out.services
      .filter((s) => s.registrableDomain)
      .map((s) => s.registrableDomain);
    assert.ok(!domains.includes("brand-shop.com"));
  });
});

function passArs(domain) {
  return `mx.google.com; dkim=pass header.d=${domain}; dmarc=pass header.from=${domain}`;
}

function failArs(domain) {
  return `mx.google.com; dmarc=fail header.from=${domain}`;
}

describe("SOW 004 filter integration (gate + score + verdict)", () => {
  it("absent Authentication-Results → unauthenticatedMessages +1; evidence kept (R2)", () => {
    const agg = createAggregator({ selfEmail: "me@gmail.com" });
    agg.add(
      msg({
        from: "Brand <hello@brand-shop.com>",
        subject: "회원가입이 완료되었습니다",
        internalDate: String(Date.UTC(2024, 0, 10)),
      })
    );
    const snap = agg.snapshot();
    assert.equal(snap.stats.unauthenticatedMessages, 1);
    assert.equal(snap.services.length, 1);
    assert.equal(snap.services[0].discoveryScore, 0);
    assert.ok(snap.services[0].lastSeenMonth); // recency kept (G2)
    assert.equal(snap.services[0].families.signup.count, 1);
  });

  it("forged signup failing gate → 0 score, still in candidate + lastSeenMonth (R2/G2)", () => {
    const agg = createAggregator({ selfEmail: "me@gmail.com" });
    agg.add(
      msg({
        from: "Phish <hello@brand-shop.com>",
        subject: "회원가입이 완료되었습니다",
        internalDate: String(Date.UTC(2024, 0, 10)),
        headers: { authenticationResults: failArs("brand-shop.com") },
      })
    );
    const snap = agg.snapshot();
    assert.equal(snap.services.length, 1);
    assert.equal(snap.services[0].discoveryScore, 0);
    assert.equal(snap.services[0].families.signup.count, 1);
    assert.ok(snap.services[0].lastSeenMonth);
    assert.ok(snap.stats.unauthenticatedMessages >= 1);
  });

  it("authenticated verification + reset → 90 high", () => {
    const agg = createAggregator({ selfEmail: "me@gmail.com" });
    agg.add(
      msg({
        from: "S <n@brand-shop.com>",
        subject: "이메일 인증이 완료되었습니다",
        internalDate: String(Date.UTC(2024, 0, 10)),
        headers: { authenticationResults: passArs("brand-shop.com") },
      })
    );
    agg.add(
      msg({
        from: "S <n@brand-shop.com>",
        subject: "비밀번호 재설정 안내",
        internalDate: String(Date.UTC(2024, 1, 10)),
        headers: { authenticationResults: passArs("brand-shop.com") },
      })
    );
    const s = agg.snapshot().services[0];
    assert.equal(s.discoveryScore, 90);
    assert.equal(s.discoveryBand, "high");
  });

  it("closure newer than positive → likelyClosed", () => {
    const agg = createAggregator({ selfEmail: "me@gmail.com" });
    agg.add(
      msg({
        from: "S <n@brand-shop.com>",
        subject: "회원가입이 완료되었습니다",
        internalDate: String(Date.UTC(2023, 0, 10)),
        headers: { authenticationResults: passArs("brand-shop.com") },
      })
    );
    agg.add(
      msg({
        from: "S <n@brand-shop.com>",
        subject: "회원탈퇴가 완료되었습니다",
        internalDate: String(Date.UTC(2024, 5, 10)),
        headers: { authenticationResults: passArs("brand-shop.com") },
      })
    );
    assert.equal(agg.snapshot().services[0].likelyClosed, true);
  });

  it("closure older than positive → not likelyClosed", () => {
    const agg = createAggregator({ selfEmail: "me@gmail.com" });
    agg.add(
      msg({
        from: "S <n@brand-shop.com>",
        subject: "회원탈퇴가 완료되었습니다",
        internalDate: String(Date.UTC(2023, 0, 10)),
        headers: { authenticationResults: passArs("brand-shop.com") },
      })
    );
    agg.add(
      msg({
        from: "S <n@brand-shop.com>",
        subject: "회원가입이 완료되었습니다",
        internalDate: String(Date.UTC(2024, 5, 10)),
        headers: { authenticationResults: passArs("brand-shop.com") },
      })
    );
    assert.equal(agg.snapshot().services[0].likelyClosed, false);
  });

  it("unsure on a 90-point candidate → band review (R6)", () => {
    const agg = createAggregator({ selfEmail: "me@gmail.com" });
    agg.add(
      msg({
        from: "S <n@brand-shop.com>",
        subject: "이메일 인증이 완료되었습니다",
        internalDate: String(Date.UTC(2024, 0, 10)),
        headers: { authenticationResults: passArs("brand-shop.com") },
      })
    );
    agg.add(
      msg({
        from: "S <n@brand-shop.com>",
        subject: "비밀번호 재설정 안내",
        internalDate: String(Date.UTC(2024, 1, 10)),
        headers: { authenticationResults: passArs("brand-shop.com") },
      })
    );
    const snap = agg.snapshot();
    const key = snap.services[0].key;
    assert.equal(snap.services[0].discoveryScore, 90);
    const out = applyUserVerdict(snap, new Map([[key, "unsure"]]));
    assert.equal(out.services[0].discoveryBand, "review");
    assert.equal(out.services[0].discoveryScore, 90);
  });

  it("owned on a low-score candidate does not lower score (G6)", () => {
    const agg = createAggregator({ selfEmail: "me@gmail.com" });
    agg.add(
      msg({
        from: "S <n@brand-shop.com>",
        subject: "주간 안내",
        labelIds: ["CATEGORY_UPDATES"],
        internalDate: String(Date.UTC(2024, 0, 10)),
        headers: { authenticationResults: passArs("brand-shop.com") },
      })
    );
    const snap = agg.snapshot();
    const before = snap.services[0].discoveryScore;
    assert.equal(before, 5);
    const out = applyUserVerdict(snap, new Map([[snap.services[0].key, "owned"]]));
    assert.equal(out.services[0].userStatus, "owned");
    assert.equal(out.services[0].discoveryScore, before);
  });
});

describe("SOW 005 R5 DNS label validation", () => {
  it("attacker.com#.naver.com → invalid_domain, not naver.com", () => {
    const agg = createAggregator({ selfEmail: "me@gmail.com" });
    agg.add(
      msg({
        from: "네이버 <x@attacker.com#.naver.com>",
        subject: "알림",
        labelIds: ["CATEGORY_UPDATES"],
      })
    );
    const snap = agg.snapshot();
    assert.equal(snap.services.length, 0);
    const inv = snap.hidden.find((h) => h.hiddenRule === "invalid_domain");
    assert.ok(inv);
    assert.notEqual(inv.registrableDomain, "naver.com");
  });

  it("mailer.coupang.com and shop.example.co.kr still resolve", () => {
    assert.equal(registrableDomainFromHost("mailer.coupang.com"), "coupang.com");
    assert.equal(registrableDomainFromHost("shop.example.co.kr"), "example.co.kr");
  });
});
