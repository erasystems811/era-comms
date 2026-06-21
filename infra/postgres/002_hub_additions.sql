-- ============================================================
-- MIGRATION 002: HUB ADDITIONS
-- Adds tables and columns required by the ERA Hub operator panel.
-- Safe to run multiple times (uses IF NOT EXISTS / IF NOT EXISTS).
-- ============================================================

-- Add missing columns to clients table
ALTER TABLE clients ADD COLUMN IF NOT EXISTS slug TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS contact_phone TEXT;

-- Partial unique index on slug (NULLs excluded — multiple clients may have no slug)
CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_slug ON clients (slug) WHERE slug IS NOT NULL;

-- ============================================================
-- PLATFORM EVENTS LOG
-- Structured event stream consumed by the Event Log page.
-- Populated by the ERA Comms backend as things happen.
-- ============================================================

CREATE TABLE IF NOT EXISTS platform_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    UUID REFERENCES clients(id) ON DELETE SET NULL,
  session_id   UUID REFERENCES whatsapp_sessions(id) ON DELETE SET NULL,
  event_type   TEXT NOT NULL,
  severity     TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
  detail       TEXT NOT NULL DEFAULT '',
  metadata     JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_events_created  ON platform_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_events_client   ON platform_events (client_id, created_at DESC) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_platform_events_severity ON platform_events (severity, created_at DESC);

-- ============================================================
-- AUDIT LOG
-- Permanent record of every operator, business, system, and AI action.
-- Append-only — never update or delete rows.
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor        TEXT NOT NULL CHECK (actor IN ('operator', 'business', 'system', 'ai')),
  actor_id     TEXT,
  actor_label  TEXT NOT NULL,
  action       TEXT NOT NULL,
  target       TEXT NOT NULL DEFAULT '',
  target_id    TEXT,
  detail       TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created   ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor_id  ON audit_log (actor_id) WHERE actor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_log_target_id ON audit_log (target_id) WHERE target_id IS NOT NULL;

-- ============================================================
-- ONBOARDING REQUESTS
-- Self-service signup queue — filled by /apply/* public forms.
-- Operator reviews and approves/rejects each request.
-- ============================================================

CREATE TABLE IF NOT EXISTS onboarding_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier            TEXT NOT NULL CHECK (tier IN ('ai_agent', 'developer')),
  business_name   TEXT NOT NULL,
  contact_email   TEXT NOT NULL,
  contact_phone   TEXT,
  description     TEXT,
  plan_id         UUID REFERENCES plans(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  rejected_reason TEXT,
  approved_at     TIMESTAMPTZ,
  rejected_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_onboarding_requests_status  ON onboarding_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_onboarding_requests_created ON onboarding_requests (created_at DESC);

-- ============================================================
-- AI SCENARIO TEMPLATES
-- Managed by the operator; applied to businesses.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_templates (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  category         TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  instruction      TEXT NOT NULL DEFAULT '',
  trigger_keywords TEXT[] NOT NULL DEFAULT '{}',
  fields           JSONB NOT NULL DEFAULT '[]',
  archived         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_templates_category ON ai_templates (category) WHERE NOT archived;

INSERT INTO ai_templates (name, category, description, instruction, trigger_keywords) VALUES
  ('Order Taking',         'order',    'Collect order details from customers',
   'Collect the customer''s order details including items, quantities, and delivery address. Confirm the order back to the customer before completing.',
   ARRAY['order', 'buy', 'purchase', 'i want']),
  ('Appointment Booking',  'booking',  'Schedule appointments automatically',
   'Help the customer book an appointment. Collect their preferred date, time, and name. Confirm the booking and provide a reference number.',
   ARRAY['appointment', 'book', 'schedule', 'when can i']),
  ('Price Enquiry',        'support',  'Answer pricing questions',
   'Answer questions about prices and services. If you don''t have a specific price, acknowledge and offer to find out.',
   ARRAY['price', 'cost', 'how much', 'charge']),
  ('Product Availability', 'support',  'Check what is in stock',
   'Check product availability for the customer. If available, provide details. If not, offer alternatives or notify when available.',
   ARRAY['available', 'in stock', 'do you have']),
  ('Complaint Handling',   'support',  'Handle complaints and escalate appropriately',
   'Acknowledge the customer''s complaint with empathy. Apologise and try to resolve. If unresolvable, escalate to a human.',
   ARRAY['complaint', 'unhappy', 'problem', 'wrong']),
  ('Lead Capture',         'lead_gen', 'Collect contact info from prospects',
   'Collect the prospect''s name, phone number, and what they are interested in. Thank them and let them know the team will follow up.',
   ARRAY['interested', 'want to know more', 'tell me about']),
  ('After Hours',          'support',  'Custom message when business is closed',
   'Inform the customer that the business is currently closed and let them know when you will be open. Offer to take a message.',
   ARRAY[]::TEXT[]),
  ('Custom',               'custom',   'Build your own scenario from scratch',
   '', ARRAY[]::TEXT[])
ON CONFLICT DO NOTHING;

-- ============================================================
-- OTP SESSIONS
-- Short-lived one-time passwords sent via the master WhatsApp
-- session to verify a client's phone number during onboarding.
-- ============================================================

CREATE TABLE IF NOT EXISTS otp_sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number TEXT NOT NULL,
  code         TEXT NOT NULL,
  purpose      TEXT NOT NULL DEFAULT 'connect_session',
  used         BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '10 minutes',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_otp_sessions_expires ON otp_sessions (expires_at) WHERE NOT used;
