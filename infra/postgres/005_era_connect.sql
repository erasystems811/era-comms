-- ============================================================
-- MIGRATION 005: ERA CONNECT
-- Tables for ERA Connect telemetry, instance registry, and
-- remote configuration. Era Connect is the Python desktop agent
-- that runs at hospital sites and syncs EMR data to ERA Patient.
-- ============================================================

-- ── INSTANCES ─────────────────────────────────────────────────
-- One row per hospital installation of ERAConnect.exe.
-- api_key is generated here and embedded in the hospital's config;
-- every telemetry request from that machine carries it.

CREATE TABLE IF NOT EXISTS connect_instances (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_name      TEXT        NOT NULL,
  hospital_id        TEXT,                          -- ERA Patient API hospital ID
  api_key            TEXT        NOT NULL UNIQUE,   -- secret sent by the desktop agent
  status             TEXT        NOT NULL DEFAULT 'offline'
                                 CHECK (status IN ('online', 'offline', 'error')),
  mode               TEXT        NOT NULL DEFAULT 'database'
                                 CHECK (mode IN ('database', 'browser')),
  emr_engine         TEXT,                          -- mysql | mssql | postgres | etc.
  version            TEXT,                          -- ERAConnect.exe version string
  patients_synced    INT         NOT NULL DEFAULT 0,
  care_plans_synced  INT         NOT NULL DEFAULT 0,
  errors_total       INT         NOT NULL DEFAULT 0,
  last_heartbeat_at  TIMESTAMPTZ,
  last_error_at      TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_connect_instances_status
  ON connect_instances (status);

CREATE INDEX IF NOT EXISTS idx_connect_instances_heartbeat
  ON connect_instances (last_heartbeat_at DESC NULLS LAST);

-- ── EVENTS ────────────────────────────────────────────────────
-- Append-only telemetry stream. Every meaningful action the
-- desktop agent takes is written here for full audit visibility.

CREATE TABLE IF NOT EXISTS connect_events (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id  UUID        NOT NULL REFERENCES connect_instances(id) ON DELETE CASCADE,
  event_type   TEXT        NOT NULL CHECK (event_type IN (
                 'heartbeat',
                 'startup', 'shutdown',
                 'patient_synced', 'care_plan_synced',
                 'sync_error', 'auth_ok', 'auth_failed',
                 'db_connected', 'db_error',
                 'config_fetched', 'config_updated'
               )),
  status       TEXT        NOT NULL DEFAULT 'ok'
                           CHECK (status IN ('ok', 'error', 'warning')),
  message      TEXT        NOT NULL DEFAULT '',
  patient_mrn  TEXT,                -- set for patient_synced / sync_error events
  metadata     JSONB       NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_connect_events_instance_time
  ON connect_events (instance_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_connect_events_time
  ON connect_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_connect_events_type
  ON connect_events (event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_connect_events_status
  ON connect_events (status, created_at DESC) WHERE status != 'ok';

-- ── REMOTE CONFIGS ────────────────────────────────────────────
-- Settings the operator can change from era-hub without touching
-- the hospital machine. The desktop agent polls GET /v1/connect/config
-- and applies these values at runtime.

CREATE TABLE IF NOT EXISTS connect_configs (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id            UUID        NOT NULL UNIQUE
                                     REFERENCES connect_instances(id) ON DELETE CASCADE,
  sync_interval_seconds  INT         NOT NULL DEFAULT 30
                                     CHECK (sync_interval_seconds >= 10),
  paused                 BOOLEAN     NOT NULL DEFAULT false,
  notify_email           TEXT,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
