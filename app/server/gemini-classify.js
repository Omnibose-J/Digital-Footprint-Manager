import { loadGeminiApiKey } from "./load-local-config.js";

export { loadGeminiApiKey };

/**
 * 50, not 20. The limit that binds is requests per minute, not tokens: a real mailbox is ~63 senders,
 * and at 20 that was four requests fired back to back — 429 every time, and an empty 비고 for the
 * whole scan. Two requests fit under the free tier; the payload is names and four subjects each, so
 * the model has room to spare either way.
 */
const BATCH_SIZE = 50;
/** 429 is a wait, not a failure. This runs after the list renders, so seconds here cost nothing. */
const RETRY_MAX = 3;
const RETRY_BASE_MS = 4000;
/** Gap between batches: the free tier counts requests per minute, so back-to-back is what trips it. */
const BATCH_GAP_MS = 3000;
/**
 * Pinned, not "-latest".
 *
 * This was gemini-1.5-flash, which Google retired. The API answered 404 for every batch, the route
 * failed soft exactly as designed, and 비고 was simply empty — nothing was broken loudly enough to
 * notice. That is what failing soft costs, and it is why the model name is worth a comment: the
 * failure this classifier has already had was a dead string, not a bad answer.
 *
 * 2.5-flash is closed to new keys ("no longer available to new users"), so the working floor is the
 * 3 family. A pin can die the same way and gemini-flash-latest could not — still the right trade:
 * -latest swaps the classifier under us without a deploy, and this names services in a product whose
 * claim is that its judgments are explainable. A 404 on a pin shows up in one request; a quietly
 * different model does not show up at all.
 *
 * If this 404s again, `GET /v1beta/models?key=…` lists what the key can actually call.
 */
const MODEL = "gemini-3-flash-preview";
const CATEGORIES = new Set(["가입서비스", "개인메일", "기타"]);

/**
 * @param {{ displayName?: string, email?: string, key?: string }[]} senders
 * @returns {Promise<Record<string, { category: string, realService: string, reason: string }>>}
 */
