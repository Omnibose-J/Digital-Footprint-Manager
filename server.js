import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import { URL } from "node:url";

const PORT = Number(process.env.PORT || 8080);
const credentials = JSON.parse(fs.readFileSync("./credentials.json", "utf8")).web;
const sessions = new Map();

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];
const COMMON_QUERIES = [
  'subject:(welcome OR verify OR confirm OR activate OR activation OR signup OR "sign up")',
  'from:(no-reply OR noreply OR do-not-reply OR donotreply)',
  'subject:(account OR subscription OR receipt OR invoice)',
];

function htmlPage(content) {
  return `<!doctype html>
  <html lang="ko">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Gmail 가입 서비스 찾기</title>
      <style>
        :root {
          --primary: #0064e0;
          --primary-deep: #0457cb;
          --ink: #1c1e21;
          --ink-deep: #0a1317;
          --canvas: #ffffff;
          --surface: #f1f4f7;
          --hairline: #ced0d4;
          --hairline-soft: #dee3e9;
          --muted: #5d6c7b;
          --success: #31a24c;
          --warning: #f2a918;
          --critical: #e41e3f;
        }
        body {
          font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          margin: 0;
          background:
            radial-gradient(circle at top left, rgba(0, 100, 224, 0.08), transparent 28%),
            radial-gradient(circle at top right, rgba(0, 145, 255, 0.08), transparent 24%),
            linear-gradient(180deg, #ffffff 0%, #f6f8fb 100%);
          color: var(--ink);
        }
        .wrap { max-width: 1180px; margin: 0 auto; padding: 28px 20px 72px; }
        .shell {
          background: rgba(255,255,255,0.84);
          border: 1px solid rgba(10, 19, 23, 0.08);
          border-radius: 32px;
          box-shadow: 0 20px 60px rgba(20, 22, 26, 0.08);
          backdrop-filter: blur(14px);
          overflow: hidden;
        }
        .hero { display: grid; gap: 24px; grid-template-columns: 1.25fr 0.95fr; align-items: stretch; }
        .card {
          background: var(--canvas);
          border: 1px solid var(--hairline-soft);
          border-radius: 32px;
          padding: 28px;
          box-shadow: 0 1px 4px rgba(20, 22, 26, 0.08);
        }
        .hero-card {
          padding: 34px;
          min-height: 100%;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
        }
        .eyebrow {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          color: var(--primary);
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.02em;
          text-transform: uppercase;
          margin-bottom: 18px;
        }
        .eyebrow::before {
          content: "";
          width: 10px;
          height: 10px;
          border-radius: 999px;
          background: var(--primary);
          box-shadow: 0 0 0 4px rgba(0, 100, 224, 0.12);
        }
        h1 {
          font-size: clamp(40px, 6vw, 64px);
          margin: 0 0 16px;
          line-height: 1.1;
          letter-spacing: -0.03em;
          font-weight: 600;
          color: var(--ink-deep);
        }
        h2 {
          margin-top: 0;
          font-size: 28px;
          line-height: 1.2;
          letter-spacing: -0.02em;
          color: var(--ink-deep);
        }
        h3 {
          margin: 0 0 8px;
          font-size: 18px;
          line-height: 1.3;
        }
        p, li { color: var(--muted); line-height: 1.6; font-size: 16px; }
        a, button { cursor: pointer; }
        .btn {
          display:inline-flex;
          align-items:center;
          justify-content:center;
          gap:8px;
          text-decoration:none;
          padding: 14px 28px;
          border-radius: 999px;
          font-weight: 700;
          font-size: 14px;
          line-height: 1.43;
          border: 2px solid transparent;
          transition: transform 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
        }
        .btn:hover { transform: translateY(-1px); }
        .btn.primary { background: var(--ink-deep); color: #fff; }
        .btn.primary:hover { background: #444950; }
        .btn.buy { background: var(--primary); color: #fff; }
        .btn.buy:hover { background: var(--primary-deep); }
        .btn.secondary { background: transparent; color: var(--ink-deep); border-color: rgba(10, 19, 23, 0.12); }
        .btn.secondary:hover { border-color: var(--ink-deep); }
        .muted { color: var(--muted); font-size: 14px; }
        .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap:16px; margin-top:20px; }
        .tag {
          display:inline-flex;
          align-items:center;
          padding:8px 14px;
          border-radius: 999px;
          background: var(--surface);
          margin:0 8px 8px 0;
          font-size:12px;
          color: var(--muted);
          border: 1px solid rgba(10, 19, 23, 0.06);
        }
        table { width:100%; border-collapse: separate; border-spacing: 0; }
        th, td { text-align:left; padding:14px 12px; border-bottom: 1px solid rgba(148, 163, 184, 0.16); vertical-align: top; }
        th { color: var(--ink-deep); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
        .pill {
          display:inline-flex;
          padding:6px 12px;
          border-radius: 999px;
          font-size:12px;
          font-weight:700;
        }
        .active { background: rgba(49, 162, 76, 0.12); color: var(--success); }
        .stale { background: rgba(242, 169, 24, 0.12); color: #a46b00; }
        .delete { background: rgba(228, 30, 63, 0.12); color: var(--critical); }
        input[type="text"] {
          width:100%;
          box-sizing:border-box;
          padding:14px 16px;
          border-radius: 16px;
          border:1px solid var(--hairline);
          background: var(--canvas);
          color: var(--ink);
          height: 44px;
          font-size: 16px;
        }
        input[type="text"]:focus {
          outline: none;
          border-color: var(--primary);
          box-shadow: 0 0 0 4px rgba(0, 100, 224, 0.12);
        }
        .footer { margin-top:24px; }
        .statline { display:flex; gap:12px; flex-wrap:wrap; margin-top: 20px; }
        .stat {
          padding: 14px 16px;
          border-radius: 24px;
          background: var(--surface);
          border: 1px solid rgba(10, 19, 23, 0.06);
          min-width: 160px;
        }
        .stat strong { display:block; color: var(--ink-deep); font-size: 20px; margin-bottom: 4px; }
        .section-title { display:flex; justify-content:space-between; align-items:end; gap:16px; margin-bottom: 16px; }
        .card-strip { display:grid; grid-template-columns: repeat(3, 1fr); gap:16px; }
        .mini-card {
          border-radius: 24px;
          padding: 20px;
          background: linear-gradient(180deg, #fff, #f8fafc);
          border: 1px solid var(--hairline-soft);
        }
        @media (max-width: 860px) {
          .hero { grid-template-columns: 1fr; }
          .card-strip { grid-template-columns: 1fr; }
          .hero-card { padding: 28px; }
        }
      </style>
    </head>
    <body><div class="wrap">${content}</div></body>
  </html>`;
}

