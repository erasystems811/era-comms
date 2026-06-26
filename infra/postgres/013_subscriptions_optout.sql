-- ── MIGRATION 013: subscriptions opt-out & warning enforcement ──────────────

-- Opt-out registry — track STOP/UNSTOP per phone per client
CREATE TABLE IF NOT EXISTS optout_registry (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  phone_number TEXT NOT NULL,
  opted_out   BOOLEAN NOT NULL DEFAULT TRUE,
  opted_out_at TIMESTAMPTZ,
  opted_in_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, phone_number)
);

CREATE INDEX IF NOT EXISTS idx_optout_client ON optout_registry (client_id);
CREATE INDEX IF NOT EXISTS idx_optout_phone  ON optout_registry (phone_number);

-- Message template library
CREATE TABLE IF NOT EXISTS message_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID REFERENCES clients(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'general',
  content     TEXT NOT NULL,
  variables   TEXT[] NOT NULL DEFAULT '{}',
  is_global   BOOLEAN NOT NULL DEFAULT FALSE,  -- TRUE = available to all clients
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_templates_client ON message_templates (client_id);

-- Seed global templates
INSERT INTO message_templates (client_id, name, category, content, variables, is_global) VALUES
  (NULL, 'Welcome', 'onboarding', 'Hi {{name}}! Welcome to {{business}}. How can we help you today?', ARRAY['name','business'], TRUE),
  (NULL, 'Follow-up', 'general', 'Hi {{name}}, just following up on our last conversation. Is there anything else you need?', ARRAY['name'], TRUE),
  (NULL, 'Order Confirmation', 'orders', 'Your order #{{order_id}} has been confirmed! Expected delivery: {{date}}.', ARRAY['order_id','date'], TRUE),
  (NULL, 'Appointment Reminder', 'scheduling', 'Reminder: your appointment is scheduled for {{date}} at {{time}}. Reply YES to confirm.', ARRAY['date','time'], TRUE)
ON CONFLICT DO NOTHING;

-- Add total_completed to automation_flows if missing
DO $$ BEGIN
  ALTER TABLE automation_flows ADD COLUMN IF NOT EXISTS total_completed INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE automation_enrollments ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Add warning enforcement columns to clients if missing
DO $$ BEGIN
  ALTER TABLE clients ADD COLUMN IF NOT EXISTS warning_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE clients ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
  ALTER TABLE clients ADD COLUMN IF NOT EXISTS suspension_reason TEXT;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Revenue: add flutterwave tx id to subscriptions
DO $$ BEGIN
  ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS flw_tx_id TEXT;
  ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS flw_customer_id TEXT;
  ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS amount NUMERIC(10,2);
  ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'NGN';
  ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS next_payment_at TIMESTAMPTZ;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Session QR pairing token (for self-service connect)
CREATE TABLE IF NOT EXISTS session_connect_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  session_id  UUID REFERENCES whatsapp_sessions(id) ON DELETE CASCADE,
  token       TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(24), 'hex'),
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 minutes',
  used        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