export async function classifySendersWithGemini(senders) {
  const apiKey = loadGeminiApiKey();
  const byKey = {};

  if (!apiKey) {
    console.warn("[gemini] GEMINI_API_KEY missing (.env or src/lib/config.ts)");
    return byKey;
  }

  const list = Array.isArray(senders) ? senders : [];
  for (let i = 0; i < list.length; i += BATCH_SIZE) {
    const batch = list.slice(i, i + BATCH_SIZE);
    // Spaced, not just retried. The per-minute limit counts requests, so firing the second batch the
    // instant the first returns is what earns the 429 that the retry then has to wait out anyway.
    if (i > 0) await sleep(BATCH_GAP_MS);
    const batchResults = await classifyBatch(apiKey, batch);
    Object.assign(byKey, batchResults);
  }
  return byKey;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {string} apiKey
 * @param {{ displayName?: string, names?: string[], email?: string, key?: string }[]} batch
 * @param {number} [attempt]
 */
async function classifyBatch(apiKey, batch, attempt = 0) {
  const out = {};
  const payload = batch.map((s) => {
    // Every name this domain sent under, not just the one the table prints. A relay's domain carries
    // several services and the display name is the only place that survives — "Cursor via Stripe"
    // resolves, "Stripe" cannot, and they are the same domain.
    const names = (Array.isArray(s.names) ? s.names : [])
      .map((n) => String(n || "").slice(0, 200))
      .filter(Boolean)
      .slice(0, 5);
    const primary = String(s.displayName || "").slice(0, 200);
    const subjects = (Array.isArray(s.subjects) ? s.subjects : [])
      .map((t) => String(t || "").slice(0, 120))
      .filter(Boolean)
      .slice(0, 4);
    return {
      key: s.key || "",
      displayName: primary,
      names: names.length ? names : primary ? [primary] : [],
      subjects,
      email: String(s.email || "").slice(0, 200),
    };
  });

  const prompt = `You classify email senders for a Korean digital-footprint tool.
You receive sender display names, the address, and a few subject lines. Never invent mail content:
if the subjects do not say something, it is not known.

"names" lists every display name this address sent under, most frequent first. A relay or payment
processor sends for many services, so the names are the only evidence of who the mail is really for:
"Cursor via Stripe" from receipts@stripe.com is Cursor's mail, not Stripe's.

"subjects" is a small sample, biased toward the ones our Korean phrase rules could not read. Use it
to tell what this sender does — signup/verification vs payment vs ads vs a person writing.

For EACH sender, return:
- category: exactly one of "가입서비스" | "개인메일" | "기타"
  · 가입서비스 = automated mail from a service where the user likely has an account
  · 개인메일 = a real person (including the user themselves)
  · 기타 = ads, doc-share noise, relays, or anything else
- realService: the real product/brand name if inferable. Read "names" first — "X via Y" means X. If
  the names show SEVERAL different services behind one relay, name the most frequent one and say so
  in reason. If nothing in the names identifies a service, use the brand from the domain, or "".
- reason: one or two Korean sentences, written to help someone decide 사용/미사용 for this service.
  Cover, in this order, only what the evidence supports:
  1. WHAT KIND of mail this is — 가입/인증, 결제·구독, 광고, 서비스 알림. Name it.
  2. WHAT THAT MEANS about the account: 결제 메일이면 유료 이용 이력, 가입/인증이면 계정 존재가
     거의 확실, 광고만이면 계정이 있는지조차 불확실.
  3. Anything that changes the cleanup decision: 결제 정보가 남아 있을 가능성, 여러 서비스가 한
     발송사를 공유, 개인이 보낸 메일이라 정리 대상이 아님 등.
  Concrete over generic: "광고 메일입니다" tells them nothing they cannot see. "쇼핑몰 광고만 오고
  가입·결제 흔적은 없어 계정 여부가 불확실합니다" is a judgment they can act on.
  NEVER quote or paraphrase a subject line — they can read their own mail. Never invent facts the
  names and subjects do not support; if the evidence is thin, say that it is thin.
- email: copy the input email exactly
- key: copy the input key exactly

CRITICAL OUTPUT RULES:
- Reply with a JSON array ONLY. No markdown, no code fences, no commentary.
- Example: [{"key":"dom:x.com","email":"a@x.com","category":"가입서비스","realService":"X","reason":"소셜 서비스 계정 메일로 보임"}]

Senders:
${JSON.stringify(payload)}`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
        },
      }),
      // A hang here is worse than an error: the catch below already turns any failure into the
      // rule-based labels the client renders anyway, but without a deadline the request just holds
      // a serverless invocation open until the platform kills it, and 비고 stays empty either way.
      // 30s is well clear of the ~10s a 50-sender batch takes.
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      // 429 is the free tier's per-minute limit, and it is the failure this actually has: a real
      // mailbox is 63 senders, which went out as four requests back to back and tripped it every
      // time. Retried with a wait, because the alternative is an empty 비고 for the whole scan —
      // and this runs after the list is already on screen, so a few seconds cost nothing.
      if (res.status === 429 && attempt < RETRY_MAX) {
        const waitMs = RETRY_BASE_MS * (attempt + 1);
        console.warn(`[gemini] 429, retrying in ${waitMs}ms (attempt ${attempt + 1}/${RETRY_MAX})`);
        await sleep(waitMs);
        return classifyBatch(apiKey, batch, attempt + 1);
      }
      console.warn("[gemini] API error", res.status, errText.slice(0, 300));
      return out;
    }

    const data = await res.json();
    const text =
      data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    const parsed = parseJsonArray(text);
    if (!parsed) {
      console.warn("[gemini] non-JSON response; keeping rule-based labels for this batch");
      return out;
    }

    for (const row of parsed) {
      const category = CATEGORIES.has(row?.category) ? row.category : null;
      if (!category) continue;
      const key = String(row.key || "").trim();
      const email = String(row.email || "").trim().toLowerCase();
      const result = {
        category,
        realService: String(row.realService || "").slice(0, 120),
        // 300, not 200: the sentence now carries kind + what it implies + what changes the decision,
        // and 200 cut that mid-clause. Still capped — this lands in a table cell, not a paragraph.
        reason: String(row.reason || "").slice(0, 300),
      };
      if (key) out[key] = result;
      if (email) out[`email:${email}`] = result;
    }
  } catch (e) {
    console.warn("[gemini] batch failed", e?.message || e);
  }
  return out;
}

function parseJsonArray(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const unfenced = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    const v = JSON.parse(unfenced);
    return Array.isArray(v) ? v : null;
  } catch {
    /* try to extract array */
  }
  const start = unfenced.indexOf("[");
  const end = unfenced.lastIndexOf("]");
  if (start >= 0 && end > start) {
    try {
      const v = JSON.parse(unfenced.slice(start, end + 1));
      return Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  }
  return null;
}
