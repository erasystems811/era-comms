-- ── EMAIL AUTOMATION SEQUENCES ────────────────────────────────

-- Drip campaign flows (one flow = a sequence of steps per client)
CREATE TABLE IF NOT EXISTS email_automation_flows (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  trigger_key     TEXT UNIQUE,
  status          TEXT NOT NULL DEFAULT 'active', -- active / archived
  total_enrolled  INT  NOT NULL DEFAULT 0,
  total_completed INT  NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS email_automation_flows_client_idx ON email_automation_flows(client_id);

-- Ordered steps within a flow
CREATE TABLE IF NOT EXISTS email_automation_steps (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id       UUID NOT NULL REFERENCES email_automation_flows(id) ON DELETE CASCADE,
  step_index    INT  NOT NULL,
  step_type     TEXT NOT NULL CHECK (step_type IN ('send_email', 'wait')),
  -- For send_email steps
  template_id   UUID REFERENCES email_templates(id) ON DELETE SET NULL,
  domain_id     UUID REFERENCES email_domains(id)   ON DELETE SET NULL,
  from_name     TEXT,
  from_email    TEXT,
  -- For wait steps (also used as pre-send delay on send_email steps)
  delay_minutes INT  NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(flow_id, step_index)
);

-- One row per enrolled contact per flow
CREATE TABLE IF NOT EXISTS email_automation_enrollments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id      UUID NOT NULL REFERENCES email_automation_flows(id) ON DELETE CASCADE,
  client_id    UUID NOT NULL,
  email        TEXT NOT NULL,
  first_name   TEXT,
  last_name    TEXT,
  current_step INT  NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'active', -- active / completed / unsubscribed / failed
  next_step_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(flow_id, email)
);

CREATE INDEX IF NOT EXISTS email_auto_enroll_due_idx
  ON email_automation_enrollments(status, next_step_at)
  WHERE status = 'active';

-- Track each email sent by an automation step (for stats + unsubscribe linking)
CREATE TABLE IF NOT EXISTS email_automation_sends (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id     UUID NOT NULL REFERENCES email_automation_enrollments(id) ON DELETE CASCADE,
  step_index        INT  NOT NULL,
  email             TEXT NOT NULL,
  postal_message_id TEXT,
  status            TEXT NOT NULL DEFAULT 'sent', -- sent / delivered / bounced / failed
  sent_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at      TIMESTAMPTZ,
  bounced_at        TIMESTAMPTZ
);

-- Store the send_id on email_sends for unsubscribe link tracking
ALTER TABLE email_sends ADD COLUMN IF NOT EXISTS unsubscribed_at TIMESTAMPTZ;
ALTER TABLE email_sends ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ;
