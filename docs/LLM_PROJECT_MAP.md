# LLM Project Map

Ownership only: which directory answers which question. Refresh when module ownership or a
boundary below changes — not on every commit. For *what the product must do*, read
`PRODUCT_SPEC.md`; this file only says where things live.

## Entry points

| Entry | Path | Notes |
|---|---|---|
| Local dev | `app/run.mjs` (or `app/run.cmd`) | Spawns the server, health-checks `GET /`, opens a browser. A live port alone is not "up". |
| Server | `app/server/server.js` | Express. Product login + config + static mounts. Exported for Vercel via `app/api/index.js`. |
| Browser | `app/web/index.html` → `app/web/app.js` | The only module the page loads directly. |
| Deploy | `app/vercel.json` | Rewrites everything to `/api`. |

## The one-way boundary

`web/ → core/`. Nothing in `core/` imports from `web/`. That is why `core/` is unit-tested in
Node with no browser: `app/test/*.test.js` imports `../core/*` directly. Breaking this direction
breaks the test strategy, not just style.

`web/app.js` imports core as **URLs** (`/core/scan.js`), not relative paths, because the browser
resolves them over HTTP. Inside `core/`, files import each other relatively (`./filter.rules.js`)
— that works in both Node and the browser. Keep it that way.

## Static mounts (security-load-bearing)

`server.js` mounts `web/`, `core/`, and `data/` **by name**. Serving `app/` wholesale would
expose `.env` (`GOOGLE_CLIENT_SECRET`) and the server source over HTTP. If you add an asset
directory, mount it explicitly; never widen the root.

## app/core — the judgment (all unit-tested)

This is the product's reasoning, not its screen. It runs in the browser but is addressed by tests
as plain modules.

| Question | Owner |
|---|---|
| Which senders exist in the mailbox? | `scan.js` — Gmail metadata fetch. The access token never leaves the browser. |
| Is this sender a service or a person, and what does the mail mean? | `filter.js` — sender reduction, registrable-domain grouping, message classification, aggregation. The largest module. |
| What counts as marketing / free mailbox / relay / payment gateway? | `filter.rules.js` — data tables only, no logic. Tune rules here. |
| Is this mail forged? | `authenticity.js` — reads only the `mx.google.com` authserv-id block. Never the first block found, never ARC. |
| **Does this account exist?** | `score.js` — `discoveryScore` + bands. Counts distinct months, no time decay. |
| **Should this account be cleaned up first?** | `cleanup.js` — `cleanupScore`. A *different question* from the above; assumes the account exists. Recent-use signal blocks recommendation. |
| What did the user say about it? | `verdict.js` — session overrides applied onto a fresh snapshot. Pure on purpose. |
| How does one actually delete this service? | `catalog.js` — loads and matches the catalog; `guide.js` — renders the deletion-guide modal, checklist, and Korean request template. |
| Analytics | `analytics.js` — **boundary rule**: no identifier read out of the mailbox (domain, service name) may reach its callers' events. |
| HTML escaping | `html.js` — shared by `guide.js` and `web/app.js`; lives in core so the dependency stays one-way. |

Scores are two separate questions. Conflating `discoveryScore` (does it exist?) with
`cleanupScore` (clean it first?) is the most common misreading here.

## app/web — the screen

`app.js` wires DOM events to core functions and owns all rendering into the page; `app.css` and
`index.html` are its only companions. No product judgment belongs here — if you are writing a
rule, it goes in `core/`.

## app/data

`catalog.json` — the researched Korean-service deletion routes. Data, not code; served at
`/data/catalog.json`. It is large: grep it, don't read it whole.

## app/server

Product login (Google Identity), `/api/config`, session cookie, CSP, and the static mounts.
It never receives, reads, or stores mail — that promise is the product's whole differentiator
(`PRODUCT_SPEC.md` §6). Any change here that touches mail data contradicts the spec.

## app/test

`test/*.test.js` — unit, over `core/`, run by `npm test`. `catalog.test.js` also reads
`data/catalog.json` from disk, so a malformed catalog fails the unit suite, not just the browser.
`test/e2e/` — Playwright against the real server with a faked Google Identity and Gmail
(`harness.js`); run by `npm run test:e2e`. Only what we do not own is faked.

## docs

| Path | Status |
|---|---|
| `PRODUCT_SPEC.md` | **The contract.** Current (v2, core MVP). §8 holds the decision log. |
| `archive/` | Superseded or rejected. **Not valid.** `product-spec-v1-full.md` is the pre-descope v1; `naver-imap-design.md` is deferred and explicitly not an approved plan. |
| `tracking/findings.md` | Known, verified, deliberately unfixed problems with the reason and cost. |
| `LLM_PROJECT_MAP.md` | This file. |

Ignored on disk but present: `app/node_modules/`, `app/sow/`, `app/test-results/`, `app/.vercel`.
Prefer `git ls-files` over directory scans.
