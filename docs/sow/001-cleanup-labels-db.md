# SOW 001 — Cleanup labels: Supabase + API

**Owner of this SOW:** backend. Frontend works against §3 (the contract) in parallel and does not
wait for you. Nothing here touches the scan, the Gmail path, or `core/`.

**Read first:** `PRODUCT_SPEC.md` §6 (the pilot label row), §8 ("The pilot keeps individual cleanup
labels, and says when it stops"). That decision is what this SOW implements. It is **pilot
instrumentation with a scheduled exit**, not a feature — build it so that dropping one table and
three routes removes it completely.

## 1. Goal

The user labels a service 사용 / 미사용. Today that lands in `localStorage`, which §8's storage
decision already ruled out: a device switch or Safari's 7-day eviction loses it silently, and a
re-scan rebuilds the candidate list but cannot rebuild what the user told us. Move it to Postgres,
keyed to the signed-in user, and give the owner a way to read it.

## 2. Schema

```sql
create table user_service_choice (
  user_id         text        not null,   -- Google `sub`. NEVER the email address.
  domain          text        not null,   -- registrable domain, e.g. "coupang.com"
  choice          text        not null check (choice in ('in_use','unused')),

  -- What WE said at the moment they answered. Do not drop these to "save space":
  -- the whole point of the table is `cleanup_band='recommended' AND choice='in_use'`,
  -- and that comparison is meaningless once the scoring rules move. They will move.
  cleanup_score   int,
  cleanup_band    text,                   -- 'recommended' | 'review' | 'keep_or_watch' | null
  discovery_score int,
  discovery_band  text,                   -- 'high' | 'review' | 'low'

  labeled_at      timestamptz not null default now(),
  primary key (user_id, domain)
);
```

**Forbidden columns, permanently** (§3's list applies here unchanged): subject, sender address,
message/thread id, any mail body, any OAuth token. The registrable domain is the only mail-derived
value allowed in this table.

`user_id` is `sub` and not the address, deliberately: the table alone must not name a mailbox.

## 3. API contract — FROZEN, frontend is building against exactly this

Every route: session required via the existing `getSession(req)`; 401 when it returns null;
same-origin check like `/api/classify-senders` already does.

**`user_id` comes from the session and only from the session.** A `user_id` in a request body is an
attack, not an input — there is no route here where the client names the user (§5: "Every Route
Handler rechecks user ownership"; cross-user ids must 403/404, and that is a test, not a promise).

| Method | Path | Request body | 200 response |
|---|---|---|---|
| GET | `/api/choices` | — | `{ "choices": { "coupang.com": { "choice": "unused", "labeledAt": "2026-07-16T..." } } }` |
| PUT | `/api/choices/:domain` | `{ choice, cleanupScore, cleanupBand, discoveryScore, discoveryBand }` | `{ "ok": true }` |
| DELETE | `/api/choices/:domain` | — | `{ "ok": true }` |
| DELETE | `/api/me/data` | — | `{ "deleted": <int> }` |

- `PUT` is an upsert on `(user_id, domain)` — the user re-labels freely, last write wins, and
  `labeled_at` moves with it. Validate `choice` against the enum and reject anything else with 400;
  the score fields are advisory and may be null (a row can be labelled before the catalog pass lands).
- `GET /api/choices` returns `{}` for a signed-in user with no labels. Not 404.
- `DELETE /api/me/data` deletes every row for the session's `user_id`. §6's retention row and §2's
  "Full app-data export and deletion" require it the moment we store anything.
- **Export is deliberately not in this SOW.** §2 wants it; the pilot can answer a request by hand
  and the frontend has nowhere to put the button yet. Do not build it; do not let its absence block
  the delete route, which is the half that actually protects someone.

## 4. Owner metrics — read path

The owner reads **individual rows** (§8: an aggregate says "12% wrong" and cannot say which rule is
wrong). Serve this from a Supabase view or RPC, not from the client, and not by handing anyone the
table:

```sql
-- the number §7's cleanup gate is defined by
create view cleanup_false_positive as
select domain,
       count(*) filter (where choice = 'in_use')  as said_in_use,
       count(*)                                    as recommended_n
from user_service_choice
where cleanup_band = 'recommended'
group by domain;
```

**Never full-scan `user_service_choice` from a request path.** Supabase bills egress and this exact
mistake — analysis reads against a live table — has already cost this owner ~9GB on another project.
Metrics are an aggregate view or an offline query; per-row inspection is the dashboard, by hand.

## 5. Constraints

- **Serverless driver or pooler, lazy init** (§5). Vercel Functions are per-request; a client
  constructed at module top-level exhausts the connection limit under any real traffic.
- Nothing in this SOW may import from `core/` or touch the Gmail path. If you find yourself needing
  a scan value, it comes through the API body from the browser, not from the server reading mail.
- No new CSP origin. Supabase is called **server-side only** — the browser talks to `/api/*` and
  nothing else. If you catch yourself adding `*.supabase.co` to `connect-src` in `server.js`, the
  design went wrong: that would put the DB (and its key) in the client.
- Secrets in `.env` (`app/.env.example` documents every key the app reads — **add yours to it**).
  Never `NEXT_PUBLIC_`-style client exposure. The service key never reaches the browser.

## 6. Acceptance — each line is a command, not an opinion

- [ ] `PUT` then `GET` round-trips a label for the signed-in user → integration test, exit 0
- [ ] A second user's session cannot read or write the first user's rows → test asserts 401/403/empty, exit 0
- [ ] A `user_id` supplied in the request body is ignored → test, exit 0
- [ ] `PUT` with `choice: "banana"` → 400, row unchanged → test, exit 0
- [ ] `DELETE /api/me/data` removes exactly that user's rows and no one else's → test, exit 0
- [ ] Unauthenticated request to every route → 401 → test, exit 0
- [ ] `npm test` still green (161 baseline, exit 0) — **do not edit existing tests to get there**
- [ ] `app/.env.example` lists every new key
- [ ] No `*.supabase.co` in `server.js`'s CSP

## 7. Out of scope — do not build

Export endpoint (§3 above). Cross-user learning of any kind — §8 rejected it explicitly; the labels
feed no model. Any change to `core/`, the scan, scoring rules, or the UI. Auth changes: the Google
ID-token session already works and issues the `sub` this table is keyed on; do not introduce Supabase
Auth alongside it.