function getSession(req) {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/sid=([^;]+)/);
  if (!match) return null;
  return sessions.get(match[1]) || null;
}

function setSession(res, data) {
  const sid = crypto.randomBytes(24).toString("hex");
  sessions.set(sid, data);
  res.setHeader("Set-Cookie", `sid=${sid}; HttpOnly; Path=/; SameSite=Lax`);
}

function clearSession(res) {
  res.setHeader("Set-Cookie", "sid=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax");
}

function redirect(res, location) {
  res.statusCode = 302;
  res.setHeader("Location", location);
  res.end();
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function analyzeFromText(text) {
  const patterns = [
    /welcome to ([A-Za-z0-9._ -]{2,40})/i,
    /verify (?:your )?account(?: for)? ([A-Za-z0-9._ -]{2,40})?/i,
    /confirm (?:your )?email(?: address)?(?: for)? ([A-Za-z0-9._ -]{2,40})?/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

function normalizeServiceName(sender, subject, bodyText) {
  const senderMatch = sender.match(/@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
  if (senderMatch) {
    return senderMatch[1].replace(/^mail\./, "").split(".")[0];
  }
  const direct = analyzeFromText(`${subject}\n${bodyText}`);
  if (direct) return direct;
  const subjectWords = subject.replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/).filter(Boolean);
  return subjectWords[0] || "unknown";
}

async function googleToken(body) {
  const params = new URLSearchParams(body);
  params.set("client_id", credentials.client_id);
  params.set("client_secret", credentials.client_secret);
  const response = await fetch(credentials.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function apiFetch(session, path) {
  if (session.expires_at && Date.now() >= session.expires_at - 60_000) {
    const refreshed = await googleToken(new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: session.refresh_token,
    }));
    session.access_token = refreshed.access_token;
    session.expires_at = Date.now() + refreshed.expires_in * 1000;
    if (refreshed.refresh_token) session.refresh_token = refreshed.refresh_token;
  }
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/${path}`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function fetchMessage(session, id) {
  return apiFetch(session, `users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
}

async function findServices(session, extraQueries = []) {
  const candidates = new Map();
  const queries = [...new Set([...extraQueries, ...COMMON_QUERIES])];
  for (const q of queries) {
    const list = await apiFetch(session, `users/me/messages?q=${encodeURIComponent(q)}&maxResults=50`);
    for (const msg of list.messages || []) {
      const detail = await fetchMessage(session, msg.id);
      const headers = detail.payload?.headers || [];
      const from = headers.find((h) => h.name === "From")?.value || "";
      const subject = headers.find((h) => h.name === "Subject")?.value || "";
      const date = headers.find((h) => h.name === "Date")?.value || "";
      const snippet = detail.snippet || "";
      const bodyText = snippet;
      const service = normalizeServiceName(from, subject, bodyText).toLowerCase();
      if (!candidates.has(service)) {
        candidates.set(service, {
          service,
          from,
          subject,
          firstSeen: date,
          lastSeen: date,
          evidence: 1,
          status: "maybe_unused",
        });
      } else {
        const item = candidates.get(service);
        item.evidence += 1;
        item.lastSeen = date;
        item.subject = item.subject || subject;
      }
    }
  }
  return [...candidates.values()].sort((a, b) => b.evidence - a.evidence);
}

function homePage(session) {
  const loggedIn = !!session;
  const content = `
    <div class="shell">
      <section class="hero">
        <div class="card hero-card">
          <div>
            <div class="eyebrow">Digital account cleanup</div>
            <h1>Gmail 속 가입 서비스를 찾아, 정리할 계정은 깔끔하게 제안합니다.</h1>
            <p>가입 확인 메일, 환영 메일, 인증 메일을 분석해 서비스 목록을 만들고 오래 사용하지 않은 계정은 탈퇴 후보로 보여줍니다.</p>
            <div style="display:flex; gap:12px; flex-wrap:wrap; margin:24px 0 18px;">
              ${loggedIn ? `<a class="btn buy" href="/dashboard">대시보드 열기</a>` : `<a class="btn buy" href="/auth/google">Google로 시작</a>`}
              ${loggedIn ? `<a class="btn primary" href="/logout">로그아웃</a>` : `<a class="btn secondary" href="#how-it-works">작동 방식</a>`}
            </div>
            <div>
              <span class="tag">Gmail API</span>
              <span class="tag">OAuth 2.0</span>
              <span class="tag">가입 서비스 탐지</span>
              <span class="tag">미사용 후보 추천</span>
            </div>
          </div>
          <div class="statline">
            <div class="stat"><strong>1회</strong><span class="muted">로그인 후 분석 시작</span></div>
            <div class="stat"><strong>최소 저장</strong><span class="muted">증거만 남기는 구조</span></div>
            <div class="stat"><strong>탈퇴 보조</strong><span class="muted">후보 중심 정리</span></div>
          </div>
        </div>
        <div class="card">
          <div class="section-title">
            <div>
              <div class="eyebrow">How it works</div>
              <h2 id="how-it-works">작동 방식</h2>
            </div>
          </div>
          <div class="card-strip">
            <div class="mini-card"><h3>1. 로그인</h3><p>Google 계정으로 안전하게 시작합니다.</p></div>
            <div class="mini-card"><h3>2. 탐색</h3><p>가입/인증/환영 메일을 읽어 서비스 흔적을 찾습니다.</p></div>
            <div class="mini-card"><h3>3. 추천</h3><p>오래 쓰지 않은 서비스는 탈퇴 후보로 보여줍니다.</p></div>
          </div>
          <p class="muted" style="margin-top:18px;">주의: credentials.json에 있는 OAuth 정보는 비밀로 다뤄야 합니다. 외부에 노출하지 마세요.</p>
        </div>
      </section>
    </div>
  `;
  return htmlPage(content);
}

function dashboardPage(session, services = [], error = "") {
  const list = services.length ? services : (session.services || []);
  const rows = list.map((s) => {
    const last = s.lastSeen ? new Date(s.lastSeen).toLocaleDateString("ko-KR") : "-";
    const first = s.firstSeen ? new Date(s.firstSeen).toLocaleDateString("ko-KR") : "-";
    const pillClass = s.evidence >= 3 ? "active" : s.evidence >= 2 ? "stale" : "delete";
    return `<tr>
      <td><strong>${escapeHtml(s.service)}</strong><div class="muted">${escapeHtml(s.from)}</div></td>
      <td>${escapeHtml(first)}</td>
      <td>${escapeHtml(last)}</td>
      <td><span class="pill ${pillClass}">${escapeHtml(s.evidence)}건</span></td>
      <td>${escapeHtml(s.status)}</td>
    </tr>`;
  }).join("");
  return htmlPage(`
    <div class="shell">
      <div class="card" style="margin-bottom:16px;">
        <div class="section-title">
          <div>
            <div class="eyebrow">Service audit</div>
            <h2>서비스 분석 대시보드</h2>
            <p class="muted">${escapeHtml(session.email || "")}</p>
          </div>
          <div style="display:flex; gap:12px; flex-wrap:wrap;">
            <form method="post" action="/api/analyze"><button class="btn buy" type="submit">다시 분석</button></form>
            <a class="btn secondary" href="/logout">로그아웃</a>
          </div>
        </div>
        ${error ? `<p style="color:#e41e3f;">${escapeHtml(error)}</p>` : ""}
        <form method="post" action="/api/analyze" style="margin-top:16px;">
          <label class="muted">Gmail 검색 보조어</label>
          <input type="text" name="query" placeholder="예: welcome, verify, confirm" />
          <p class="muted">비워두면 기본 패턴으로 분석합니다.</p>
        </form>
      </div>
      <div class="grid">
        <div class="card">
          <div class="eyebrow">Detected</div>
          <h3>탐지된 서비스</h3>
          <p class="muted">가입 흔적이 있는 서비스 목록입니다.</p>
        </div>
        <div class="card">
          <div class="eyebrow">Review</div>
          <h3>미사용 후보</h3>
          <p class="muted">최근 관련 메일이 적은 항목을 우선 정리 대상으로 보세요.</p>
        </div>
      </div>
      <div class="card" style="margin-top:16px; overflow:auto;">
        <table>
          <thead><tr><th>서비스</th><th>첫 흔적</th><th>최근 흔적</th><th>증거</th><th>상태</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="5">아직 분석 결과가 없습니다. 분석 버튼을 눌러주세요.</td></tr>`}</tbody>
        </table>
      </div>
      <div class="footer muted">원하시면 여기서 바로 탈퇴 링크, 보호 서비스 설정, CSV 내보내기도 붙일 수 있습니다.</div>
    </div>
  `);
}

function parseFormBody(raw = "") {
  const params = new URLSearchParams(raw);
  return Object.fromEntries(params.entries());
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const session = getSession(req);

    if (url.pathname === "/") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(homePage(session));
      return;
    }

    if (url.pathname === "/auth/google") {
      const state = crypto.randomBytes(16).toString("hex");
      const auth = new URL(credentials.auth_uri);
      auth.searchParams.set("client_id", credentials.client_id);
      auth.searchParams.set("redirect_uri", credentials.redirect_uris[0]);
      auth.searchParams.set("response_type", "code");
      auth.searchParams.set("scope", SCOPES.join(" "));
      auth.searchParams.set("access_type", "offline");
      auth.searchParams.set("prompt", "consent");
      auth.searchParams.set("state", state);
      setSession(res, { state });
      redirect(res, auth.toString());
      return;
    }

    if (url.pathname === "/api/auth/callback/google") {
      const code = url.searchParams.get("code");
      const sess = getSession(req);
      if (!code || !sess) throw new Error("Missing OAuth session.");
      const token = await googleToken(new URLSearchParams({
        code,
        grant_type: "authorization_code",
        redirect_uri: credentials.redirect_uris[0],
      }));
      const profile = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${token.access_token}` },
      }).then((r) => r.json());
      sessions.set(req.headers.cookie.match(/sid=([^;]+)/)[1], {
        state: sess.state,
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        expires_at: Date.now() + token.expires_in * 1000,
        email: profile.email,
      });
      redirect(res, "/dashboard");
      return;
    }

    if (url.pathname === "/dashboard") {
      if (!session?.access_token) return redirect(res, "/");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(dashboardPage(session));
      return;
    }

    if (url.pathname === "/api/analyze" && req.method === "POST") {
      if (!session?.access_token) return redirect(res, "/");
      const rawBody = await new Promise((resolve) => {
        let data = "";
        req.on("data", (chunk) => { data += chunk; });
        req.on("end", () => resolve(data));
      });
      const { query = "" } = parseFormBody(rawBody);
      const extraQueries = query ? [`subject:(${query})`] : [];
      const services = await findServices(session, extraQueries);
      session.services = services;
      redirect(res, "/dashboard");
      return;
    }

    if (url.pathname === "/logout") {
      clearSession(res);
      redirect(res, "/");
      return;
    }

    res.statusCode = 404;
    res.end("Not found");
  } catch (error) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(htmlPage(`<div class="card"><h2>오류가 발생했습니다</h2><pre style="white-space:pre-wrap;color:#fca5a5;">${escapeHtml(error.stack || error.message)}</pre><a class="btn" href="/">홈으로</a></div>`));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`http://localhost:${PORT}`);
});
