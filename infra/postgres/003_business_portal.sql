-- Migration 003: Business Portal Tables

-- Business portal users (one per business, for /biz/ login)
CREATE TABLE IF NOT EXISTS business_users (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    UUID NOT NULL REFERENCES clients(id) UNIQUE,
  email        TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  last_login_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Module configuration per client (which features are enabled)
CREATE TABLE IF NOT EXISTS module_config (
  client_id              UUID PRIMARY KEY REFERENCES clients(id),
  knowledge_base         BOOLEAN NOT NULL DEFAULT TRUE,
  auto_greet             BOOLEAN NOT NULL DEFAULT TRUE,
  business_hours         BOOLEAN NOT NULL DEFAULT TRUE,
  scenarios              BOOLEAN NOT NULL DEFAULT TRUE,
  human_handoff          BOOLEAN NOT NULL DEFAULT TRUE,
  voice_notes            BOOLEAN NOT NULL DEFAULT FALSE,
  conversation_inbox     BOOLEAN NOT NULL DEFAULT TRUE,
  analytics              BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Knowledge base entries per client
CREATE TABLE IF NOT EXISTS knowledge_base_entries (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id  UUID NOT NULL REFERENCES clients(id),
  section    TEXT NOT NULL DEFAULT 'General',
  title      TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kb_client ON knowledge_base_entries (client_id);

-- Business hours config per client (stored as JSONB)
CREATE TABLE IF NOT EXISTS business_hours_config (
  client_id  UUID PRIMARY KEY REFERENCES clients(id),
  hours_json JSONB NOT NULL DEFAULT '{
    "monday":    {"open":true,"from":"09:00","to":"17:00"},
    "tuesday":   {"open":true,"from":"09:00","to":"17:00"},
    "wednesday": {"open":true,"from":"09:00","to":"17:00"},
    "thursday":  {"open":true,"from":"09:00","to":"17:00"},
    "friday":    {"open":true,"from":"09:00","to":"17:00"},
    "saturday":  {"open":false,"from":"10:00","to":"14:00"},
    "sunday":    {"open":false,"from":"10:00","to":"14:00"}
  }'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-greet message per client
CREATE TABLE IF NOT EXISTS auto_greet_config (
  client_id  UUID PRIMARY KEY REFERENCES clients(id),
  message    TEXT NOT NULL DEFAULT 'Hello! Welcome. How can I help you today?',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Business-specific scenarios
CREATE TABLE IF NOT EXISTS business_scenarios (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     UUID NOT NULL REFERENCES clients(id),
  name          TEXT NOT NULL,
  template_key  TEXT NOT NULL DEFAULT 'custom',
  trigger       TEXT NOT NULL DEFAULT '',
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  priority      INTEGER NOT NULL DEFAULT 0,
  config        JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_scenarios_client ON business_scenarios (client_id);

-- Handoff configuration per client
CREATE TABLE IF NOT EXISTS handoff_config (
  client_id              UUID PRIMARY KEY REFERENCES clients(id),
  trigger_on_request     BOOLEAN NOT NULL DEFAULT TRUE,
  trigger_on_confusion   BOOLEAN NOT NULL DEFAULT TRUE,
  trigger_on_complaint   BOOLEAN NOT NULL DEFAULT TRUE,
  custom_keywords        TEXT NOT NULL DEFAULT '',
  urgent_topics          TEXT NOT NULL DEFAULT '',
  alert_whatsapp         TEXT NOT NULL DEFAULT '',
  alert_email            TEXT NOT NULL DEFAULT '',
  wait_message           TEXT NOT NULL DEFAULT 'Please hold on, I''m connecting you with a team member.',
  max_wait_minutes       INTEGER,
  on_no_response         TEXT NOT NULL DEFAULT 'ai_retakes'
                         CHECK (on_no_response IN ('ai_retakes','keep_waiting','follow_up')),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Voice configuration per client
CREATE TABLE IF NOT EXISTS voice_config (
  client_id           UUID PRIMARY KEY REFERENCES clients(id),
  response_mode       TEXT NOT NULL DEFAULT 'text' CHECK (response_mode IN ('voice','text')),
  response_voice      TEXT NOT NULL DEFAULT 'natural' CHECK (response_voice IN ('natural','formal','friendly')),
  show_transcription  BOOLEAN NOT NULL DEFAULT TRUE,
  language_hint       TEXT NOT NULL DEFAULT 'en',
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Notification preferences per business user
CREATE TABLE IF NOT EXISTS notification_prefs (
  business_user_id          UUID PRIMARY KEY REFERENCES business_users(id),
  whatsapp_handoff_alerts   BOOLEAN NOT NULL DEFAULT TRUE,
  email_daily_digest        BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
