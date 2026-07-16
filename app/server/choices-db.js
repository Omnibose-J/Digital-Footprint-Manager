/**
 * Persistence for user_service_choice (SOW 001 labels + SOW 002 completion).
 * Supabase is reached server-side only; the browser never sees the URL or key.
 * Client construction is lazy — Vercel Functions must not open a pool at module load.
 */

import { createClient } from "@supabase/supabase-js";

const TABLE = "user_service_choice";

/**
 * @typedef {{
 *   userId: string,
 *   domain: string,
 *   choice: 'in_use'|'unused',
 *   cleanupScore: number|null,
 *   cleanupBand: string|null,
 *   discoveryScore: number|null,
 *   discoveryBand: string|null,
 *   labeledAt: string,
 *   withdrawnAt: string|null,
 *   unsubscribedAt: string|null,
 * }} ChoiceRow
 */

/**
 * In-memory store for integration tests. Same shape as the Supabase store.
 */
export function createMemoryChoicesStore() {
  /** @type {Map<string, ChoiceRow>} */
  const rows = new Map();
  const key = (userId, domain) => `${userId}\0${domain}`;

  return {
    async listByUser(userId) {
      return [...rows.values()].filter((r) => r.userId === userId);
    },
    async upsert(row) {
      const k = key(row.userId, row.domain);
      const existing = rows.get(k);
      const labeledAt = row.labeledAt || new Date().toISOString();
      // Preserve completion timestamps across a label re-write (PUT does not send them).
      rows.set(k, {
        withdrawnAt: null,
        unsubscribedAt: null,
        ...existing,
        ...row,
        labeledAt,
      });
    },
    async deleteOne(userId, domain) {
      rows.delete(key(userId, domain));
    },
    async deleteAll(userId) {
      let n = 0;
      for (const [k, r] of rows) {
        if (r.userId === userId) {
          rows.delete(k);
          n += 1;
        }
      }
      return n;
    },
    /**
     * Patch completion flags. Returns null when no label row exists (→ 404).
     * Server stamps time; never trusts a client timestamp.
     * @param {string} userId
     * @param {string} domain
     * @param {{ withdrawn?: boolean, unsubscribed?: boolean }} patch
     * @returns {Promise<{ withdrawnAt: string|null, unsubscribedAt: string|null } | null>}
     */
    async updateStatus(userId, domain, patch) {
      const k = key(userId, domain);
      const row = rows.get(k);
      if (!row) return null;
      const now = new Date().toISOString();
      if (patch.withdrawn === true) row.withdrawnAt = now;
      else if (patch.withdrawn === false) row.withdrawnAt = null;
      if (patch.unsubscribed === true) row.unsubscribedAt = now;
      else if (patch.unsubscribed === false) row.unsubscribedAt = null;
      rows.set(k, row);
      return { withdrawnAt: row.withdrawnAt, unsubscribedAt: row.unsubscribedAt };
    },
  };
}

/**
 * @param {{ url?: string, serviceRoleKey?: string }} [env]
 */
