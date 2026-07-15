import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSender,
  classifyMessage,
  createAggregator,
  registrableDomainFromHost,
  parseFromHeader,
  marketingHeaderWeight,
} from "../frontend/filter.js";
import { applyUserVerdict } from "../frontend/verdict.js";
import { PAYMENT_GATEWAY_DOMAINS } from "../frontend/filter.rules.js";

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
    // Weight 1 of a required 3. Receipts carry List-Unsubscribe too, and §3 forbids reading any
    // single header as a binary classifier. Notification is the lenient landing spot.
    const r = classifyMessage({
      subject: "주간 소식입니다",
      labelIds: [],
      headers: { listUnsubscribe: "<mailto:unsub@example.com>" },
    });
    assert.equal(r.family, "notification");
    assert.notEqual(r.family, "marketing");
  });
});

describe("SPEC §3 header signals as weighted marketing features", () => {
  it("weight accumulates and only corroboration crosses the threshold", () => {
    const weak = marketingHeaderWeight({ listUnsubscribe: "<mailto:u@e.com>" });
    const alsoWeak = marketingHeaderWeight({
      listUnsubscribe: "<mailto:u@e.com>",
      listUnsubscribePost: "List-Unsubscribe=One-Click",
    });
    const enough = marketingHeaderWeight({
      listUnsubscribe: "<mailto:u@e.com>",
      listId: "<news.example.com>",
    });
    assert.equal(weak, 1);
    assert.equal(alsoWeak, 2);
    assert.equal(enough, 3);
  });

  it("List-Id + List-Unsubscribe → marketing", () => {
    const r = classifyMessage({
      subject: "이번 주 새 소식",
      labelIds: [],
      headers: {
        listId: "<newsletter.example.com>",
        listUnsubscribe: "<mailto:unsub@example.com>",
      },
    });
    assert.equal(r.family, "marketing");
  });

  it("Precedence: bulk + List-Unsubscribe → marketing", () => {
    const r = classifyMessage({
      subject: "이번 주 새 소식",
      labelIds: [],
      headers: { precedence: "bulk", listUnsubscribe: "<mailto:u@example.com>" },
    });
    assert.equal(r.family, "marketing");
  });

  it("RFC 8058 one-click alone stays under the threshold (Google does not forbid it on receipts)", () => {
    const r = classifyMessage({
      subject: "안내드립니다",
      labelIds: [],
      headers: { listUnsubscribePost: "List-Unsubscribe=One-Click" },
    });
    assert.equal(r.family, "notification");
  });

  it("Auto-Submitted: auto-generated → notification; 'no' means a human sent it (RFC 3834)", () => {
    const auto = classifyMessage({
      subject: "안내드립니다",
      labelIds: [],
      headers: { autoSubmitted: "auto-generated" },
    });
    assert.equal(auto.family, "notification");

    const human = classifyMessage({
      subject: "안내드립니다",
      labelIds: [],
      headers: { autoSubmitted: "no" },
    });
    assert.equal(human.family, "unknown");
  });

  it("a subject rule still outranks every header (headers are the last resort)", () => {
    const r = classifyMessage({
      subject: "이메일 인증이 완료되었습니다",
      labelIds: [],
      headers: { listId: "<x.example.com>", precedence: "bulk" },
    });
    assert.equal(r.family, "signup");
    assert.equal(r.signupTier, "verification");
  });

  it("no headers and no rule → still unknown, never invented", () => {
    const r = classifyMessage({ subject: "안내드립니다", labelIds: [], headers: {} });
    assert.equal(r.family, "unknown");
  });
});

describe("Gmail category labels", () => {
  it("CATEGORY_SOCIAL → notification (facebookmail.com scored 0 on 269 messages without this)", () => {
    const r = classifyMessage({ subject: "새로운 알림이 있습니다", labelIds: ["CATEGORY_SOCIAL"] });
    assert.equal(r.family, "notification");
  });

  it("CATEGORY_FORUMS → notification", () => {
    const r = classifyMessage({ subject: "새 댓글", labelIds: ["CATEGORY_FORUMS"] });
    assert.equal(r.family, "notification");
  });

  it("CATEGORY_PROMOTIONS → marketing", () => {
    const r = classifyMessage({ subject: "특가", labelIds: ["CATEGORY_PROMOTIONS"] });
    assert.equal(r.family, "marketing");
  });

  it("a category outranks headers but not a subject rule", () => {
    const promo = classifyMessage({
      subject: "무슨 소식",
      labelIds: ["CATEGORY_PROMOTIONS"],
      headers: { autoSubmitted: "auto-generated" },
    });
    assert.equal(promo.family, "marketing");
  });
});

