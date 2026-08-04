-- =====================================================================
-- 018 — Temporary account lockout
-- =====================================================================
-- Automatic failed-attempt lockouts become time-boxed instead of permanent:
-- after too many bad passwords the account is locked until `locked_until`,
-- then unlocks itself. This removes the anonymous "lock any account forever"
-- DoS while still slowing online password guessing (alongside the per-IP
-- login rate limit). `is_locked` is unchanged — it remains the admin/manual
-- permanent lock.
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
