-- ============================================================
-- Migration 012: Broadcasts, Automations, AI Reply, Moderation
-- ============================================================

-- ── MODULE CONFIG: add new feature flags ─────────────────────

ALTER TABLE module_config
  ADD COLUMN IF NOT EXISTS ai_reply          BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS broadcasts        BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS automations       BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS email_campaigns   BOOLEAN NOT NULL DEFAULT FALSE;

-- ── AI REPLY PROFILES ────────────────────────────────────────
-- Per-business AI persona and configuration.
-- Replaces the legacy communication_profile_versions approach
-- for the AI auto-reply feature.

CREATE TABLE IF NOT EXISTS ai_reply_profiles (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id            UUID        NOT NULL REFERENCES clients(id) ON DELETE CASCADE UNIQUE,
  persona              TEXT        NOT NULL DEFAULT 'a helpful business assistant',
  tone                 TEXT        NOT NULL DEFAULT 'friendly and professional',
  system_prompt        TEXT        NOT NULL DEFAULT 'You are a helpful business assistant. Be concise and professional. Only answer questions related to this business. If you don''t know something, offer to connect the customer with a human.',
  permitted_topics     TEXT[]      NOT NULL DEFAULT '{}',
  prohibited_topics    TEXT[]      NOT NULL DEFAULT '{}',
  escalation_triggers  TEXT[]      NOT NULL DEFAULT '{"human","agent","speak to someone","call me","complaint","lawsuit","refund"}',
  max_tokens           INTEGER     NOT NULL DEFAULT 500,
  temperature          DECIMAL(3,2) NOT NULL DEFAULT 0.70,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_profiles_client ON ai_reply_profiles(client_id);

-- ── PLANS: add AI message cap ─────────────────────────────────

ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS ai_messages_cap INTEGER DEFAULT NULL; -- NULL = unlimited

UPDATE plans SET ai_messages_cap = 200   WHERE name = 'starter';
UPDATE plans SET ai_messages_cap = 2000  WHERE name = 'professional';
UPDATE plans SET ai_messages_cap = NULL  WHERE name IN ('enterprise', 'internal');

-- ── WHATSAPP BROADCASTS ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS whatsapp_broadcasts (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        UUID        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  session_id       UUID        NOT NULL REFERENCES whatsapp_sessions(id),
  name             TEXT        NOT NULL,
  content          TEXT        NOT NULL,
  content_type     TEXT        NOT NULL DEFAULT 'text',
  status           TEXT        NOT NULL DEFAULT 'draft'
                               CHECK (status IN ('draft','sending','sent','cancelled')),
  scheduled_at     TIMESTAMPTZ,
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  total_recipients INTEGER     NOT NULL DEFAULT 0,
  total_sent       INTEGER     NOT NULL DEFAULT 0,
  total_failed     INTEGER     NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_broadcasts_client  ON whatsapp_broadcasts(client_id);
CREATE INDEX IF NOT EXISTS idx_broadcasts_status  ON whatsapp_broadcasts(status);

CREATE TABLE IF NOT EXISTS broadcast_recipients (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcast_id  UUID        NOT NULL REFERENCES whatsapp_broadcasts(id) ON DELETE CASCADE,
  client_id     UUID        NOT NULL,
  phone_number  TEXT        NOT NULL,
  name          TEXT,
  status        TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','sent','failed')),
  message_id    UUID,
  error         TEXT,
  sent_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_broadcast ON broadcast_recipients(broadcast_id);
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_pending   ON broadcast_recipients(broadcast_id, status) WHERE status = 'pending';

-- ── AUTOMATION FLOWS ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS automation_flows (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        UUID        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  session_id       UUID        NOT NULL REFERENCES whatsapp_sessions(id),
  name             TEXT        NOT NULL,
  description      TEXT,
  trigger_type     TEXT        NOT NULL DEFAULT 'api'
                               CHECK (trigger_type IN ('api', 'manual')),
  trigger_key      TEXT        UNIQUE, -- for api trigger: POST /v1/public/automations/trigger/:key
  status           TEXT        NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active', 'paused', 'archived')),
  total_enrolled   INTEGER     NOT NULL DEFAULT 0,
  total_completed  INTEGER     NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_automation_flows_client ON automation_flows(client_id);

CREATE TABLE IF NOT EXISTS automation_steps (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id       UUID        NOT NULL REFERENCES automation_flows(id) ON DELETE CASCADE,
  step_order    INTEGER     NOT NULL,
  step_type     TEXT        NOT NULL CHECK (step_type IN ('send_message', 'wait')),
  content       TEXT,
  content_type  TEXT        NOT NULL DEFAULT 'text',
  delay_minutes INTEGER     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (flow_id, step_order)
);

CREATE INDEX IF NOT EXISTS idx_automation_steps_flow ON automation_steps(flow_id, step_order);

CREATE TABLE IF NOT EXISTS automation_enrollments (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id       UUID        NOT NULL REFERENCES automation_flows(id) ON DELETE CASCADE,
  client_id     UUID        NOT NULL,
  phone_number  TEXT        NOT NULL,
  name          TEXT,
  current_step  INTEGER     NOT NULL DEFAULT 0,
  status        TEXT        NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'completed', 'cancelled')),
  next_step_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (flow_id, phone_number)
);

CREATE INDEX IF NOT EXISTS idx_enrollments_due    ON automation_enrollments(next_step_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_enrollments_flow   ON automation_enrollments(flow_id);

-- ── CONTENT MODERATION ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS moderation_rules (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword     TEXT        NOT NULL UNIQUE,
  action      TEXT        NOT NULL DEFAULT 'flag' CHECK (action IN ('flag','warn','suspend')),
  severity    TEXT        NOT NULL DEFAULT 'warning' CHECK (severity IN ('info','warning','critical')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed some default rules
INSERT INTO moderation_rules (keyword, action, severity) VALUES
  ('spam',        'flag',    'warning'),
  ('scam',        'warn',    'warning'),
  ('fraud',       'warn',    'critical'),
  ('buy followers','flag',   'warning'),
  ('click here',  'flag',   'info')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS moderation_events (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     UUID        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  session_id    UUID,
  message_id    UUID,
  matched_keyword TEXT      NOT NULL,
  action_taken  TEXT        NOT NULL,
  content       TEXT        NOT NULL,
  resolved      BOOLEAN     NOT NULL DEFAULT FALSE,
  resolved_by   TEXT,
  resolved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mod_events_client   ON moderation_events(client_id);
CREATE INDEX IF NOT EXISTS idx_mod_events_resolved ON moderation_events(resolved) WHERE resolved = FALSE;

-- Track warnings and suspensions per client
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS warning_count   INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS suspended_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suspension_reason TEXT;

-- ── FLUTTERWAVE SUBSCRIPTIONS ─────────────────────────────────

CREATE TABLE IF NOT EXISTS subscriptions (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id             UUID        NOT NULL REFERENCES clients(id) ON DELETE CASCADE UNIQUE,
  plan_id               UUID        NOT NULL REFERENCES plans(id),
  flutterwave_tx_ref    TEXT        UNIQUE,
  flutterwave_sub_id    TEXT,
  status                TEXT        NOT NULL DEFAULT 'trial'
                                    CHECK (status IN ('trial','active','past_due','cancelled','suspended')),
  trial_ends_at         TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '14 days'),
  current_period_start  TIMESTAMPTZ,
  current_period_end    TIMESTAMPTZ,
  cancelled_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_client ON subscriptions(client_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
