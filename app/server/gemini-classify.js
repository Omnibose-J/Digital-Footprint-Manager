import { loadGeminiApiKey } from "./load-local-config.js";

export { loadGeminiApiKey };

const BATCH_SIZE = 20;
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
 * @param {{ displayName?: string, names?: string[], email?: string, key?: string }[]} batch
 */
async function classifyBatch(apiKey, batch) {
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
- reason: one short Korean sentence saying what kind of mail this sender sends and why that means
  the user does (or does not) have an account there. Say the KIND — 가입/인증, 결제, 광고, 알림 —
  because that is what the user is deciding on. NEVER quote or paraphrase a subject line: the user
  can read their own mail, and repeating it back tells them nothing they did not have.
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
