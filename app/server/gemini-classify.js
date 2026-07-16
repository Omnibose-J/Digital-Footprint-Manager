import { loadGeminiApiKey } from "./load-local-config.js";

export { loadGeminiApiKey };

const BATCH_SIZE = 20;
const MODEL = "gemini-1.5-flash";
const CATEGORIES = new Set(["가입서비스", "개인메일", "기타"]);

/**
 * @param {{ displayName?: string, email?: string, key?: string }[]} senders
 * @returns {Promise<Record<string, { category: string, realService: string, reason: string }>>}
 */
export async function classifySendersWithGemini(senders) {
  const apiKey = loadGeminiApiKey();
  const byKey = {};

  if (!apiKey) {
    console.warn("[gemini] GEMINI_API_KEY missing in src/lib/config.ts");
    return byKey;
  }

  const list = Array.isArray(senders) ? senders : [];
  for (let i = 0; i < list.length; i += BATCH_SIZE) {
    const batch = list.slice(i, i + BATCH_SIZE);
    const batchResults = await classifyBatch(apiKey, batch);
    Object.assign(byKey, batchResults);
  }
  return byKey;
}

/**
 * @param {string} apiKey
 * @param {{ displayName?: string, email?: string, key?: string }[]} batch
 */
async function classifyBatch(apiKey, batch) {
  const out = {};
  const payload = batch.map((s) => ({
    key: s.key || "",
    displayName: String(s.displayName || "").slice(0, 200),
    email: String(s.email || "").slice(0, 200),
  }));

  const prompt = `You classify email senders for a Korean digital-footprint tool.
You receive ONLY display name + email address. Never invent mail body content.

For EACH sender, return:
- category: exactly one of "가입서비스" | "개인메일" | "기타"
  · 가입서비스 = automated mail from a service where the user likely has an account
  · 개인메일 = a real person (including the user themselves)
  · 기타 = ads, doc-share noise, relays, or anything else
- realService: the real product/brand name if inferable (e.g. Stripe mail may be "Cursor"). If unknown, use the brand from the domain/name or "".
- reason: one short Korean sentence explaining the classification
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
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
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
        reason: String(row.reason || "").slice(0, 200),
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
