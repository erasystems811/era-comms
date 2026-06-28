-- ============================================================
-- MIGRATION 006: ERA CONNECT — HOSPITAL ID UNIQUE INDEX
-- Allows auto-registration of instances by era_username.
-- Partial index (NULLs excluded) so manually-registered instances
-- without a hospital_id don't conflict with each other.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_connect_instances_hospital_id
  ON connect_instances (hospital_id) WHERE hospital_id IS NOT NULL;
