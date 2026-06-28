-- ============================================================
-- ERA COMMS — Migration 004: Email Module
-- Self-owned bulk email infrastructure (Postal backend)
-- ============================================================

-- ── SENDING DOMAINS ──────────────────────────────────────────
-- One row per client domain. DNS verification tracked per record type.
-- DKIM private key stored here (Postal-generated) for reference.

CREATE TABLE IF NOT EXISTS email_domains (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  domain          TEXT NOT NULL,
  postal_server_id TEXT,                    -- Postal server ID once registered
  dkim_private_key TEXT,                    -- populated by Postal after domain add
  dkim_public_key  TEXT,                    -- DNS TXT value to publish
  spf_verified    BOOLEAN NOT NULL DEFAULT FALSE,
  dkim_verified   BOOLEAN NOT NULL DEFAULT FALSE,
  dmarc_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  mx_verified     BOOLEAN NOT NULL DEFAULT FALSE,
  verified_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, domain)
);
CREATE INDEX IF NOT EXISTS idx_email_domains_client ON email_domains (client_id);

-- ── EMAIL TEMPLATES ───────────────────────────────────────────
-- HTML templates built with GrapeJS, stored per client.

CREATE TABLE IF NOT EXISTS email_templates (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id  UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  subject    TEXT NOT NULL,
  html_body  TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_email_templates_client ON email_templates (client_id);

-- ── CONTACT LISTS ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS email_contact_lists (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id  UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_email_lists_client ON email_contact_lists (client_id);

-- ── CONTACTS ─────────────────────────────────────────────────
-- email_address normalized to lowercase on insert.

CREATE TABLE IF NOT EXISTS email_contacts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id      UUID NOT NULL REFERENCES email_contact_lists(id) ON DELETE CASCADE,
  client_id    UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE, -- denormalized for RLS
  email        TEXT NOT NULL,
  first_name   TEXT,
  last_name    TEXT,
  metadata     JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (list_id, email)
);
CREATE INDEX IF NOT EXISTS idx_email_contacts_list   ON email_contacts (list_id);
CREATE INDEX IF NOT EXISTS idx_email_contacts_client ON email_contacts (client_id);
CREATE INDEX IF NOT EXISTS idx_email_contacts_email  ON email_contacts (email);

-- ── SUPPRESSIONS ─────────────────────────────────────────────
-- client_id NULL = global suppression (applies to all clients).
-- Populated automatically by the Postal webhook handler.

CREATE TABLE IF NOT EXISTS email_suppressions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT NOT NULL,
  reason     TEXT NOT NULL CHECK (reason IN ('bounce', 'complaint', 'unsubscribe', 'manual')),
  client_id  UUID REFERENCES clients(id) ON DELETE CASCADE, -- NULL = global
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (email, client_id)
);
CREATE INDEX IF NOT EXISTS idx_email_suppressions_email ON email_suppressions (email);

-- ── CAMPAIGNS ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS email_campaigns (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  template_id  UUID NOT NULL REFERENCES email_templates(id),
  list_id      UUID NOT NULL REFERENCES email_contact_lists(id),
  domain_id    UUID NOT NULL REFERENCES email_domains(id),
  from_name    TEXT NOT NULL,
  from_email   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'cancelled', 'failed')),
  scheduled_at TIMESTAMPTZ,
  started_at   TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  total_recipients INTEGER NOT NULL DEFAULT 0,
  total_sent       INTEGER NOT NULL DEFAULT 0,
  total_delivered  INTEGER NOT NULL DEFAULT 0,
  total_clicked    INTEGER NOT NULL DEFAULT 0,
  total_bounced    INTEGER NOT NULL DEFAULT 0,
  total_complained INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_email_campaigns_client ON email_campaigns (client_id);
CREATE INDEX IF NOT EXISTS idx_email_campaigns_status ON email_campaigns (status);

-- ── INDIVIDUAL SENDS ─────────────────────────────────────────
-- One row per recipient per campaign. Postal message ID stored for webhook matching.

CREATE TABLE IF NOT EXISTS email_sends (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id       UUID NOT NULL REFERENCES email_campaigns(id) ON DELETE CASCADE,
  client_id         UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  email             TEXT NOT NULL,
  postal_message_id TEXT,            -- returned by Postal API after send
  status            TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'sent', 'delivered', 'bounced', 'complained', 'failed')),
  delivered_at      TIMESTAMPTZ,
  clicked_at        TIMESTAMPTZ,     -- first click
  bounced_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_email_sends_campaign       ON email_sends (campaign_id);
CREATE INDEX IF NOT EXISTS idx_email_sends_postal_msg_id  ON email_sends (postal_message_id) WHERE postal_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_sends_client         ON email_sends (client_id);

-- ── RAW POSTAL EVENTS ────────────────────────────────────────
-- Every webhook payload from Postal stored for debugging.

CREATE TABLE IF NOT EXISTS email_postal_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  postal_message_id TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  occurred_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload           JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_postal_events_msg_id ON email_postal_events (postal_message_id);

-- ── ROW LEVEL SECURITY ────────────────────────────────────────

ALTER TABLE email_domains         ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_templates       ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_contact_lists   ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_contacts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_campaigns       ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_sends           ENABLE ROW LEVEL SECURITY;

DO $policies$
BEGIN
  -- Suppress "already exists" errors if migration is re-run
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'email_domains' AND policyname = 'client_isolation') THEN
    CREATE POLICY client_isolation ON email_domains
      USING (client_id = current_client_id() OR is_admin_context());
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'email_templates' AND policyname = 'client_isolation') THEN
    CREATE POLICY client_isolation ON email_templates
      USING (client_id = current_client_id() OR is_admin_context());
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'email_contact_lists' AND policyname = 'client_isolation') THEN
    CREATE POLICY client_isolation ON email_contact_lists
      USING (client_id = current_client_id() OR is_admin_context());
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'email_contacts' AND policyname = 'client_isolation') THEN
    CREATE POLICY client_isolation ON email_contacts
      USING (client_id = current_client_id() OR is_admin_context());
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'email_campaigns' AND policyname = 'client_isolation') THEN
    CREATE POLICY client_isolation ON email_campaigns
      USING (client_id = current_client_id() OR is_admin_context());
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'email_sends' AND policyname = 'client_isolation') THEN
    CREATE POLICY client_isolation ON email_sends
      USING (client_id = current_client_id() OR is_admin_context());
  END IF;
END $policies$;
