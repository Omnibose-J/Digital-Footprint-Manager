const emailInput = document.getElementById("email");
const connectBtn = document.getElementById("connect");
const logoutBtn = document.getElementById("logout");
const loadBtn = document.getElementById("load");
const statusEl = document.getElementById("status");
const progressEl = document.getElementById("progress");
const meta = document.getElementById("meta");
const err = document.getElementById("err");
const rows = document.getElementById("rows");

let activeStream = null;

const params = new URLSearchParams(location.search);
if (params.get("connected") === "1") {
  if (params.get("mismatch") === "1") {
    err.textContent =
      "입력한 이메일과 Google에서 선택한 계정이 다릅니다. 연결은 됐으니 원하면 다시 연결하세요.";
  }
  history.replaceState({}, "", "/");
}

async function refreshMe() {
  const res = await fetch("/api/me");
  const data = await res.json();
  if (data.connected) {
    statusEl.textContent = `연결됨: ${data.account || "(확인 중)"}`;
    if (data.hintEmail && !emailInput.value) {
      emailInput.value = data.hintEmail;
    } else if (data.account && !emailInput.value) {
      emailInput.value = data.account;
    }
  } else {
    statusEl.textContent = "아직 연결되지 않음 — 이메일을 입력하고 Google 연결을 누르세요.";
  }
  return data;
}

function formatProgress(p) {
  const totalLabel = p.target ? String(p.target) : "?";
  if (p.phase === "listing") {
    return `메일 ID 수집 중… ${p.scannedIds}${p.unlimited ? ` (전체 ~${totalLabel})` : ` / ${totalLabel}`}`;
  }
  return [
    `헤더 조회 중… ${p.fetched} / ${p.scannedIds || totalLabel}`,
    p.unlimited && p.target ? `전체 예상 ${p.target}` : null,
    `고유 발신자 ${p.uniqueSenders}`,
    p.errors ? `에러 ${p.errors}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function renderSenders(senders) {
  rows.innerHTML = (senders || [])
    .map(
      (s, i) =>
        `<tr><td>${i + 1}</td><td>${escapeHtml(s.name)}</td><td>${escapeHtml(s.email)}</td><td>${s.count}</td></tr>`
    )
    .join("");
}

function renderDone(data) {
  progressEl.textContent = `완료: ${data.fetched} / ${data.scannedIds}${data.unlimited ? " (전체)" : ""}`;
  meta.textContent = [
    `계정: ${data.account}`,
    `스캔 ID: ${data.scannedIds}`,
    `헤더 조회: ${data.fetched}`,
    `에러: ${data.errors}`,
    `고유 발신자: ${data.uniqueSenders}`,
    data.unlimited ? "범위: 전체" : `범위: 최대 ${data.maxMessages}`,
  ].join(" · ");

  renderSenders(data.senders);
}

connectBtn.addEventListener("click", async () => {
  err.textContent = "";
  const email = emailInput.value.trim();
  if (!email) {
    err.textContent = "이메일을 입력해 주세요.";
    return;
  }

  connectBtn.disabled = true;
  try {
    const res = await fetch("/api/auth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    location.href = data.authUrl;
  } catch (e) {
    err.textContent = String(e.message || e);
    connectBtn.disabled = false;
  }
});

logoutBtn.addEventListener("click", async () => {
  err.textContent = "";
  if (activeStream) {
    activeStream.close();
    activeStream = null;
  }
  await fetch("/api/auth/logout", { method: "POST" });
  rows.innerHTML = "";
  meta.textContent = "";
  progressEl.textContent = "";
  await refreshMe();
});

loadBtn.addEventListener("click", async () => {
  err.textContent = "";
  meta.textContent = "";
  rows.innerHTML = "";
  progressEl.textContent = "시작 중…";
  loadBtn.disabled = true;

  if (activeStream) {
    activeStream.close();
    activeStream = null;
  }

  const es = new EventSource("/api/senders/stream");
  activeStream = es;

  es.addEventListener("start", (ev) => {
    const data = JSON.parse(ev.data);
    const scope = data.unlimited
      ? `전체 메일함${data.estimatedTotal ? ` (~${data.estimatedTotal}건)` : ""}`
      : `최대 ${data.maxMessages}건`;
    progressEl.textContent = `계정 ${data.account} · ${scope} · 동시 ${data.concurrency || 12}`;
  });

  es.addEventListener("progress", (ev) => {
    const data = JSON.parse(ev.data);
    progressEl.textContent = formatProgress(data);
    if (data.senders?.length) renderSenders(data.senders);
  });

  es.addEventListener("done", async (ev) => {
    const data = JSON.parse(ev.data);
    renderDone(data);
    es.close();
    activeStream = null;
    loadBtn.disabled = false;
    await refreshMe();
  });

  es.addEventListener("fail", (ev) => {
    try {
      const data = JSON.parse(ev.data);
      err.textContent = data.error || "스캔 실패";
    } catch {
      err.textContent = "스캔 실패";
    }
    es.close();
    activeStream = null;
    loadBtn.disabled = false;
  });

  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) {
      if (!meta.textContent && !rows.innerHTML && !err.textContent) {
        err.textContent = "연결이 끊겼습니다. 다시 시도해 주세요.";
      }
      activeStream = null;
      loadBtn.disabled = false;
    }
  };
});

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

refreshMe().catch((e) => {
  err.textContent = String(e.message || e);
});
