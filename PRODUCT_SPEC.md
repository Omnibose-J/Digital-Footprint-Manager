---
title: Digital Footprint Manager - Core MVP Specification
version: 2.0
as_of: 2026-07-15
status: Proposed MVP, descoped to the core loop (full v1 archived as PRODUCT_SPEC_v1_full.md)
audience: Product and implementation agents
language: English for agent readability; user-facing UI remains Korean
---

# Digital Footprint Manager

## 1. Product Contract

### One-line definition

Find account candidates from the user's Gmail evidence, and guide the user through official deletion paths for the accounts they no longer want. The MVP does nothing else.

### Core loop

1. Connect Gmail through a user-initiated OAuth flow; scan runs in the browser.
2. Review account candidates with evidence and confidence; confirm `owned`, `not_mine`, or `unsure`.
3. Pick accounts to clean up — the cleanup score orders the list, the user decides — then follow the deletion guide and mark completion manually.

### Required product language

- Say `account candidate`, not `account`, until the user confirms ownership or evidence is strong.
- Say `discovery confidence`, not `certainty`.
- Say `last email evidence`, not `last login` or `last use`.
- Say `guided deletion`, not `automatic deletion` or `one-click deletion`.
- Say `cleanup score`, not `security score` or `breach probability`.

## 2. Scope

### In scope (MVP)

- Web experience on Vercel (Next.js App Router); no extension, ever, in this MVP.
- Gmail invited-user pilot, then public OAuth release after restricted-scope verification.
- In-browser Gmail scan, evidence aggregation, and discovery confidence.
- User ownership confirmation and a cleanup list.
- Korea-first deletion-guide catalog for the top 50 services found in the pilot: official links, prerequisites, Korean request template, minimal status tracking.
- Full app-data export and deletion.

### Complement, do not compete: the Korean public rail

**정보주체 권리행사** (formerly e프라이버시 클린서비스, now operated under privacy.go.kr — do not hardcode `eprivacy.go.kr` as the entry point) already lists sites where the user passed Korean identity verification and relays withdrawal requests to them via KISA, free [S8]. Two facts define the boundary between it and this product:

- **Its rail is 본인확인, not email.** Email-only signups, foreign services, and social-login accounts never appear there — that set is ours.
- **Its lookback is shorter than commonly reported.** Not a flat five years: 휴대폰 본인확인 (the most common Korean method) reaches back only **1 year**; 신용카드 2 years; 주민등록번호/아이핀 5 years [S8]. Any copy claiming "5 years" is wrong for most users.

Its withdrawal service is a KISA best-effort *relay*, not guaranteed deletion, and it splits sites into 회원탈퇴 신청 versus 직접 탈퇴 필요. Route to it via the `public_service` deletion route (§4); never reimplement it. There is no personal API — the data.go.kr dataset that appears to be one returns annual aggregate statistics only.

### Deferred (cut from MVP; revisit only after the core loop proves out)

Breach-data integration (see the HIBP note below), reminder emails and all scheduled jobs, monetization features, manual account creation, Outlook, Naver/Daum mailboxes (§8), any Chrome extension (§8), multiple email accounts, periodic rescan, English request template, family plan.

**HIBP, when it returns, is a foreign-service supplement — never the discovery backbone.** The reframe is mechanically sound: `/breachedaccount` with `truncateResponse=false` returns each breach's `Domain`, so a breach list is a list of services the user had an account with, including ones whose mail is long deleted. Three facts cap its value [S31]:

- **Korean coverage is ~nil**: 1 of 1,016 live breaches carries a `.kr` domain (`ggumim.co.kr`). Nate/Cyworld — Korea's largest breach — is absent. It finds Adobe and LinkedIn, not the Korean long tail.
- **Email k-anonymity exists** (shipped 2026-03-30, 6-char prefix on `/breachedaccount/range`) but is gated to the **Pro tier at $379/mo**; direct lookup is $4.39/mo but sends the raw address. Budget accordingly — the v1 archive's k-anonymity plan is real but was priced as if it were a Core-tier feature.
- **Stealer logs are unreachable**, not merely expensive: `/stealerlogsbyemail` returns exactly the domain list we want, but requires the searched email's *domain* to be verified in our dashboard. Nobody can verify `gmail.com`. Structurally dead for a consumer product at any price.

When integrated, breach association appears as a badge/filter, never as cleanup-score points. Attribution to haveibeenpwned.com is mandatory (CC BY 4.0).

### Hard exclusions (never in this product)

- Browser history, cookies, tabs, or browsing-activity analysis. No extension ships in the MVP at all (§8).
- Password-manager data in any form. Not merely because extension APIs cannot read saved passwords (`passwordsPrivate` is Chrome-internal), but because the one path that *does* work is refused on purpose: see the vault-import decision in §8.
- Public-web searches using a person's name, email, phone, or aliases.
- Automatic login, scripted clicking, automatic request submission, or account deletion.
- Collection or relay of passwords, MFA codes, ID documents, or authentication cookies.
- Treating a missing email as proof that an account is inactive.
- Minors, deceased-user accounts, enterprise identity governance, or employee offboarding.
- Advertising use, retargeting, data sale, or human mail-content review.

