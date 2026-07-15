# Findings

Problems found while doing other work, verified, and deliberately not fixed there. Each entry
says why it could not be solved at the time and what it costs to leave. Delete an entry when it
is fixed, not when it is noticed.

## The scan pays for gmail.readonly and does not use it (2026-07-15, designed not built)

`scan.js` calls `messages.list` with no `q`. It enumerates the whole mailbox, fetches every
message at 20 units, and then classifies by substring-matching hand-written Korean phrases.
PRODUCT_SPEC §3 prescribes the opposite: catalog probes at `q="from:{domain}"` for 5 units and no
fetch, then family-scoped queries, then priority-ordered fetches with a 1,200 cap. Spec line 79 is
explicit that `q=` is why we chose `gmail.readonly` at all, a restricted scope carrying OAuth
verification and a possible annual security assessment. We are paying that price for a feature we
do not call.

Measured on an 811-message scan: 16,230 units, 2.7 minutes, of which 3,780 went to the 189
messages that classified as `unknown` and scored zero. A 3,000-message mailbox costs 60,000 units
and ten minutes; the spec's 1,200-fetch cap that would bound this is not implemented.

**Three options, estimated:**
- **A, categories only.** `q=category:purchases` / `q=category:reservations` for +10 units, giving
  transaction recall that system labels cannot (see the CATEGORY_PURCHASES entry below). One SOW
  item, half a day. Does not touch the Korean brittleness.
- **B, queries for recall and the existing classifier for precision** (recommended). Run family
  queries first, hand `classifyMessage` a per-family `Set<messageId>` as a hint, keep listing and
  fetching everything. +30-50 units, no change to fetch volume, so the sender list, the real
  message counts and the excluded bucket all survive and the UI keeps its meaning. Purely additive:
  turn the queries off and it is today's code. Three or four SOW items, one to two days.
- **C, the spec's architecture.** Catalog probes, priority-ordered family fetches, the 1,200 cap,
  partial-scan labelling. ~5,300 units instead of 16,230. But it drops services whose only mail is
  unclassified (9 services, 11 messages in the measured scan) and changes what 건수 means: Google
  becomes "5 pieces of evidence" rather than 79 messages. More honest, different product. Six to
  eight SOW items, three to five days.

**Why B:** the measured failure is classification quality, not speed. Nobody complained about 2.7
minutes. C cuts a cost we are not paying and bundles a product decision (drop the long tail) into
what looks like an optimisation.

**Blocked on a 30-minute measurement, not on effort.** Every option assumes Gmail's Korean `q=`
search beats the phrase table, and that is unverified. The same assumption already failed once
today: the headers were genuinely unused, but "unused headers cause the 23% unknown rate" was a
guess, and fixing them moved 23.7% -> 23.3%. Before building any of this, spend one token on
`q=subject:비밀번호`, `q=from:google.com subject:보안`, `q=category:purchases`, and a quoted Korean
phrase, and compare the hit counts against what the current rules find. If Gmail does not clearly
win, none of the above is worth doing.

## Catalog entries verified but unshippable (2026-07-15)

Two services were researched, their deletion paths confirmed against official documentation, and
then excluded because their `sender_domain_aliases` cannot match real mail. The full verified
content is preserved in the exclusion records so neither has to be researched again.

**네이버페이.** Independent deletion path confirmed (`Npay > 페이 설정 > 회원 정보 > 서비스 해지`;
30 days before re-registration; blocked by in-flight orders, an active 정기결제, held Npay 머니, or
a negative point balance). Excluded because its web and help hosts (`pay.naver.com`,
`help.pay.naver.com`) reduce to the registrable domain `naver.com`, which the existing `naver`
entry already claims. Operator is 네이버파이낸셜, a different legal entity from 네이버, but no
evidence of a separate sending domain was found.

**카카오페이.** Deletion path confirmed (all Pay-linked services must be cancelled first; blocked
by 카카오T 미수금, an open 택시예약, or a 티켓 예매 in flight; 페이머니체크카드 survives deletion).
Excluded on DNS evidence: `kakaopay.com` publishes no SPF, no DMARC and no MX, and none of
`mail.` / `email.` / `noti.` / `notification.kakaopay.com` publishes SPF either (checked
2026-07-15). It is not a domain anyone sends account mail from. `kakao.com` by contrast has both
SPF and DMARC, so Pay mail most likely arrives from there, and `kakao.com` both collides with the
existing `kakao` entry and is a free mailbox, which `catalog.js` blocks from matching anyway.