describe("Korean subject matching", () => {
  it("탈퇴 survives inconsistent spacing", () => {
    const spaced = classifyMessage({ subject: "회원 탈퇴가 완료되었습니다", labelIds: [] });
    const tight = classifyMessage({ subject: "회원탈퇴가 완료되었습니다", labelIds: [] });
    assert.equal(spaced.family, "closure");
    assert.equal(tight.family, "closure");
  });

  it("a subject that despaces a phrase in the table still matches", () => {
    // These need the despaced comparison specifically: the rule carries a space the subject
    // drops, so plain containment misses. Korean services write it both ways.
    const cases = [
      ["회원가입완료 안내드립니다", "signup"], // rule: "회원가입 완료"
      ["탈퇴완료 안내", "closure"], // rule: "탈퇴 완료"
      ["결제완료 안내", "transaction"], // rule: "결제 완료"
      ["휴면 계정 전환 안내", "notification"], // rule: "휴면계정"
    ];
    for (const [subject, family] of cases) {
      assert.equal(classifyMessage({ subject, labelIds: [] }).family, family, subject);
    }
  });

  it("closure outranks transaction: 환불 must not steal a withdrawal confirmation", () => {
    const r = classifyMessage({
      subject: "[쿠팡] 회원탈퇴 처리 완료 및 환불 안내",
      labelIds: [],
    });
    assert.equal(r.family, "closure");
  });

  it("signup outranks closure: re-signup must not mark a live account closed", () => {
    const r = classifyMessage({ subject: "탈퇴 후 재가입이 완료되었습니다", labelIds: [] });
    assert.equal(r.family, "signup");
  });

  it("조사 없는 명사구 제목도 잡는다", () => {
    const cases = [
      ["결제 완료 안내", "transaction"],
      ["주문 완료 안내", "transaction"],
      ["배송 완료 안내", "transaction"],
      ["임시 비밀번호 발급 안내", "auth"],
      ["비밀번호가 변경되었습니다", "auth"],
      ["예약이 완료되었습니다", "transaction"],
      ["가입을 축하합니다", "signup"],
    ];
    for (const [subject, family] of cases) {
      assert.equal(classifyMessage({ subject, labelIds: [] }).family, family, subject);
    }
  });

  it("휴면/이용내역/약관 안내는 회원에게만 가므로 미분류로 흘리지 않는다", () => {
    const cases = [
      "휴면계정 전환 안내",
      "장기 미접속 회원 개인정보 분리보관 안내",
      "개인정보 이용내역 안내",
      "이용약관 개정 안내",
    ];
    for (const subject of cases) {
      assert.equal(classifyMessage({ subject, labelIds: [] }).family, "notification", subject);
    }
  });

  it("본인인증/계좌인증은 signup verification 55점이 아니다 (게스트 결제)", () => {
    const cases = [
      "본인인증이 완료되었습니다",
      "계좌 인증이 완료되었습니다",
      "휴대폰 인증이 완료되었습니다",
    ];
    for (const subject of cases) {
      const r = classifyMessage({ subject, labelIds: [] });
      assert.notEqual(r.signupTier, "verification", subject);
    }
    // The one that must still land.
    const real = classifyMessage({ subject: "이메일 인증이 완료되었습니다", labelIds: [] });
    assert.equal(real.signupTier, "verification");
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
    // A person, not a service: hidden by personal_mailbox with linkBlockedBy set, which is the
    // only shape where the link assertions below can actually vary. KCP is a payment gateway and
    // still carries an inferred https://kcp.co.kr, so asserting its link proves nothing.
    agg.add(msg({ from: "김철수 <chulsoo.kim@gmail.com>", subject: "안녕하세요" }));
    return agg.snapshot();
  }

  // Restore is the only user verdict left. not_mine was removed: it dropped a row and set a
  // badge for a cleanup list (§4) that does not exist, so nothing consumed the drop.
  it("복구 pulls a rule-hidden sender back into services", () => {
    const snap = seededSnapshot();
    const target = snap.hidden.find((s) => s.registrableDomain === "kcp.co.kr");
    assert.ok(target, "KCP should start hidden as a payment gateway");
    assert.equal(target.hiddenRule, "payment_gateway");

    const out = applyUserVerdict(snap, new Map([[target.key, "candidate"]]));
    const restored = out.services.find((s) => s.key === target.key);
    assert.ok(restored);
    assert.equal(restored.hiddenRule, null);
    assert.ok(!out.hidden.some((s) => s.key === target.key));
  });

  it("복구 survives a fresh snapshot (progress tick)", () => {
    const snap1 = seededSnapshot();
    const key = snap1.hidden.find((s) => s.registrableDomain === "kcp.co.kr").key;
    const verdicts = new Map([[key, "candidate"]]);
    applyUserVerdict(snap1, verdicts);

    const snap2 = seededSnapshot(); // fresh tick — aggregator knows nothing
    const out = applyUserVerdict(snap2, verdicts);
    assert.ok(out.services.some((s) => s.key === key));
    assert.ok(!out.hidden.some((s) => s.key === key));
  });

  it("restoring says 'this is a service', not 'this URL is right'", () => {
    // A rescued gmail.com sender still has no site to send anyone to. Handing them
    // https://gmail.com as a withdrawal page would be worse than showing nothing.
    const snap = seededSnapshot();
    const target = snap.hidden.find((s) => s.hiddenRule === "personal_mailbox");
    assert.ok(target);
    assert.equal(target.linkBlockedBy, "free_mailbox");
    assert.equal(target.siteUrl, null);

    const out = applyUserVerdict(snap, new Map([[target.key, "candidate"]]));
    const restored = out.services.find((s) => s.key === target.key);
    assert.ok(restored, "the rescue itself must work");
    assert.equal(restored.siteUrl, null);
    assert.equal(restored.linkBlockedBy, "free_mailbox");
  });

  it("an empty verdict map leaves every bucket where the rules put it", () => {
    const snap = seededSnapshot();
    const out = applyUserVerdict(snap, new Map());
    assert.equal(out.services.length, snap.services.length);
    assert.equal(out.hidden.length, snap.hidden.length);
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