## 3. Core Feature 1 - Account Discovery

### Gmail constraint

Gmail search through `users.messages.list(q=...)` cannot use the `gmail.metadata` scope. Search-based discovery requires `gmail.readonly`, which Google classifies as restricted: a public application requires OAuth verification, and server-side access to restricted data can trigger an annual third-party security assessment. Therefore all Gmail access stays in the browser [S1-S4].

### Processing boundary

- Google Identity Services in the browser; access token in browser memory only; no refresh token.
- Call Gmail directly from the browser; request message IDs and only the headers needed for extraction; never fetch bodies or attachments.
- Never send raw message bodies, subjects, or full sender addresses to the product backend.
- Send normalized candidate data only after user review.

### Scan budget

Gmail's per-user ceiling is **6,000 quota units/minute**, and `messages.get` costs **20 units** — so metadata fetches are hard-capped at **~5/second (300/min) per user**, and batching does not help (a batch of n counts as n requests; it saves HTTP overhead only). `messages.list` costs 5 units per page of up to 500 IDs, making ID enumeration effectively free. Verify these figures at build time: a 2026-05-01 release note states `messages.get` unit costs are changing under a new tiering model [S24].

This makes the fetch fan-out ~99.9% of scan cost and forbids a monolithic scan:

- **Cheap first — catalog probes.** For each catalog service, `messages.list(q="from:{domain} after:{date}")` costs 5 units and needs no fetch. Probing the whole top-50 catalog costs ~250 units (under 3 seconds) and resolves the most common services before any fetch. Treat `resultSizeEstimate` as a presence/absence signal only, never as a count — verify its reliability empirically before depending on it.
- **Expensive second — long-tail fetches**, priority-ordered: signup/verification, then auth/security, then transaction/subscription, then service notifications. Strongest evidence resolves first.
- **Render progressively.** Candidates appear as they resolve; the scan continues in the background. The §7 five-minute gate is time-to-first-10-high-confidence-candidates (~300 fetches ≈ 1 minute), not time-to-complete-scan.
- **Caps:** 500 message IDs per family; **1,200 metadata fetches per scan (≈ 4 minutes at the quota ceiling)**. Pace to the quota rather than a fixed concurrency; exponential backoff on `429`/`5xx`.
- Default to the most recent ten years. If a cap is reached, label the result `partial scan` with the covered period and truncated families. Never promise exhaustive discovery; the user may run an older window later.

### Signal families and confidence

Signal families: (1) signup/verification, (2) password reset and login-security alerts, (3) transactions/subscriptions, (4) repeated non-marketing service notifications. Newsletter and marketing mail never independently establishes ownership.

Family assignment uses two inputs, because Korean/English keyword queries alone are brittle:

- **Gmail's own categories**, which are language-independent and already computed by Google: `category:purchases` and `category:reservations` (beyond the four visible tabs) map to the transaction family; `category:updates` carries most transactional mail; `category:promotions` marks marketing. Note the `q` parameter is unavailable under the `gmail.metadata` scope, so categories are reachable only on the `gmail.readonly` path we already chose. Category labels also appear as `CATEGORY_*` label IDs on the message resource — check whether `labelIds` filtering works as an alternative to `q` [S2].
- **Keyword queries** for what categories miss, and **post-fetch header inspection** for classification. Gmail cannot search arbitrary RFC headers (only `rfc822msgid:` and `deliveredto:`), so `List-Unsubscribe`, `List-Unsubscribe-Post` (RFC 8058), `List-ID` (RFC 2919), `Auto-Submitted` (RFC 3834), and `Precedence: bulk` are fetched via `metadataHeaders` and used as weighted marketing features — never as a binary classifier. Google mandates one-click unsubscribe only for marketing senders above 5,000 messages/day, does not forbid transactional senders from including it, and explicitly leaves the marketing/transactional judgment to recipients rather than defining it structurally [S25][S26].

Evidence is scored per family with a cap, so repetition inside one family cannot inflate confidence. Counting is by distinct month (an OTP burst in one day counts once):

| Family | Scoring | Family cap |
|---|---|---:|
| Signup/verification | Verification-complete ("이메일 인증 완료") 55; welcome/signup-complete 40 | 55 |
| Auth/security | Password reset, login alert, OTP: 35 first, +10 for a second distinct month | 45 |
| Transaction/subscription | 10 per distinct month; recurring renewals in >= 3 distinct months floor the family at 25 | 30 |
| Service notification (non-marketing) | 5 per distinct month | 15 |
| Marketing | Flat 5; never contributes to `high` alone | 5 |

`discoveryScore = min(100, sum of family scores)`. Bands: `high` >= 70, `review` 40-69, `low` <= 39.