**Blast radius:** users of either service get the generic "공식 탈퇴 경로 미확인" guide instead of a
verified one. Both are large Korean services, so this is a real coverage hole, not a rounding
error. **To fix:** obtain one real message from each and read its `From:` domain. If it does not
collide, the entries drop straight back in.

## naver and kakao catalog entries are structurally unreachable (2026-07-15)

`naver.com` and `kakao.com` are both in `FREE_MAILBOX_DOMAINS`, so `linkFields` sets
`linkBlockedBy: "free_mailbox"` and `catalog.js` returns early with `catalogEntry: null` before
any alias is consulted. The two Korean entries in a Korea-first catalog can never match.

The blocking rule is correct and must not be removed: a shop mailing from `shopname@naver.com` is
not 네이버, and sending that user to 네이버's withdrawal page would be worse than showing nothing.
The defect is that the catalog schema has no way to express an address-level alias.

**To fix:** add `sender_address_aliases` (e.g. `["no-reply@naver.com"]`) matched only when
`linkBlockedBy === "free_mailbox"`. Requires exposing the sender address on the candidate;
`svc.emails` exists in the aggregator but `toCandidate` does not carry it.

## Legally mandated member-only mail is undervalued (2026-07-15)

휴면계정 전환 / 개인정보 이용내역 / 개인정보 분리보관 / 이용약관 개정 notices are sent only to
registered members, by Korean law. They are close to proof of an account, and stronger evidence
than a receipt. They now classify as `notification`, which is the correct family under the §3
definition ("repeated non-marketing service notifications") but caps them at 15 points, inside the
`low` band.

Not fixed with the classifier because the fix is a §3 scoring change: either a new family or a
carve-out. The phrases are tagged in `filter.rules.js` so the change has somewhere to land.

**Blast radius:** a dormant Korean account whose only surviving evidence is its 휴면 notice scores
15 and sorts to the bottom, when it is exactly the account this product exists to surface.

## CATEGORY_PURCHASES is probably dead code (2026-07-15)

`filter.js` `classifyByCategory` reads `CATEGORY_PURCHASES` from `labelIds`. Gmail's system labels
are `CATEGORY_PERSONAL`, `CATEGORY_SOCIAL`, `CATEGORY_PROMOTIONS`, `CATEGORY_UPDATES` and
`CATEGORY_FORUMS`; purchases and reservations exist only as the `q=category:purchases` search
operator. The branch is very likely never taken. PRODUCT_SPEC §3 [S2] flagged this exact question
as unverified and it is still unverified.

Kept because it costs nothing and is correct if Gmail ever promotes it. **To settle:** dump
`labelIds` from one real scan; one minute of work against a live mailbox, which is why it has not
been done from a dev machine.

## 야놀자 and 인터파크 are one NOL account (2026-07-15)

야놀자's own FAQ states that NOL 회원 탈퇴 makes NOL, NOL 인터파크투어, NOL 티켓 and 트리플 all
unusable. Both `interpark.com` and `yanolja.com` redirect into `nol.*` hosts operated by 놀유니버스.
They are kept as separate entries because their sending domains differ and neither collides, but
a user deleting what they believe is 인터파크 may lose 야놀자.

The 인터파크 entry now carries a prerequisite naming the relationship and telling the user to check
the withdrawal screen. It stops short of asserting the reverse direction (인터파크 탈퇴 -> 야놀자
gone), which is not evidenced; only the NOL -> 인터파크투어 direction is documented.

## Verifying a sender alias without a mailbox (2026-07-15, method)

`sender_domain_aliases` is the load-bearing field: the catalog matches on the registrable domain of
the sender, so a wrong alias silently costs a service its verified guide. Only one alias in the
catalog is confirmed from a primary source (`facebookmail.com`, which Meta publishes itself).

DNS narrows the rest cheaply and without a real scan. A domain a company sends account mail from
publishes SPF, usually DMARC, and often MX. Of the 24 aliases checked on 2026-07-15, 23 published
at least one; `kakaopay.com` published none, which is how the entry above was caught before it
shipped. The check also upgraded a judgement call to evidence: `goodchoice.kr` and `yeogi.com` both
publish SPF and share the IP `13.124.176.35`, so they are one mail estate and both belong on
여기어때.

This is narrowing, not proof: SPF authorises the envelope sender, not the header `From:`. The
settling move is still a real scan, where a known brand left at `linkSafety: "inferred"` is an
alias miss. `scratchpad/catalog/spfcheck.mjs` in the 2026-07-15 session ran this; it is 20 lines
of `nslookup` and worth rewriting rather than recovering.
