-- SOW 002 §3 — completion timestamps on the existing label row (not a second table).
-- 탈퇴 완료 and 구독해지 완료 are independent; neither implies the other.
-- Apply via Supabase CLI/SQL editor; the app does not auto-migrate.

alter table user_service_choice
  add column if not exists withdrawn_at    timestamptz,
  add column if not exists unsubscribed_at timestamptz;