Worked examples: verification 55 + password reset 35 = 90 `high`. Welcome 40 + reset 35 = 75 `high`. Welcome alone = 40 `review` (misparse possible; needs corroboration or user confirmation). Recurring subscription 25 + notifications 15 = 40 `review` (guest checkout or family member's subscription remains possible — correctly not `high`).

**Classify marketing leniently — the two errors are not symmetric.** Calling transactional mail "marketing" strips it from `lastSeenMonth`, making an active account look dormant and pushing it toward a deletion recommendation: the worst failure mode. Calling marketing "transactional" only inflates recency, which makes an account look *alive* and trips the in-use guard — conservative. Discovery precision is protected separately by the flat-5 marketing cap (a newsletter-only sender maxes out in the `low` band and cannot become a high-confidence false positive), so there is nothing to gain by filtering aggressively. When a message is ambiguous, do not call it marketing.

Hard rules on top of the score:

- **Authenticity gate:** an evidence mail counts only if it passes authentication, so phishing cannot mint candidates. `Authentication-Results` is a forgeable plain header, so three rules are mandatory: read **only the instance whose authserv-id is `mx.google.com`** (upstream hops can stamp their own; never take the first one found, and never read `ARC-Authentication-Results`); prefer Gmail's own `dmarc=pass` verdict with `header.from=` over re-deriving DKIM alignment by hand, which duplicates logic Gmail already ran and drifts on relaxed-vs-strict rules; and expect multiple `dkim=` entries with different `header.d=` values — Gmail checks up to five signatures, so a single-`d=` parser is wrong [S27].
- **Negative evidence:** an account-closure/withdrawal-confirmation mail newer than the latest positive evidence marks the candidate `likely_closed` (badge, excluded from the cleanup list; user may confirm). The same detector doubles as a completion hint in the §4 status flow.
- **Existence does not decay:** recency never changes `discoveryScore`; a 2015 signup with no mail since is still an account until closed.
- **User loop:** `owned` overrides the score upward (confirmed); `not_mine` drops the candidate and suppresses that `service_id` for this user in future scans; `unsure` stays in `review` regardless of score. The `not_mine` rate within the `high` band is the §7 precision gate.

### The social-login blind spot

Accounts created via social login (Kakao/Google/Naver) may leave no email evidence at all, so absence from the list never means absence of an account — state this as fixed UI text, not a footnote.

This gap cannot be engineered away. **Every platform allows revoke and forbids enumerate**: Google has no consumer API for the `myaccount.google.com/connections` list (Drive's `apps.list` covers only Drive-authorized apps; Admin SDK `tokens.list` is Workspace-domain-admin only, and a `@gmail.com` account has no domain); Kakao's REST surface offers `unlink` but no listing (`/v1/user/ids` lists *our own app's* users — a trap, not the connections list); Naver offers only RFC 7009 token revocation and directs users to 내정보 > 연결된 서비스 관리. Google Takeout does not export the connections list either [S32][S33].

The only available answer is user-guided: link the user to each platform's connections page and let them add services by hand. Cheap (links and copy, no integration), partial, and honest. Kakao's connection list at least shows 연결일.

Normalization: parse sender domain and headers locally, resolve the registrable domain, map sender-domain aliases to one `service_id` through the catalog, and never merge two brands without an explicit catalog relationship.

### Persisted candidate schema

```ts
type CandidateStatus = 'owned' | 'not_mine' | 'unsure';
type DiscoveryBand = 'high' | 'review' | 'low';

interface AccountCandidate {
  id: string;
  userId: string;
  serviceId: string;
  canonicalDomain: string;
  evidenceTypes: Array<'signup' | 'auth' | 'security' | 'transaction' | 'subscription' | 'marketing'>;
  evidenceCount: number;
  firstSeenMonth: string; // YYYY-MM
  lastSeenMonth: string;  // YYYY-MM, non-marketing evidence only
  discoveryScore: number;
  discoveryBand: DiscoveryBand;
  userStatus: CandidateStatus;
  createdAt: string;
  updatedAt: string;
}
```

Forbidden persisted fields: message body, attachment, full subject, full sender address, Gmail message/thread ID after scan completion, OAuth access or refresh token.

### Recency rule

`lastSeenMonth` counts only non-marketing evidence (signup, auth, security, transaction, subscription). Marketing mail must never refresh recency: a dormant account that still receives newsletters would otherwise look active. The inverse bias also exists — a service used daily that sends no mail looks dormant — so the UI always labels this value `last email evidence`, never `last use`.

### Recency, and its honest limits

Recency = `lastSeenMonth` (non-marketing evidence only). It feeds the cleanup score in §4 and never changes `discoveryScore`.

Email recency is a **weak proxy for actual use**, and the MVP ships no second source (no extension, §8). The bias runs in one direction that matters: a service used daily that sends no mail looks dormant, which is exactly the input that could make the product recommend deleting an account the user actively relies on — the worst failure mode. Three compensations, all web-only:

- Marketing mail never refreshes recency, so newsletters cannot make a dead account look alive (the opposite error).
- The UI labels this value `last email evidence`, never `last use`, and the §4 in-use guard blocks a `recommended` verdict on any recency-ambiguous item.
- For a candidate the user genuinely cannot judge, the authoritative answer is the service's own: a PIPA Article 35 access request asks for 가입일 and 최근 접속일 directly. Slow (10-day statutory response) and worth it only for the few items blocking a decision — a template variant of the `email_request` route (§4), not a separate feature.

## 4. Core Feature 2 - Guided Deletion

### Cleanup score (what to tackle first)

Computed only for candidates confirmed `owned`, or `high`-band and not rejected by the user. It is an ordering aid built strictly from data the MVP already produces — never a breach probability or a security grade.

```text
cleanup_score = dormancy (0-40) + data_sensitivity (0-30)
              + payment_surface (0-15) + cleanup_readiness (0-15)
```

| Axis | Range | Rule |
|---|---:|---|
| Dormancy | 0-40 | recency (`lastSeenMonth`): over 36 months 40; 24-36 30; 12-24 18; under 12 0. `owned` with no non-marketing evidence at all: 25 |
| Data sensitivity | 0-30 | catalog category: finance/health/identity/cloud/email 30; shopping 20; productivity/social 15; community/other 8 |
| Payment surface | 0-15 | transaction/subscription evidence in >= 2 distinct months 15; one month 8; none 0 — proxy for stored payment methods and addresses |
| Cleanup readiness | 0-15 | verified `self_service` guide 15; `contact_form`/`email_request` 8; `public_service` 5; `unavailable` 0 |

Bands: `recommended` >= 60, `review` 30-59, `keep_or_watch` <= 29.

Fixed overrides, applied after the score:

- **In-use guard:** recency within 3 months, or a recurring charge seen in the last 2 months, never yields `recommended`; the item gets a "최근 사용 흔적 있음" badge instead. Because email recency alone cannot see a mail-silent service the user uses daily (§3), the guard is a floor, not the whole defense: no item reaches the deletion guide without an explicit user decision, and the review UI asks the user to confirm disuse rather than asserting it.
- `likely_closed` candidates are excluded entirely.
- Every displayed score names its top two contributing axes in plain Korean (e.g. "30개월 방치 + 결제 정보 저장 가능성").

Worked examples: a 40-month-dormant shopping mall with a verified self-service route scores 40+20+15+15 = 90 `recommended`. A dormant community account with only an email-request route scores 40+8+0+8 = 56 `review`. Actively used cloud storage scores 0+30+0+15 = 45 `review` with the in-use badge — sensitive, but deletion is not the right action for it.

Design fences: breach association returns later as a separate badge/filter, never as points inside this score, so the score's meaning stays stable when data sources change. Account-control questions (password reuse, MFA status) stay out until a UI exists to ask them.

### Boundary

The product prepares, routes, and explains. The user performs login, identity verification, final confirmation, and request submission on the service's official surface. Nothing auto-transitions to done.

### Pre-deletion checklist (shown per service)

- Active subscription, recurring charge, booking, or refund in progress.
- Points, coupons, stored value, or credit balance.
- Data export needs (orders, posts, photos, files).
- Ownership transfer (team, channel, family, store).
- SSO and recovery-email dependencies.

### Deletion routes

| Route | Product provides | User does |
|---|---|---|
| `self_service` | Official URL, platform steps, grace period | Logs in, verifies identity, confirms |
| `contact_form` | Official form link, preparation list | Enters and submits on the official site |
| `email_request` | Korean draft and subject | Reviews and sends from their own mail client |
| `public_service` | 정보주체 권리행사 link and eligibility [S8][S9] | Authenticates and files there |
| `unavailable` | Evidence and safe alternatives | Chooses minimization, deactivation, or support escalation |

### Status tracking

`to_clean -> requested -> done`, plus `not_needed` to drop an item. Only the user may mark `done`. Store completion date and method only; no screenshots or evidence files.

### Korean request template

```text
제목: [회원탈퇴 및 개인정보 삭제 요청] {서비스명} / {마스킹된 계정}

안녕하세요. 본 메일 주소와 연결된 계정의 회원탈퇴 및 개인정보 삭제를 요청합니다.
법령상 보존이 필요한 정보가 있다면 보존 항목·근거·기간과 나머지 정보의 삭제 예정일을 알려주세요.
본인확인이 필요하면 비밀번호나 신분증을 일반 이메일로 요구하지 말고 공식 보안 절차를 안내해 주세요.
처리 결과는 이 메일로 회신 부탁드립니다.
```

Basis: Korean PIPA Articles 36-37 rights language; the template never auto-inserts data beyond service name and masked account [S15][S16].

### Required distinction warnings

- Disconnecting a social login (Google/Kakao/Naver 연결 해제) stops that sign-in path; it does not delete the service account or its data — Kakao's own docs warn 연결 끊기 is not 회원탈퇴 [S7].
- Uninstalling an app does not delete the service account.
- Unsubscribing from marketing does not close the account.
- Deactivation is not necessarily deletion.
- Account closure can leave legally retained records [S17].

### Guide catalog

Per-service fields: `service_id`, display name, canonical domain, sender-domain aliases, category, `deletion_route`, per-platform steps and URL, grace period, prerequisites, identity-verification method, `official_source_url`, `last_verified_at`, `review_due_at`, `broken_report_count`.

Operations: seed from JustDeleteMe (MIT) but verify Korean services against official help pages [S10]; start with the 50 most frequent pilot services; verify the top 20 monthly, the rest every 90 days; reverify after three broken-link reports; mark stale routes `needs_review` instead of silently redirecting.

## 5. Architecture

Vercel fits only if the Gmail boundary stays in the browser: scan, parsing, and scoring in a Client Component plus Web Worker; Vercel Node.js Functions handle only authenticated CRUD for user-approved candidates and cleanup status; managed PostgreSQL for storage [S18]. Removing reminders eliminates Cron, the transactional-email provider, and the outbox from the MVP entirely.

**The database holds per-user data only.** The guide catalog is read-only, identical for every user, and changes at content-ops speed, so it ships as a **static JSON asset** built into the deployment and served from the CDN — no table, no query, no connection. Fifty services is a small file; JustDeleteMe runs the same shape (`sites.json` in a repo) at ten times the size [S10]. Catalog edits go through git and redeploy, which also gives change history and review for free — properties the `last_verified_at` discipline (§4) needs anyway. Broken-link reports are the only catalog write, and they are a report queue, not a catalog mutation.

**Browser-only storage was evaluated and rejected** — see §8. IndexedDB is not a source of truth here.

| Concern | Rule | Verification |
|---|---|---|
| OAuth URL | One stable QA domain plus the Production domain; never register arbitrary Preview URLs | Origin and redirect URI match Google registration |
| Auth separation | Product sign-in never grants Gmail access; request `gmail.readonly` incrementally at scan start; backend issues only an HttpOnly product session | Product session and cookies contain no Gmail token |
| Processing boundary | Gmail access stays in Client Component/Worker; database stays in Node.js Functions | Zero Gmail token/header fields in Function traffic and logs |
| Database | Serverless driver or pooler; lazy initialization | Connection-count load test stays below provider limit [S22] |
| Environments | Separate Development/Preview/Production databases and OAuth clients; secrets never use `NEXT_PUBLIC_` | Cross-environment credentials fail closed; client bundle contains no secret [S20][S21][S23] |
| Authorization | Every Server Action and Route Handler rechecks user ownership | Cross-user candidate IDs return 403/404 |
| Logs | No tokens or sensitive candidate data in URL query strings; structured redaction | Token, email, subject, and sender scan returns zero matches |

Do not introduce an LLM into discovery. Start with deterministic signals, the entity catalog, and user confirmation.

## 6. Privacy Invariants

| Data | Retention | Invariant |
|---|---|---|
| Gmail access token | Browser memory, current session | Clear on disconnect/tab close; never log or persist |
| Message subject/sender/date | Scan memory, max 30 minutes | Never transmit to backend |
| Normalized candidates and decisions | While product account exists | Per-item delete and full export |
| Cleanup status | While product account exists | Dates and method only |
| Product-account deletion | Primary DB within 24 hours | Verify the DB provider expires backups within 30 days before launch |
| Security logs | 30 days | No email, subject, token, or message identifier |

Controls: just-in-time disclosure before OAuth; least privilege and incremental authorization; TLS and encryption at rest; CSP with `connect-src` restricted to the app, Google OAuth, and the Gmail API; no third-party analytics on scan and cleanup screens; automated secret/PII redaction in logs and errors.

## 7. Validation Gates

- Gmail connect completion >= 60%; below 40%, stop scaling and test trust copy or manual import.
- Time to first 10 high-confidence candidates <= 5 minutes. This measures progressive rendering, not scan completion — a full scan is quota-bound near 4 minutes on its own (§3).
- High-confidence precision >= 85% in pilot (false positives <= 10% at release); below 80%, stop adding features and repair evidence rules.
- At least 25% of result viewers start one cleanup action.
- Any raw-mail or credential leak is a release blocker.
- Gmail restricted-scope verification is complete before public release; it is a gate, not a calendar promise [S3].

## 8. Decision Log

### Decision: Descope to the core loop - 2026-07-15

**Context:** v1 specified cleanup-priority scoring, breach-data integration, reminders, monetization, and a 7-state cleanup machine. The owner directed focus onto the core: find registered sites, guide deletion of unwanted ones.

**Why:** Priority scoring depended on breach data with no MVP source (its `immediate` band was unreachable); reminders required Cron plus an email provider for marginal value; every cut item can be layered back after the core loop proves out. Full detail preserved in PRODUCT_SPEC_v1_full.md.

**Rejected:** Keeping priority scoring with self-reported inputs (adds a questionnaire UI before the core value is proven). Keeping reminders (infrastructure cost without evidence users need them).

**Status:** Active — amended 2026-07-15: a cleanup score returned in MVP-native form (see "Evidence scoring v2" below); reminders, breach integration, and the other cuts stand.

### Decision: No extension; web service only - 2026-07-15

**Context:** The extension was reopened earlier the same day as a possible recency add-on, because marketing mail distorts email-based recency. The owner then closed it: web service only for now ("일단"— a deferral, not a permanent kill). Research had meanwhile shrunk the prize.

**Why the cost was low:** `chrome.history` does return full URLs with paths, so the idea was mechanically sound — but Chrome's history window is ~90 days, and our dormancy targets are 12-36+ months. Dormant accounts are *by definition* absent from a 90-day window, so history could never discover them; presence only proves recent use. The extension was therefore buying a false-positive guard, not new discovery — and paying for it with the install warning *"Read and change your browsing history on all signed-in devices"* (no read-only variant exists; `tabs` warns the same, so there is no softer dodge) [S28][S29][S30]. A harsh permission for a safety rail is a bad trade.

**What it costs us anyway:** the in-use guard loses its strongest input. §3 records the compensations — marketing excluded from recency, `last email evidence` labeling, explicit user confirmation before any item reaches the deletion guide, and the PIPA Article 35 access-request template for items the user truly cannot judge.

**Rejected:** Extension-first (unchanged from v1: install friction, permission barrier). Any browsing-history upload. Reviving it before pilot evidence shows users actually stumble on "is this account really unused?".

**Status:** Active (revisit only on pilot evidence)

### Decision: Evidence scoring v2 - per-family caps and an MVP-native cleanup score - 2026-07-15

**Context:** The owner asked for properly designed ownership-confirmation and cleanup-score logic. The v1 additive evidence table let repetition inflate confidence and let two strong signals (signup 35 + auth 30 = 65) miss the `high` band; the v1 cleanup formula was cut because its two heaviest axes had no MVP data source.

**Why:** Per-family caps with distinct-month counting make confidence robust to mail volume; the authenticity gate (DKIM/SPF) and closure-mail negative evidence remove the two cheapest false-positive sources. The new cleanup score uses only MVP-native data (recency, catalog category, transaction evidence, route readiness), so every point is explainable and no axis is dead. The in-use guard prevents the score from ever recommending deletion of an active account.

**Rejected:** Restoring the v1 formula as-was (dead axes). Folding breach data into the score later (badge instead — score semantics stay stable). ML/LLM scoring (unexplainable, unnecessary at this scale).

**Status:** Active

### Decision: Refuse password-vault import despite it being technically available - 2026-07-15

**Context:** v1 excluded saved-login access on the belief that it was impossible (true for APIs: `passwordsPrivate` is Chrome-internal). Research found a working path anyway — user-initiated CSV export exists in Apple Passwords (macOS `File > Export All Passwords to File`; iOS via `Settings > Apps > Safari > Export`), Bitwarden (documented header row `folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp`), and 1Password 8. A saved credential for a site is near-certain account evidence and would cover exactly what email misses. So the exclusion needed a real reason or it would be re-litigated by the first engineer who found the same path.

**Why refuse:** Every vendor ships a plaintext warning with the feature — Apple: "Passwords you export are not encrypted and are visible to anyone who has access to the file"; Bitwarden: "delete the file immediately after use"; 1Password: "Do not email exported data files or store them online." A product flow that instructs users to export their vault and hand it to a website normalizes precisely the act every password manager warns against, and hands attackers a ready-made phishing template — a cloned UI harvests whole vaults, harming people who never used this product. Client-side-only parsing does not fix this: the externality is the habit, not our handling. Coverage is uneven regardless (1Password SSO accounts cannot export at all; Samsung Pass has no interoperable format), and the extension's local visit-history matching (§3) reaches the same signal class — sites the user actually logs into — without any credential ever existing on disk.

**Rejected:** CSV import with client-side parsing and immediate password-column discard (does not address the phishing-template externality). Asking users to strip the password column first (friction, and still teaches the export habit).

**Allowed instead:** guiding a user to *view* their password manager's site list and add services by hand — no file, no credential, no template. Low value, near-zero cost; Should-tier at most.

**Status:** Active

### Decision: Keep the database for user data; move the catalog out of it - 2026-07-15

**Context:** With reminders cut, the server has little left to do, so the owner asked whether a database is needed at all — could candidates and cleanup status live in the browser (IndexedDB) with the catalog as a static file? The prize was real: no DB means no accounts, no auth, no cross-user authorization surface, no user-data-deletion policy, and the strongest possible trust claim — "we store nothing about you."

**Why the database stays.** Two independent findings, either one sufficient [S36][S37]:

- **Safari deletes first-party IndexedDB on a rolling no-interaction timer.** Not a third-party-tracking rule — it applies to sites the user actively visits. The window is 7 days of *Safari use* without a user gesture (WebKit trunk now reads 30 for most sites, but that change is undocumented, contradicted by Apple's own published docs, and revocable without notice — **plan against 7**). It drops back to 7 for users who arrived via a link-decorated URL from a prevalent domain, which is an ordinary marketing/email acquisition path. `navigator.storage.persist()` is the sanctioned escape hatch and is **unobtainable in a Safari tab by construction**: WebKit grants persistence only to app-bound, MDM-managed, or Home-Screen-installed domains, so an ordinary site gets `false` no matter how engaged the user is. The relevant WebKit bug has been open since 2020. Our flow — leave for days, come back to mark items done — sits inside the trigger window.
- **No browser storage survives a device switch or "Clear browsing data."** Neither Chrome nor Firefox syncs site data, so phone-to-laptop is a guaranteed total loss, and one routine hygiene action wipes everything.

**The decisive asymmetry:** a re-scan rebuilds the candidate list but **cannot rebuild cleanup status** — which deletion requests the user already filed is human-generated and irreplaceable. Silent loss there is worse than visible loss, because the list comes back looking complete while the work is gone. That converts storage eviction from a cache miss into product failure.

**What the question did win:** the catalog leaves the database (§5). That removes the largest table, all catalog queries, and the read path most likely to need caching — a real simplification, just not the one on offer.

**Rejected:** browser-only with `persist()` (does nothing on Safari — never branch UX on it). Browser-only with an install-to-Home-Screen prompt (the only Safari fix, but it is user compliance, not an engineering control). Browser-only with export prompts and re-scan recovery (users skip exports; re-scan cannot restore status).

**Status:** Active

### Decision: No marketing-template library; classify by category, headers, and sender - 2026-07-15

**Context:** Proposal on the table — marketing mail is templated, so store each service's templates and match incoming mail against them to filter marketing out.

**Why not:** Four independent blockers. (1) **It needs the body.** The MVP fetches `format=metadata` with named headers and never retrieves bodies; template matching requires content, which reverses the boundary the whole privacy claim rests on. (2) **The library rots faster than anything else we own.** The deletion-guide catalog is already our biggest fixed cost at ~50 services on a monthly/quarterly cycle; a template library is 50 services × N campaigns × redesigns and A/B tests, changing weekly. (3) **It rebuilds Google's classifier, worse.** `category:promotions` is Google's own marketing judgment over a corpus we will never match, free and language-independent, with zero curation. (4) **It optimizes the wrong direction.** Per §3, over-firing on marketing is the *dangerous* error; a system built to catch more marketing pushes us toward recommending deletion of active accounts.

**The salvageable kernel:** not templates but **sender class in the catalog** — mark each `sender_domain_aliases` entry as marketing or transactional (e.g. a `mailer.` subdomain that only ever sends campaigns). Metadata-only, ~50 services, and sending infrastructure changes far more slowly than creative. Do not build it upfront: per the existing rule, start with deterministic signals plus user confirmation and reconsider only when a documented error corpus shows Gmail categories and headers hitting a ceiling.

**Status:** Active

### Decision: No Naver/Daum mailbox support in the MVP; validate the mailbox mix first - 2026-07-15

**Context:** A Korea-first product reading only Gmail is a real coverage question — Korean services' signup mail plausibly lands in Naver Mail. Research settled the mechanics: **neither Naver nor Kakao/Daum exposes any OAuth mail-reading API** (the string "메일" appears zero times in Naver's OpenAPI catalog; Naver Login returns the address as a profile field and grants no mailbox access). The only path is IMAP [S34][S35].

**Why defer:** IMAP assumes a TCP stream (RFC 9051) and browsers expose no raw socket, so Naver/Daum support **requires a backend that custodies the user's app password** — a reusable credential granting full mailbox access including send, at rest on our server. That reverses the core decision of this spec and destroys the one differentiator no competitor can match (§8 benchmark: every rival processes server-side). The friction also collides with the connect-completion gate: the user must enable 2FA, generate an app password, and toggle IMAP on (off by default) — against one OAuth click for Gmail. Naver additionally auto-disables IMAP after 90 days of connection states it deems abnormal, so the integration can break with no user action.

**Instead:** treat the mailbox mix as an empirical question for the weeks 1-2 interviews — where does each user's Korean-service signup mail actually live? If Naver Mail proves decisive, the answer is a deliberate architecture decision with its own trust story, not an MVP add-on. Note the tension honestly meanwhile: Gmail-only skews discovery toward foreign services, which is precisely where the Korean public rail is blind (§2) — complementary, but weak on the Korean long tail our catalog targets.

**Rejected:** Shipping IMAP behind "we only read headers" (the credential we would hold grants everything, regardless of what we read). Waiting for a Naver mail API (none exists; none is announced).

**Status:** Active

### Prior decisions (2026-07-15, all Active; full text in v1 archive)

- **Web-first; defer browser history** - visit history is not account evidence; extension permissions are a trust barrier. *Reaffirmed above after a same-day reopen and re-close.*
- **Human-in-the-loop deletion** - the user performs final actions on official surfaces; one-click deletion rejected.
- **Client-side Gmail processing; no raw-mail backend** - keeps restricted data out of the server and reduces verification burden.
- **Vercel as the operating baseline** - App Router UI plus short authenticated CRUD; server-side Gmail scanning rejected.

## 9. Sources

- **S1:** [Google Workspace - Gmail API OAuth scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- **S2:** [Google Workspace - users.messages.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)
- **S3:** [Google Identity - Restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
- **S4:** [Google Identity - OAuth 2.0 policies](https://developers.google.com/identity/protocols/oauth2/policies)
- **S7:** [Google Account Help - Manage third-party connections](https://support.google.com/accounts/answer/13533235)
- **S8:** [정보주체 권리행사 (formerly e프라이버시 클린서비스) - lookback windows and KISA relay model](https://www.privacy.go.kr/front/contents/cntntsView.do?contsNo=192)
- **S9:** [Korean Privacy Portal - Breach and account-withdrawal services](https://www.privacy.go.kr/front/contents/cntntsView.do?contsNo=246)
- **S10:** [JustDeleteMe repository](https://github.com/jdm-contrib/jdm)
- **S15:** [Korean Personal Information Protection Act, Article 36](https://www.law.go.kr/%EB%B2%95%EB%A0%B9/%EA%B0%9C%EC%9D%B8%EC%A0%95%EB%B3%B4%EB%B3%B4%ED%98%B8%EB%B2%95/%EC%A0%9C36%EC%A1%B0)
- **S16:** [Korean Personal Information Protection Act, Article 37](https://www.law.go.kr/%EB%B2%95%EB%A0%B9/%EA%B0%9C%EC%9D%B8%EC%A0%95%EB%B3%B4%EB%B3%B4%ED%98%B8%EB%B2%95/%EC%A0%9C37%EC%A1%B0)
- **S17:** [Google Account Help - Delete your Google Account](https://support.google.com/accounts/answer/32046)
- **S18:** [Vercel Functions](https://vercel.com/docs/functions)
- **S20:** [Vercel - Environment Variables](https://vercel.com/docs/environment-variables)
- **S21:** [Vercel - Deployment Environments](https://vercel.com/docs/deployments/environments)
- **S22:** [Vercel - Connection Pooling with Functions](https://vercel.com/kb/guide/connection-pooling-with-functions)
- **S23:** [Next.js - Environment Variables](https://nextjs.org/docs/app/guides/environment-variables)
- **S24:** [Gmail API - Usage limits and per-method quota units](https://developers.google.com/workspace/gmail/api/reference/quota)
- **S25:** [Gmail search operators (supported `has:`, `category:`, `list:` values)](https://support.google.com/mail/answer/7190)
- **S26:** [Google - Email sender guidelines (one-click unsubscribe requirement)](https://support.google.com/a/answer/81126) and [sender-guidelines FAQ](https://support.google.com/a/answer/14229414)
- **S27:** [RFC 8601 - Message Header Field for Indicating Message Authentication Status](https://www.rfc-editor.org/rfc/rfc8601.txt)
- **S28:** [chrome.history API reference](https://developer.chrome.com/docs/extensions/reference/api/history)
- **S29:** [Chrome Help - Browsing history retention](https://support.google.com/chrome/answer/95589)
- **S30:** [Chrome extension permission warnings list](https://developer.chrome.com/docs/extensions/reference/permissions-list)
- **S31:** [Have I Been Pwned API v3](https://haveibeenpwned.com/API/v3) and [subscription tiers](https://haveibeenpwned.com/Subscription)
- **S32:** [Kakao Login REST API reference](https://developers.kakao.com/docs/en/kakaologin/rest-api)
- **S33:** [Naver Login developer guide (revocation only)](https://developers.naver.com/docs/login/devguide/devguide.md)
- **S34:** [Naver OpenAPI catalog (no mail API)](https://developers.naver.com/docs/common/openapiguide/apilist.md)
- **S35:** [RFC 9051 - IMAP4rev2 (assumes a TCP stream)](https://www.rfc-editor.org/rfc/rfc9051.html)
- **S36:** [WebKit - Full Third-Party Cookie Blocking and More (script-writable storage deletion)](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/) and [Updates to Storage Policy](https://webkit.org/blog/14403/updates-to-storage-policy/); persistence gap tracked in [WebKit bug 209563](https://bugs.webkit.org/show_bug.cgi?id=209563)
- **S37:** [MDN - Storage quotas and eviction criteria](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)

*Source IDs keep v1 numbering; S5, S6, S11-S14, S19 were dropped with their features.*
