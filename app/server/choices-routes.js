/**
 * SOW 001 API — contract frozen in docs/sow/001-cleanup-labels-db.md §3.
 * user_id comes from the session only. A user_id in the body is ignored.
 */

import { Router } from "express";

const CHOICES = new Set(["in_use", "unused"]);

/**
 * @param {{
 *   getSession: (req: import('express').Request) => Promise<{ sub: string } | null>,
 *   isSameOrigin: (req: import('express').Request) => boolean,
 *   db: {
 *     listByUser(userId: string): Promise<Array<{ domain: string, choice: string, labeledAt: string }>>,
 *     upsert(row: object): Promise<void>,
 *     deleteOne(userId: string, domain: string): Promise<void>,
 *     deleteAll(userId: string): Promise<number>,
 *   },
 * }} deps
 */
export function createChoicesRouter(deps) {
  const { getSession, isSameOrigin, db } = deps;
  const router = Router();

  async function requireSession(req, res) {
    if (!isSameOrigin(req)) {
      res.status(403).json({ error: "cross-origin" });
      return null;
    }
    const session = await getSession(req);
    if (!session) {
      res.status(401).json({ error: "로그인이 필요합니다." });
      return null;
    }
    return session;
  }

  function dbUnavailable(res, err) {
    if (err && err.code === "CHOICES_DB_UNCONFIGURED") {
      res.status(503).json({ error: "choices store not configured" });
      return true;
    }
    console.error("[choices]", err?.message || err);
    res.status(500).json({ error: "choices store failed" });
    return true;
  }

  /** GET /api/choices → { choices: { [domain]: { choice, labeledAt } } } */
  router.get("/api/choices", async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) return;
    try {
      const rows = await db.listByUser(session.sub);
      /** @type {Record<string, { choice: string, labeledAt: string }>} */
      const choices = {};
      for (const row of rows) {
        choices[row.domain] = { choice: row.choice, labeledAt: row.labeledAt };
      }
      res.json({ choices });
    } catch (err) {
      dbUnavailable(res, err);
    }
  });

  /** PUT /api/choices/:domain — upsert; body.user_id is ignored */
  router.put("/api/choices/:domain", async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) return;

    const domain = normalizeDomain(req.params.domain);
    if (!domain) {
      res.status(400).json({ error: "domain required" });
      return;
    }

    const choice = req.body?.choice;
    if (!CHOICES.has(choice)) {
      res.status(400).json({ error: "choice must be in_use or unused" });
      return;
    }

    // Scores are advisory and may be null — a label can land before the catalog pass.
    const cleanupScore = optionalInt(req.body?.cleanupScore);
    const discoveryScore = optionalInt(req.body?.discoveryScore);
    const cleanupBand = optionalString(req.body?.cleanupBand);
    const discoveryBand = optionalString(req.body?.discoveryBand);

    try {
      await db.upsert({
        userId: session.sub,
        domain,
        choice,
        cleanupScore,
        cleanupBand,
        discoveryScore,
        discoveryBand,
      });
      res.json({ ok: true });
    } catch (err) {
      dbUnavailable(res, err);
    }
  });

  /** DELETE /api/choices/:domain */
  router.delete("/api/choices/:domain", async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) return;

    const domain = normalizeDomain(req.params.domain);
    if (!domain) {
      res.status(400).json({ error: "domain required" });
      return;
    }

    try {
      await db.deleteOne(session.sub, domain);
      res.json({ ok: true });
    } catch (err) {
      dbUnavailable(res, err);
    }
  });

  /** DELETE /api/me/data — every row for the session user only */
  router.delete("/api/me/data", async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) return;
    try {
      const deleted = await db.deleteAll(session.sub);
      res.json({ deleted });
    } catch (err) {
      dbUnavailable(res, err);
    }
  });

  return router;
}

function normalizeDomain(raw) {
  const d = String(raw || "")
    .trim()
    .toLowerCase();
  if (!d || d.includes("/") || d.includes(" ") || d.length > 253) return "";
  return d;
}

function optionalInt(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function optionalString(v) {
  if (v === undefined || v === null || v === "") return null;
  return String(v);
}
