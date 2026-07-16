-- SOW 001 — pilot cleanup labels. Drop this table + the three /api/choices*
-- routes (+ /api/me/data) to remove the instrumentation completely.

create table if not exists user_service_choice (
  user_id         text        not null,   -- Google `sub`. NEVER the email address.
  domain          text        not null,   -- registrable domain, e.g. "coupang.com"
  choice          text        not null check (choice in ('in_use','unused')),

  -- Score as shown when they answered. Do not drop these to "save space".
  cleanup_score   int,
  cleanup_band    text,                   -- 'recommended' | 'review' | 'keep_or_watch' | null
  discovery_score int,
  discovery_band  text,                   -- 'high' | 'review' | 'low'

  labeled_at      timestamptz not null default now(),
  primary key (user_id, domain)
);

-- No anon/authenticated policies: only the service role (server-side) can touch rows.
-- The app still filters every query by session.sub — service role bypasses RLS.
alter table user_service_choice enable row level security;

-- Owner metrics: per-domain false positives for cleanup_band='recommended'.
-- Never query user_service_choice from a request path; use this view offline/dashboard.
create or replace view cleanup_false_positive as
select domain,
       count(*) filter (where choice = 'in_use')  as said_in_use,
       count(*)                                    as recommended_n
from user_service_choice
where cleanup_band = 'recommended'
group by domain;