export function createSupabaseChoicesStore(env = {}) {
  const url = env.url ?? process.env.SUPABASE_URL ?? "";
  const serviceRoleKey = env.serviceRoleKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

  /** @type {ReturnType<typeof createClient> | null} */
  let client = null;

  function supabase() {
    if (!url || !serviceRoleKey) {
      const err = new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured");
      err.code = "CHOICES_DB_UNCONFIGURED";
      throw err;
    }
    if (!client) {
      // No session persistence: this is a per-request serverless caller, not a browser.
      client = createClient(url, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
    }
    return client;
  }

  return {
    /** @param {string} userId */
    async listByUser(userId) {
      const { data, error } = await supabase()
        .from(TABLE)
        .select(
          "user_id, domain, choice, cleanup_score, cleanup_band, discovery_score, discovery_band, labeled_at, withdrawn_at, unsubscribed_at"
        )
        .eq("user_id", userId);
      if (error) throw error;
      return (data || []).map(fromDb);
    },

    /**
     * @param {Omit<ChoiceRow,'labeledAt'|'withdrawnAt'|'unsubscribedAt'> & { labeledAt?: string }} row
     */
    async upsert(row) {
      const labeledAt = row.labeledAt || new Date().toISOString();
      // Do not send completion columns — a label upsert must not wipe withdrawn_at / unsubscribed_at.
      const { error } = await supabase().from(TABLE).upsert(
        {
          user_id: row.userId,
          domain: row.domain,
          choice: row.choice,
          cleanup_score: row.cleanupScore,
          cleanup_band: row.cleanupBand,
          discovery_score: row.discoveryScore,
          discovery_band: row.discoveryBand,
          labeled_at: labeledAt,
        },
        { onConflict: "user_id,domain" }
      );
      if (error) throw error;
    },

    /** @param {string} userId @param {string} domain */
    async deleteOne(userId, domain) {
      const { error } = await supabase()
        .from(TABLE)
        .delete()
        .eq("user_id", userId)
        .eq("domain", domain);
      if (error) throw error;
    },

    /** @param {string} userId @returns {Promise<number>} */
    async deleteAll(userId) {
      const { data, error } = await supabase()
        .from(TABLE)
        .delete()
        .eq("user_id", userId)
        .select("domain");
      if (error) throw error;
      return (data || []).length;
    },

    /**
     * @param {string} userId
     * @param {string} domain
     * @param {{ withdrawn?: boolean, unsubscribed?: boolean }} patch
     * @returns {Promise<{ withdrawnAt: string|null, unsubscribedAt: string|null } | null>}
     */
    async updateStatus(userId, domain, patch) {
      const { data: existing, error: readErr } = await supabase()
        .from(TABLE)
        .select("withdrawn_at, unsubscribed_at")
        .eq("user_id", userId)
        .eq("domain", domain)
        .maybeSingle();
      if (readErr) throw readErr;
      if (!existing) return null;

      const now = new Date().toISOString();
      /** @type {Record<string, string|null>} */
      const update = {};
      if (patch.withdrawn === true) update.withdrawn_at = now;
      else if (patch.withdrawn === false) update.withdrawn_at = null;
      if (patch.unsubscribed === true) update.unsubscribed_at = now;
      else if (patch.unsubscribed === false) update.unsubscribed_at = null;

      if (Object.keys(update).length === 0) {
        return {
          withdrawnAt: existing.withdrawn_at ? new Date(existing.withdrawn_at).toISOString() : null,
          unsubscribedAt: existing.unsubscribed_at
            ? new Date(existing.unsubscribed_at).toISOString()
            : null,
        };
      }

      const { data, error } = await supabase()
        .from(TABLE)
        .update(update)
        .eq("user_id", userId)
        .eq("domain", domain)
        .select("withdrawn_at, unsubscribed_at")
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return {
        withdrawnAt: data.withdrawn_at ? new Date(data.withdrawn_at).toISOString() : null,
        unsubscribedAt: data.unsubscribed_at ? new Date(data.unsubscribed_at).toISOString() : null,
      };
    },
  };
}

/** Lazy singleton for production. Tests inject their own store via createApp. */
let _defaultStore = null;

export function getChoicesDb() {
  if (!_defaultStore) {
    _defaultStore = createSupabaseChoicesStore();
  }
  return _defaultStore;
}

/** @param {Record<string, unknown>} row */
function fromDb(row) {
  return {
    userId: String(row.user_id),
    domain: String(row.domain),
    choice: row.choice,
    cleanupScore: row.cleanup_score == null ? null : Number(row.cleanup_score),
    cleanupBand: row.cleanup_band == null ? null : String(row.cleanup_band),
    discoveryScore: row.discovery_score == null ? null : Number(row.discovery_score),
    discoveryBand: row.discovery_band == null ? null : String(row.discovery_band),
    labeledAt: new Date(row.labeled_at).toISOString(),
    withdrawnAt: row.withdrawn_at == null ? null : new Date(row.withdrawn_at).toISOString(),
    unsubscribedAt: row.unsubscribed_at == null ? null : new Date(row.unsubscribed_at).toISOString(),
  };
}
