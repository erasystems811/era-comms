-- ============================================================
-- Migration 002: Re-seed default plans + admin RLS bypass
-- ============================================================

-- Re-seed the default plans (safe if they already exist)
INSERT INTO plans (
  name, display_name, billing_model,
  ai_enabled, voice_enabled, premium_voice_enabled,
  max_sessions, monthly_message_cap, daily_message_cap, hourly_message_cap
) VALUES
  ('internal',     'ERA Systems Internal', 'none',        TRUE, TRUE,  TRUE,  10,   NULL,  NULL, NULL),
  ('starter',      'Starter',              'usage_based', TRUE, FALSE, FALSE, 1,    1000,  100,  20),
  ('professional', 'Professional',         'plan_based',  TRUE, TRUE,  FALSE, 3,    10000, 500,  100),
  ('enterprise',   'Enterprise',           'plan_based',  TRUE, TRUE,  TRUE,  NULL, NULL,  NULL, NULL)
ON CONFLICT (name) DO NOTHING;

-- Ensure the postgres superuser bypasses RLS on all tables.
-- Supabase's PgBouncer session pooler may not forward custom GUC startup
-- parameters (app.current_client_id), so is_admin_context() can return false
-- even for the admin pool. BYPASSRLS on the postgres role solves this cleanly.
DO $$ BEGIN
  EXECUTE 'ALTER ROLE postgres BYPASSRLS';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Cannot ALTER ROLE postgres BYPASSRLS — skipping (managed DB restriction)';
END $$;
