-- ============================================================
-- MIGRATION 004: SEED ERA SYSTEMS OPERATOR CLIENT
-- Creates the internal ERA Systems client with a fixed UUID so
-- OPERATOR_INTERNAL_CLIENT_ID can be hardcoded in config with no
-- manual database work required.
-- Safe to run multiple times (ON CONFLICT DO NOTHING).
-- ============================================================

INSERT INTO clients (id, name, type, plan_id, contact_email, status)
SELECT
  'c0ffee00-0000-4000-a000-000000000001',
  'ERA Systems',
  'internal',
  p.id,
  'chideraumeh25@gmail.com',
  'active'
FROM plans p
WHERE p.name = 'internal'
ON CONFLICT (id) DO NOTHING;

INSERT INTO module_config (client_id)
VALUES ('c0ffee00-0000-4000-a000-000000000001')
ON CONFLICT DO NOTHING;
