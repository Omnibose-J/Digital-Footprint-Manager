import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  maskAccount,
  renderRequestTemplate,
  renderGuideHtml,
} from "../frontend/guide.js";

describe("guide template (E6)", () => {
  it("masks account as so****@gmail.com shape", () => {
    assert.equal(maskAccount("sobeolab@gmail.com"), "so****@gmail.com");
    assert.equal(maskAccount("ab@x.com"), "ab****@x.com");
  });

  it("template contains service name + masked account and nothing else interpolated", () => {
    const { subject, body, fullText } = renderRequestTemplate({
      serviceName: "Spotify",
      maskedAccount: "so****@gmail.com",
    });
    assert.match(subject, /Spotify/);
    assert.match(subject, /so\*\*\*\*@gmail\.com/);
    assert.equal(
      subject,
      "[회원탈퇴 및 개인정보 삭제 요청] Spotify / so****@gmail.com"
    );
    assert.ok(body.includes("회원탈퇴 및 개인정보 삭제"));
    assert.ok(!fullText.includes("{서비스명}"));
    assert.ok(!fullText.includes("{마스킹된 계정}"));
  });
});

describe("guide modal render states (R4)", () => {
  it("matched verified entry shows verified badge and catalog link", () => {
    const html = renderGuideHtml({
      candidate: {
        displayName: "Spotify",
        registrableDomain: "spotify.com",
        linkSafety: "verified",
      },
      entry: {
        display_name: "Spotify",
        deletion_route: "self_service",
        url: "https://www.spotify.com/kr-ko/account/close/",
        steps: ["step-one"],
        prerequisites: [],
        grace_period: "7일",
        last_verified_at: "2026-07-15",
        official_source_url: "https://support.spotify.com/example",
      },
      stale: false,
      serviceName: "Spotify",
      maskedAccount: "so****@gmail.com",
    });
    assert.match(html, /verified/);
    assert.match(html, /spotify\.com\/kr-ko\/account\/close/);
    assert.match(html, /step-one/);
  });

  it("unmatched shows 공식 탈퇴 경로 미확인 with distinct escaped list items", () => {
    const html = renderGuideHtml({
      candidate: {
        displayName: "Unknown Shop",
        registrableDomain: "unknown-shop.co.kr",
        linkSafety: "inferred",
      },
      entry: null,
      stale: false,
      serviceName: "Unknown Shop",
      maskedAccount: "so****@gmail.com",
    });
    assert.match(html, /공식 탈퇴 경로 미확인/);
    assert.ok(!html.includes("공식 경로 없음(검증됨)"));
    const liCount = (html.match(/<li>/g) || []).length;
    assert.ok(liCount >= 8, `expected checklist+warnings as <li>, got ${liCount}`);
    assert.match(html, /Unknown Shop/);
    assert.match(html, /so\*\*\*\*@gmail\.com/);
  });

  it("ampersand in catalog step is HTML-escaped", () => {
    const html = renderGuideHtml({
      candidate: {
        displayName: "Acme",
        registrableDomain: "acme.example",
        linkSafety: "verified",
      },
      entry: {
        display_name: "Acme",
        deletion_route: "self_service",
        url: "https://acme.example/close",
        steps: ["Open Settings & Privacy"],
        prerequisites: [],
        grace_period: "7일",
        last_verified_at: "2026-07-15",
      },
      stale: false,
      serviceName: "Acme",
      maskedAccount: "so****@gmail.com",
    });
    assert.ok(html.includes("Settings &amp; Privacy"));
    assert.ok(!html.includes("Settings & Privacy"));
  });

  it("stale matched entry surfaces 검토 필요", () => {
    const html = renderGuideHtml({
      candidate: {
        displayName: "Spotify",
        registrableDomain: "spotify.com",
        linkSafety: "verified",
      },
      entry: {
        display_name: "Spotify",
        deletion_route: "self_service",
        url: "https://www.spotify.com/kr-ko/account/close/",
        steps: [],
        prerequisites: [],
        last_verified_at: "2025-01-01",
      },
      stale: true,
      serviceName: "Spotify",
      maskedAccount: "so****@gmail.com",
    });
    assert.match(html, /검토 필요/);
    assert.match(html, /2025-01-01/);
  });
});

describe("identity_verification reaches the screen", () => {
  const candidate = {
    displayName: "토스",
    registrableDomain: "toss.im",
    linkSafety: "verified",
  };

  it("renders what the user must prove, from the catalog entry", () => {
    const html = renderGuideHtml({
      candidate,
      entry: {
        deletion_route: "self_service",
        url: "https://support.toss.im/faq/218",
        steps: ["설정 > 탈퇴하기"],
        identity_verification: "탈퇴 마지막 단계에서 토스 비밀번호를 입력합니다.",
        last_verified_at: "2026-07-15",
      },
      stale: false,
      serviceName: "토스",
      maskedAccount: "so****@gmail.com",
    });
    // Anchored on the heading. TEMPLATE_BODY already contains "본인확인이 필요하면...", so a
    // bare /본인확인/ matches whether or not this section renders and proves nothing.
    assert.match(html, /<h3>본인확인<\/h3>/);
    assert.match(html, /토스 비밀번호를 입력합니다/);
  });

  it("an entry without the field renders no empty 본인확인 section", () => {
    const html = renderGuideHtml({
      candidate,
      entry: {
        deletion_route: "self_service",
        url: "https://example.com/close",
        steps: ["설정 > 탈퇴"],
        last_verified_at: "2026-07-15",
      },
      stale: false,
      serviceName: "예시",
      maskedAccount: "so****@gmail.com",
    });
    assert.doesNotMatch(html, /<h3>본인확인<\/h3>/);
  });

  it("is escaped, not injected", () => {
    const html = renderGuideHtml({
      candidate,
      entry: {
        deletion_route: "self_service",
        url: "https://example.com/close",
        steps: [],
        identity_verification: "<img src=x onerror=alert(1)>",
        last_verified_at: "2026-07-15",
      },
      stale: false,
      serviceName: "예시",
      maskedAccount: "so****@gmail.com",
    });
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /&lt;img/);
  });
});
