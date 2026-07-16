# SOW 002 — 미사용 탭: 탈퇴 완료와 메일 정리

**Status:** backlog. Not started. Written down because the owner named it while SOW 001 was landing.

**Read first:** `PRODUCT_SPEC.md` §4 (status tracking, deletion routes), §8 "No Gmail write scope;
route mail cleanup to Gmail's own search". Both halves of this SOW are already decided there — this
is implementation, not design.

## 1. What the tab is missing

The 미사용 tab today lists what the user rejected, links each to its withdrawal route, and has one
checkbox labelled 완료. Two gaps:

- **완료 means the wrong thing.** It is keyed `dfm-unsubscribe-done-v1` and marks *구독해지* done, not
  *탈퇴* done. §4's flow is `to_clean → requested → done` and the product currently cannot say which
  of those a row is in. A user who withdrew from 쿠팡 last week has nowhere to record it and sees the
  same row, with the same link, forever.
- **Nothing closes the loop on the mail.** They left the service; several hundred of its messages
  stay in the mailbox. README §3 ⑤ promises this is answered and §8 decided exactly how — a deep
  link into the user's own Gmail with the sender pre-searched. It was never built into this tab.

## 2. Scope

**A. 탈퇴 완료 status, separate from 구독해지 완료.** Both can be true, neither implies the other, and
a single checkbox cannot carry both — unsubscribing does not close an account (§4's required
distinction warnings say so in the UI already; the data model must not contradict the copy).

**B. Gmail deep link per row.** `https://mail.google.com/mail/u/{email}/#search/from%3A{domain}`,
opened in a new tab. Zero new scope: §8 refused `gmail.modify` because the narrowest scope that can
trash one message also grants send-as-the-user, and this link is the answer that made refusing
affordable. The product prepares and routes; the user deletes on Gmail's own surface, with its own
confirm and its 30-day trash.

**Blocking question, from §8 itself, and it is not rhetorical:** `u/{email}` must be verified to
resolve the right mailbox for multi-account users before this ships. `u/0` is an index, not an
identity, and it opens whichever account signed in first. Sending someone to a *different* account's
search results — pre-filled with a domain they did not ask about — is a worse failure than not
shipping the link. Test with two signed-in Google accounts before writing any of it.

## 3. Storage

Server, keyed on the session `sub`, next to `user_service_choice` (SOW 001). §6's retention row for
cleanup status is already written: **dates and method only** — no screenshots, no evidence files, no
confirmation mail.

Shape to settle at build time, not here: a `withdrawn_at` / `mail_cleared_at` pair on the existing
row is probably enough and avoids a second table. If it grows a third state, revisit §4's
`to_clean → requested → done` and follow that instead of inventing a parallel vocabulary.

**Only the user may set 완료** (§4). Nothing auto-transitions: we cannot see a withdrawal happen, and
guessing it from a closure mail would be the `likely_closed` detector making a claim it is not
allowed to make (that one badges a *candidate*, it does not close a *task*).

## 4. Out of scope

Deleting mail ourselves in any form — §8 settled it and the reasoning is not reopened by convenience.
Auto-marking 탈퇴 완료 from mail evidence. Reminders or scheduled follow-ups (cut from the MVP; §2).
Any change to the 후보 list, which asks one question and must keep asking only that one.

## 5. Acceptance sketch

Fill this in when the SOW starts; it is a sketch, not a contract.

- 탈퇴 완료 and 구독해지 완료 are independently settable and independently persisted → test
- A completed row is visibly done and stays that way across a reload and a device → test
- The Gmail link carries the right account for a multi-account user → **manual, two accounts, before
  the code**
- No new OAuth scope appears anywhere → `grep` the scope string, test
