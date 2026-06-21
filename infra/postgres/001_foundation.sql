-- ============================================================
-- ERA COMMS — COMPLETE DATABASE SCHEMA
-- Migration 001: Foundation
-- PostgreSQL 15+ with TimescaleDB
-- ============================================================

-- EXTENSIONS
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "timescaledb";

-- APPLICATION ROLES
-- On managed cloud databases (Timescale Cloud, RDS, Supabase, etc.) the
-- connecting user may not have CREATEROLE or superuser, so all role
-- management is best-effort and skipped gracefully on permission errors.
DO $$ BEGIN
  CREATE ROLE era_app;
EXCEPTION WHEN duplicate_object THEN NULL;
         WHEN insufficient_privilege THEN
  RAISE NOTICE 'Cannot CREATE ROLE era_app — skipping (managed DB)';
END $$;

DO $$ BEGIN
  CREATE ROLE era_admin;
EXCEPTION WHEN duplicate_object THEN NULL;
         WHEN insufficient_privilege THEN
  RAISE NOTICE 'Cannot CREATE ROLE era_admin — skipping (managed DB)';
END $$;

DO $$ BEGIN
  CREATE ROLE era_readonly;
EXCEPTION WHEN duplicate_object THEN NULL;
         WHEN insufficient_privilege THEN
  RAISE NOTICE 'Cannot CREATE ROLE era_readonly — skipping (managed DB)';
END $$;


-- ============================================================
-- SECTION 1: PLANS
-- Seeded. Operator does not configure plans at runtime.
-- ============================================================

CREATE TABLE plans (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,

  -- Feature flags
  ai_enabled            BOOLEAN NOT NULL DEFAULT TRUE,
  voice_enabled         BOOLEAN NOT NULL DEFAULT FALSE,
  premium_voice_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  analytics_enabled     BOOLEAN NOT NULL DEFAULT TRUE,

  -- Limits (NULL = unlimited)
  monthly_message_cap   INTEGER,
  daily_message_cap     INTEGER,
  hourly_message_cap    INTEGER,
  max_sessions          INTEGER DEFAULT 1,          -- NULL = unlimited
  max_contacts          INTEGER,

  -- Billing
  billing_model         TEXT NOT NULL CHECK (billing_model IN ('none', 'usage_based', 'plan_based')),
  monthly_fee           DECIMAL(10,2),
  price_per_message     DECIMAL(10,6),
  price_per_ai_turn     DECIMAL(10,6),
  price_per_call_minute DECIMAL(10,6),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO plans (
  name, display_name, billing_model,
  ai_enabled, voice_enabled, premium_voice_enabled,
  max_sessions, monthly_message_cap, daily_message_cap, hourly_message_cap
) VALUES
  ('internal',     'ERA Systems Internal', 'none',        TRUE, TRUE,  TRUE,  10,   NULL,  NULL, NULL),
  ('starter',      'Starter',              'usage_based', TRUE, FALSE, FALSE, 1,    1000,  100,  20),
  ('professional', 'Professional',         'plan_based',  TRUE, TRUE,  FALSE, 3,    10000, 500,  100),
  ('enterprise',   'Enterprise',           'plan_based',  TRUE, TRUE,  TRUE,  NULL, NULL,  NULL, NULL);

-- ============================================================
-- SECTION 2: BUSINESS CATEGORIES
-- Seeded. The ten categories are fixed.
-- ============================================================

CREATE TABLE business_categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO business_categories (slug, name) VALUES
  ('healthcare',            'Healthcare'),
  ('retail',                'Retail'),
  ('hospitality',           'Hospitality'),
  ('logistics',             'Logistics'),
  ('finance',               'Finance'),
  ('education',             'Education'),
  ('real_estate',           'Real Estate'),
  ('professional_services', 'Professional Services'),
  ('ecommerce',             'E-commerce'),
  ('general',               'General');

-- ============================================================
-- SECTION 3: DEFAULT COMMUNICATION PROFILES
-- One per category. Applied automatically at client signup.
-- system_prompt uses {business_name} as the only template variable.
-- ============================================================

CREATE TABLE default_communication_profiles (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id         UUID NOT NULL REFERENCES business_categories(id) UNIQUE,
  persona             TEXT NOT NULL,
  tone                TEXT NOT NULL,
  permitted_topics    TEXT[] NOT NULL DEFAULT '{}',
  prohibited_topics   TEXT[] NOT NULL DEFAULT '{}',
  escalation_triggers TEXT[] NOT NULL DEFAULT '{}',
  system_prompt       TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Healthcare
INSERT INTO default_communication_profiles
  (category_id, persona, tone, permitted_topics, prohibited_topics, escalation_triggers, system_prompt)
SELECT id,
  'A professional, empathetic healthcare communication assistant',
  'Warm, clear, measured, and never alarmist',
  ARRAY[
    'appointment scheduling and reminders',
    'general wellness information',
    'medication reminders',
    'test result notifications (non-sensitive)',
    'referral coordination',
    'clinic hours and location',
    'billing inquiries'
  ],
  ARRAY[
    'specific medical diagnoses',
    'prescription advice',
    'mental health crisis intervention',
    'emergency medical guidance',
    'clinical second opinions'
  ],
  ARRAY[
    'patient describes emergency symptoms',
    'suicidal ideation or self-harm',
    'request for specific diagnosis',
    'expressed severe distress',
    'request for prescription change'
  ],
  'You are a professional healthcare communication assistant for {business_name}. You are warm, empathetic, and always put patient wellbeing first.

You assist with: appointment scheduling and reminders, general health and wellness information, medication and treatment reminders, test result notifications, referral coordination, and billing inquiries.

You never provide specific medical diagnoses, prescription recommendations, or emergency medical guidance. If a patient describes a medical emergency, immediately direct them to call emergency services and stop the conversation there.

Your tone is professional, warm, and clear. Avoid medical jargon unless the patient uses it first. Never be alarmist. If a topic falls outside your scope, acknowledge the patient with empathy and explain that a healthcare professional needs to handle it directly.

Always respond in the language the patient writes in.'
FROM business_categories WHERE slug = 'healthcare';

-- Retail
INSERT INTO default_communication_profiles
  (category_id, persona, tone, permitted_topics, prohibited_topics, escalation_triggers, system_prompt)
SELECT id,
  'A friendly, knowledgeable retail assistant',
  'Upbeat, warm, and solution-oriented',
  ARRAY[
    'product inquiries and recommendations',
    'order status and tracking',
    'returns and exchanges',
    'promotions and discount codes',
    'product availability',
    'store hours and locations',
    'loyalty programs'
  ],
  ARRAY[
    'competitor attacks or comparisons',
    'political opinions',
    'personal lifestyle advice unrelated to products',
    'price negotiation beyond stated policy'
  ],
  ARRAY[
    'customer uses threatening or abusive language',
    'legal threat',
    'product safety complaint',
    'refund dispute the agent cannot resolve'
  ],
  'You are a friendly and knowledgeable retail assistant for {business_name}. You genuinely enjoy helping customers find what they need.

You assist with: product questions and recommendations, order status and tracking, returns and exchanges within policy, current promotions, product availability, and store information.

Stay focused on helping with retail needs. Do not discuss competitors or anything outside your product scope. If a customer wants something beyond your authority, acknowledge it warmly and offer to connect them with a team member.

Your tone is upbeat and genuinely helpful. Keep responses concise and action-oriented.

Always respond in the language the customer writes in.'
FROM business_categories WHERE slug = 'retail';

-- Hospitality
INSERT INTO default_communication_profiles
  (category_id, persona, tone, permitted_topics, prohibited_topics, escalation_triggers, system_prompt)
SELECT id,
  'An attentive, gracious hospitality host',
  'Warm, gracious, attentive, and quietly professional',
  ARRAY[
    'reservations and booking modifications',
    'check-in and check-out information',
    'amenities and facilities',
    'local area recommendations',
    'special requests',
    'dining information',
    'billing and charges'
  ],
  ARRAY[
    'personal opinions about guests',
    'other guests'' information',
    'discriminatory content'
  ],
  ARRAY[
    'guest reports safety concern',
    'health emergency',
    'legal threat',
    'unresolvable billing dispute',
    'expressed severe dissatisfaction requiring management'
  ],
  'You are a gracious hospitality assistant for {business_name}. Every guest is a valued visitor and your role is to make their experience seamless and enjoyable.

You assist with: reservations and booking modifications, check-in and check-out queries, amenities and facilities information, local area recommendations, special requests, dining, and billing.

You are warm, attentive, and quietly professional. Anticipate needs where possible. If a guest has a complaint, acknowledge it with genuine care before moving to a solution. Never argue with a guest. If something cannot be resolved, commit to connecting them with someone who can.

Always respond in the language the guest writes in.'
FROM business_categories WHERE slug = 'hospitality';

-- Logistics
INSERT INTO default_communication_profiles
  (category_id, persona, tone, permitted_topics, prohibited_topics, escalation_triggers, system_prompt)
SELECT id,
  'An efficient, precise logistics coordinator',
  'Clear, factual, efficient, and reliable',
  ARRAY[
    'shipment tracking and status',
    'delivery windows and ETAs',
    'address corrections',
    'pickup scheduling',
    'delay notifications',
    'proof of delivery',
    'collection instructions'
  ],
  ARRAY[
    'contents of shipments',
    'naming and blaming third-party carriers',
    'pricing negotiations',
    'competitor comparisons'
  ],
  ARRAY[
    'customer reports lost shipment',
    'damaged goods claim',
    'customs hold dispute',
    'customer demands compensation',
    'high-value missing item'
  ],
  'You are a logistics communication assistant for {business_name}. Your job is to keep customers accurately informed about their shipments and resolve straightforward queries efficiently.

You assist with: shipment tracking, delivery window information, address corrections where possible, pickup scheduling, delay notifications with honest ETAs, and proof of delivery.

Be precise and factual. Do not speculate about delays or make promises you cannot guarantee. If a shipment status is unclear, say so honestly and commit to following up. Never blame third-party carriers by name.

Always respond in the language the customer writes in.'
FROM business_categories WHERE slug = 'logistics';

-- Finance
INSERT INTO default_communication_profiles
  (category_id, persona, tone, permitted_topics, prohibited_topics, escalation_triggers, system_prompt)
SELECT id,
  'A professional, trustworthy financial services assistant',
  'Professional, measured, precise, and reassuring',
  ARRAY[
    'account balance and transaction inquiries',
    'payment confirmations and reminders',
    'general product and eligibility information',
    'branch and contact information',
    'statement requests'
  ],
  ARRAY[
    'specific investment advice',
    'guaranteed return promises',
    'specific tax or legal advice',
    'regulatory disclosures without proper framing'
  ],
  ARRAY[
    'customer reports fraud or unauthorized transaction',
    'large disputed transaction',
    'regulatory or compliance complaint',
    'expressed financial distress',
    'legal threat'
  ],
  'You are a financial services communication assistant for {business_name}. Accuracy, trustworthiness, and professionalism are your most important qualities.

You assist with: account and transaction inquiries, payment confirmations and reminders, general product information, and directing customers to the right department.

You never give specific investment, tax, or legal advice. For any query involving fraud or unauthorized access, escalate immediately without attempting to resolve it yourself. If you do not have the information, say so clearly and explain how to get it.

Your tone is calm, precise, and reassuring.

Always respond in the language the customer writes in.'
FROM business_categories WHERE slug = 'finance';

-- Education
INSERT INTO default_communication_profiles
  (category_id, persona, tone, permitted_topics, prohibited_topics, escalation_triggers, system_prompt)
SELECT id,
  'A supportive, encouraging education assistant',
  'Supportive, clear, encouraging, and informative',
  ARRAY[
    'course and program information',
    'enrollment and registration',
    'class schedules and timetables',
    'assignment and deadline reminders',
    'academic support resources',
    'fee and payment information',
    'campus and facility information'
  ],
  ARRAY[
    'personal relationship advice',
    'non-educational content',
    'political opinions',
    'discriminatory content'
  ],
  ARRAY[
    'student expresses mental health concerns',
    'safeguarding concern',
    'academic integrity violation reported',
    'expressed severe distress',
    'parent or guardian complaint requiring management'
  ],
  'You are an education communication assistant for {business_name}. You support students and families in navigating their educational journey.

You assist with: course and program information, enrollment and registration, schedules, assignment reminders, academic support resources, fees, and campus information.

You are encouraging and supportive. If a student expresses distress, respond with empathy and direct them to the appropriate support resources — do not attempt to counsel them yourself.

Always respond in the language the student or family writes in.'
FROM business_categories WHERE slug = 'education';

-- Real Estate
INSERT INTO default_communication_profiles
  (category_id, persona, tone, permitted_topics, prohibited_topics, escalation_triggers, system_prompt)
SELECT id,
  'A knowledgeable, professional real estate assistant',
  'Professional, knowledgeable, aspirational, and honest',
  ARRAY[
    'property listings and availability',
    'viewing and inspection scheduling',
    'general market information',
    'offer and negotiation process overview',
    'documentation requirements',
    'rental and purchase process explanation'
  ],
  ARRAY[
    'guaranteed property value predictions',
    'specific legal or mortgage advice',
    'discriminatory steering',
    'high-pressure tactics'
  ],
  ARRAY[
    'legal dispute over property',
    'contract disagreement',
    'discriminatory inquiry',
    'expressed fraud concern',
    'large transaction conflict'
  ],
  'You are a real estate communication assistant for {business_name}. You help buyers, sellers, and renters navigate the property process with clarity and confidence.

You assist with: property listings, scheduling viewings, explaining the buying, selling, or rental process, documentation requirements, and general market context.

You never guarantee property values or give legal, tax, or mortgage advice. Be honest about timelines and complexity. If a client has specific professional questions, direct them to the right expert.

Your tone is professional, warm, and aspirational.

Always respond in the language the client writes in.'
FROM business_categories WHERE slug = 'real_estate';

-- Professional Services
INSERT INTO default_communication_profiles
  (category_id, persona, tone, permitted_topics, prohibited_topics, escalation_triggers, system_prompt)
SELECT id,
  'A competent, professional services assistant',
  'Professional, expert, approachable, and solution-focused',
  ARRAY[
    'service inquiries and scope',
    'project and engagement status',
    'scheduling consultations',
    'deliverable timelines',
    'invoice and payment information',
    'general process explanation'
  ],
  ARRAY[
    'specific regulated advice outside stated service scope',
    'competitor comparisons',
    'confidential client information disclosure'
  ],
  ARRAY[
    'contract dispute',
    'quality complaint requiring management involvement',
    'legal threat',
    'scope disagreement',
    'client sharing sensitive data requiring secure handling'
  ],
  'You are a professional services communication assistant for {business_name}. Clients come to you because they need expert help, and your role is to make that experience seamless.

You assist with: service and scope inquiries, project status updates, scheduling consultations, deliverable timelines, and invoice information.

You never overpromise or give specific advice outside the engagement scope. If a client asks something requiring direct expert input, acknowledge it and commit to getting them the right answer from the right person.

Always respond in the language the client writes in.'
FROM business_categories WHERE slug = 'professional_services';

-- E-commerce
INSERT INTO default_communication_profiles
  (category_id, persona, tone, permitted_topics, prohibited_topics, escalation_triggers, system_prompt)
SELECT id,
  'A helpful, energetic e-commerce assistant',
  'Friendly, energetic, efficient, and solution-focused',
  ARRAY[
    'order status and tracking',
    'product questions and recommendations',
    'returns and refund policy',
    'exchange process',
    'promotions and discount codes',
    'account help',
    'payment inquiries'
  ],
  ARRAY[
    'competitor price attacks',
    'pressure tactics',
    'personal data misuse'
  ],
  ARRAY[
    'payment dispute',
    'account security concern',
    'product safety complaint',
    'threatening or abusive customer',
    'fraud concern'
  ],
  'You are an e-commerce assistant for {business_name}. You keep customers informed, solve problems quickly, and make shopping a great experience.

You assist with: order status and tracking, product information and recommendations, returns and exchanges within policy, promotional codes, account access, and payment questions.

Be friendly and solution-focused. If a customer has a problem, focus on fixing it. Keep responses brief and clear. If something is outside your authority, say what you can do and who can help with the rest.

Always respond in the language the customer writes in.'
FROM business_categories WHERE slug = 'ecommerce';

-- General (fallback)
INSERT INTO default_communication_profiles
  (category_id, persona, tone, permitted_topics, prohibited_topics, escalation_triggers, system_prompt)
SELECT id,
  'A professional, neutral business communication assistant',
  'Professional, clear, helpful, and neutral',
  ARRAY[
    'general business inquiries',
    'information sharing',
    'scheduling and appointments',
    'service information',
    'contact and location details'
  ],
  ARRAY[
    'political content',
    'sensitive personal matters',
    'regulated professional advice',
    'discriminatory content'
  ],
  ARRAY[
    'legal threat',
    'safety concern',
    'expressed severe customer distress',
    'topics clearly outside stated business scope'
  ],
  'You are a business communication assistant for {business_name}. You handle customer inquiries professionally and helpfully.

You assist with general business inquiries, service information, scheduling, and questions about the business.

Stay focused on business-relevant topics. If a question falls outside your scope, acknowledge it politely and direct the customer to the right channel. Be professional and clear in all responses.

Always respond in the language the customer writes in.'
FROM business_categories WHERE slug = 'general';

-- ============================================================
-- SECTION 4: CLIENTS
-- ============================================================

CREATE TABLE clients (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('internal', 'external')),
  plan_id     UUID NOT NULL REFERENCES plans(id),
  category_id UUID REFERENCES business_categories(id),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'pending')),

  -- Voice profile FK added after voice_profiles table is created
  voice_profile_id UUID,

  contact_email TEXT,
  metadata      JSONB NOT NULL DEFAULT '{}',

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- SECTION 5: API KEYS
-- Full key is never stored. key_prefix (first 20 chars) is used
-- for fast index lookup. key_hash (SHA-256) is used for verification.
-- Key format: era_live_<32 random chars> | era_test_<32 random chars>
-- ============================================================

CREATE TABLE api_keys (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID NOT NULL REFERENCES clients(id),

  key_hash    TEXT NOT NULL UNIQUE,
  key_prefix  TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('live', 'test')),

  -- Scopes: 'messaging' | 'calls' | 'conversations' | 'analytics' | 'admin'
  scopes      TEXT[] NOT NULL DEFAULT '{}',

  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
  expires_at  TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_api_keys_prefix ON api_keys (key_prefix);
CREATE INDEX idx_api_keys_client ON api_keys (client_id);

-- ============================================================
-- SECTION 6: WEBHOOK ENDPOINTS AND DELIVERIES
-- ============================================================

CREATE TABLE webhook_endpoints (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id),
  url       TEXT NOT NULL,
  -- HMAC-SHA256 secret stored in plaintext (used for signing outbound payloads)
  secret    TEXT NOT NULL,
  -- Events that trigger delivery to this endpoint
  events    TEXT[] NOT NULL DEFAULT '{}',
  status    TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_webhook_endpoints_client ON webhook_endpoints (client_id);

CREATE TABLE webhook_deliveries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id UUID NOT NULL REFERENCES webhook_endpoints(id),
  client_id   UUID NOT NULL REFERENCES clients(id), -- denormalized for RLS

  event_type  TEXT NOT NULL,
  payload     JSONB NOT NULL,

  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'delivered', 'failed', 'dead_lettered')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 10,

  next_retry_at   TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  response_status INTEGER,
  response_body   TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_webhook_deliveries_retry ON webhook_deliveries (next_retry_at)
  WHERE status IN ('pending', 'failed');
CREATE INDEX idx_webhook_deliveries_client ON webhook_deliveries (client_id);

-- ============================================================
-- SECTION 7: COMMUNICATION PROFILES
-- One profile per client. Edits create new versions.
-- Conversations are pinned to the version active at start.
-- Circular FK (current_version_id) is deferred to handle the
-- chicken-and-egg insert order.
-- ============================================================

CREATE TABLE communication_profiles (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id          UUID NOT NULL REFERENCES clients(id) UNIQUE,
  level              INTEGER NOT NULL DEFAULT 1 CHECK (level IN (1, 2, 3)),
  -- NULL until first version is inserted, then set atomically
  current_version_id UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE communication_profile_versions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id     UUID NOT NULL REFERENCES communication_profiles(id),
  client_id      UUID NOT NULL REFERENCES clients(id), -- denormalized for RLS
  version_number INTEGER NOT NULL,

  persona             TEXT NOT NULL,
  tone                TEXT NOT NULL,
  permitted_topics    TEXT[] NOT NULL DEFAULT '{}',
  prohibited_topics   TEXT[] NOT NULL DEFAULT '{}',
  escalation_triggers TEXT[] NOT NULL DEFAULT '{}',
  system_prompt       TEXT NOT NULL,

  -- Level 2 additions (NULL at level 1)
  faqs           JSONB, -- [{question: str, answer: str}]
  business_hours JSONB, -- {timezone: str, schedule: [{day: 0-6, open: "09:00", close: "17:00"}]}

  created_by TEXT NOT NULL DEFAULT 'system', -- 'system' | 'operator' | 'client'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (profile_id, version_number)
);

-- Deferred FK resolves the circular reference
ALTER TABLE communication_profiles
  ADD CONSTRAINT fk_current_version
  FOREIGN KEY (current_version_id)
  REFERENCES communication_profile_versions(id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX idx_profile_versions_profile ON communication_profile_versions (profile_id, version_number DESC);

-- ============================================================
-- SECTION 8: VOICE PROFILES (Coqui XTTS v2)
-- client_id NULL = ERA Comms default voice, readable by all clients.
-- Premium clients have their own voice_profile row.
-- ============================================================

CREATE TABLE voice_profiles (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         UUID REFERENCES clients(id), -- NULL = default shared voice
  name              TEXT NOT NULL,
  level             TEXT NOT NULL CHECK (level IN ('default', 'premium', 'enterprise')),

  model_type        TEXT NOT NULL DEFAULT 'xtts_v2',
  voice_sample_path TEXT,     -- path to original recording
  cloned_voice_id   TEXT,     -- XTTS internal speaker embedding ID

  status  TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
  cloned_at  TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Default ERA Comms voice — operator records and clones after first deploy
INSERT INTO voice_profiles (client_id, name, level, model_type, status)
VALUES (NULL, 'ERA Default Voice', 'default', 'xtts_v2', 'pending');

-- Now safe to add voice_profile_id FK to clients
ALTER TABLE clients
  ADD CONSTRAINT fk_voice_profile
  FOREIGN KEY (voice_profile_id)
  REFERENCES voice_profiles(id);

-- ============================================================
-- SECTION 9: WHATSAPP SESSIONS
-- phone_number is globally unique — one WhatsApp session per number
-- across all clients (WhatsApp's own constraint).
-- Credentials are AES-256-GCM encrypted at application layer before
-- storage. Redis is the fast-path cache; PostgreSQL is recovery truth.
-- ============================================================

CREATE TABLE whatsapp_sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    UUID NOT NULL REFERENCES clients(id),
  phone_number TEXT NOT NULL UNIQUE,
  role         TEXT NOT NULL DEFAULT 'primary' CHECK (role IN ('primary', 'backup')),

  -- Status lifecycle:
  -- pending_qr  -> warming_up -> active
  -- active      -> flagged -> cooldown -> active (recovery)
  -- active      -> banned (terminal, requires replacement)
  -- any         -> disconnected (supervisor will attempt reconnect)
  status TEXT NOT NULL DEFAULT 'pending_qr'
         CHECK (status IN ('pending_qr', 'warming_up', 'active', 'flagged', 'cooldown', 'banned', 'disconnected')),

  -- Application-level AES-256-GCM encrypted Baileys auth state
  credentials_encrypted  TEXT,
  credentials_iv         TEXT, -- base64 encoded
  credentials_tag        TEXT, -- base64 encoded AES-GCM auth tag
  credentials_updated_at TIMESTAMPTZ,

  -- Stable device identity — must be identical on every reconnect
  device_fingerprint JSONB,

  -- Risk score: 0.000 (clean) to 1.000 (critical)
  risk_score      DECIMAL(4,3) NOT NULL DEFAULT 0.000 CHECK (risk_score BETWEEN 0.000 AND 1.000),
  risk_updated_at TIMESTAMPTZ,

  -- Connection tracking
  connected_at      TIMESTAMPTZ,
  last_heartbeat_at TIMESTAMPTZ,
  disconnected_at   TIMESTAMPTZ,

  -- Rolling traffic stats (updated async, not on critical path)
  messages_sent_total     BIGINT NOT NULL DEFAULT 0,
  messages_received_total BIGINT NOT NULL DEFAULT 0,

  -- Cooldown window
  cooldown_until TIMESTAMPTZ,

  -- Backup relationship
  -- primary_session_id is set on backup numbers, pointing to their primary
  primary_session_id     UUID REFERENCES whatsapp_sessions(id),
  activated_as_backup_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sessions_client  ON whatsapp_sessions (client_id);
CREATE INDEX idx_sessions_status  ON whatsapp_sessions (status);
CREATE INDEX idx_sessions_primary ON whatsapp_sessions (primary_session_id)
  WHERE primary_session_id IS NOT NULL;

-- ============================================================
-- SECTION 10: WARMUP PROFILES
-- Every session (including backups) has a warmup profile from
-- registration. volume_curve and content_stages are JSONB for
-- flexibility — the engine interpolates between curve points.
-- skip_warmup = TRUE grants full capacity from day one.
-- ============================================================

CREATE TABLE warmup_profiles (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES whatsapp_sessions(id) UNIQUE,
  client_id  UUID NOT NULL REFERENCES clients(id), -- denormalized for RLS

  -- [{day: N, cap: M}] — interpolated between points
  volume_curve JSONB NOT NULL DEFAULT '[
    {"day": 1,  "cap": 5},
    {"day": 7,  "cap": 25},
    {"day": 14, "cap": 75},
    {"day": 21, "cap": 200},
    {"day": 30, "cap": 500}
  ]'::jsonb,

  -- Content guidance by warmup day
  content_stages JSONB NOT NULL DEFAULT '[
    {"until_day": 7,  "guidance": "conversational"},
    {"until_day": 14, "guidance": "light_cta"},
    {"from_day":  15, "guidance": "unrestricted"}
  ]'::jsonb,

  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  current_day INTEGER NOT NULL DEFAULT 1,
  is_complete BOOLEAN NOT NULL DEFAULT FALSE,
  skip_warmup BOOLEAN NOT NULL DEFAULT FALSE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- SECTION 11: CONTACTS
-- Unique per client by phone number.
-- No opt-out column — opt-out handling is the connected system's concern.
-- ============================================================

CREATE TABLE contacts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    UUID NOT NULL REFERENCES clients(id),
  phone_number TEXT NOT NULL,
  display_name TEXT,
  metadata     JSONB NOT NULL DEFAULT '{}',

  total_conversations INTEGER NOT NULL DEFAULT 0,
  last_contacted_at   TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (client_id, phone_number)
);

CREATE INDEX idx_contacts_client ON contacts (client_id);

-- ============================================================
-- SECTION 12: CONVERSATIONS
-- profile_version_id is pinned at conversation start and never changes.
-- ai_active controls whether the AI responds. Set to FALSE on escalation.
-- ============================================================

CREATE TABLE conversations (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id          UUID NOT NULL REFERENCES clients(id),
  contact_id         UUID NOT NULL REFERENCES contacts(id),
  session_id         UUID NOT NULL REFERENCES whatsapp_sessions(id),
  profile_version_id UUID NOT NULL REFERENCES communication_profile_versions(id),

  status TEXT NOT NULL DEFAULT 'active'
         CHECK (status IN ('active', 'escalated', 'closed')),
  ai_active BOOLEAN NOT NULL DEFAULT TRUE,

  -- Escalation
  escalated_at      TIMESTAMPTZ,
  escalation_reason TEXT,
  resumed_at        TIMESTAMPTZ,

  -- AI context management
  total_turns         INTEGER NOT NULL DEFAULT 0,
  context_summary     TEXT,     -- AI-generated rolling summary of older turns
  last_summarized_at  TIMESTAMPTZ,
  last_ai_model       TEXT,     -- model used on last AI turn

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_conversations_client  ON conversations (client_id);
CREATE INDEX idx_conversations_contact ON conversations (contact_id, created_at DESC);
CREATE INDEX idx_conversations_open    ON conversations (client_id, status)
  WHERE status != 'closed';

-- ============================================================
-- SECTION 13: MESSAGES
-- idempotency_key is client-supplied, unique per client.
-- original_content stores pre-variation text for audit.
-- ai_bypassed = TRUE marks human takeover messages in escalated
-- conversations — these bypass AI variation and go out as written.
-- ============================================================

CREATE TABLE messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  client_id       UUID NOT NULL REFERENCES clients(id), -- denormalized for RLS
  session_id      UUID NOT NULL REFERENCES whatsapp_sessions(id),

  direction    TEXT NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  content      TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'text'
               CHECK (content_type IN ('text', 'image', 'audio', 'video', 'document')),
  media_url    TEXT,

  -- Client-supplied. Unique per client. Duplicate keys return first result.
  idempotency_key TEXT NOT NULL,

  -- WhatsApp internal message ID (set after successful send)
  wa_message_id TEXT,

  status TEXT NOT NULL DEFAULT 'queued'
         CHECK (status IN ('queued', 'sent', 'delivered', 'read', 'failed', 'dead_lettered')),

  -- Anti-detection record
  original_content TEXT,    -- content before variation pass
  was_varied       BOOLEAN NOT NULL DEFAULT FALSE,
  warmup_stage     TEXT,    -- 'conversational' | 'light_cta' | 'unrestricted'
  scheduled_for    TIMESTAMPTZ, -- time-window adjusted send time (NULL = send immediately)
  sent_at          TIMESTAMPTZ,

  -- AI metadata
  ai_generated BOOLEAN NOT NULL DEFAULT FALSE,
  ai_model     TEXT,
  ai_bypassed  BOOLEAN NOT NULL DEFAULT FALSE,

  -- Billing
  is_billable BOOLEAN NOT NULL DEFAULT TRUE,
  billed_at   TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (client_id, idempotency_key)
);

CREATE INDEX idx_messages_conversation ON messages (conversation_id, created_at ASC);
CREATE INDEX idx_messages_wa_id        ON messages (wa_message_id) WHERE wa_message_id IS NOT NULL;
CREATE INDEX idx_messages_queued       ON messages (scheduled_for)
  WHERE status = 'queued' AND scheduled_for IS NOT NULL;

-- ============================================================
-- SECTION 14: MESSAGE EVENTS
-- Append-only delivery receipt log. One row per status transition.
-- ============================================================

CREATE TABLE message_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id),
  client_id  UUID NOT NULL REFERENCES clients(id), -- denormalized for RLS

  event_type TEXT NOT NULL
             CHECK (event_type IN ('queued', 'sent', 'delivered', 'read', 'failed', 'retry')),
  failure_reason TEXT,
  wa_event_id    TEXT,
  metadata       JSONB,

  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_message_events_message ON message_events (message_id, occurred_at DESC);

-- ============================================================
-- SECTION 15: VOICE CALLS
-- conversation_id links to the messaging thread for full context.
-- transcript is JSONB array: [{role, text, timestamp}]
-- ============================================================

CREATE TABLE voice_calls (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        UUID NOT NULL REFERENCES clients(id),
  contact_id       UUID NOT NULL REFERENCES contacts(id),
  conversation_id  UUID REFERENCES conversations(id), -- messaging thread for AI context
  voice_profile_id UUID REFERENCES voice_profiles(id),

  to_number   TEXT NOT NULL,
  from_number TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'initiated'
         CHECK (status IN ('initiated', 'ringing', 'in_progress', 'completed', 'failed', 'no_answer', 'busy')),

  initiated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answered_at      TIMESTAMPTZ,
  ended_at         TIMESTAMPTZ,
  duration_seconds INTEGER,

  ai_model       TEXT,
  transcript     JSONB, -- [{role: 'user'|'assistant', text: str, ts: timestamptz}]
  recording_path TEXT,

  freeswitch_call_uuid TEXT,
  sip_call_id          TEXT,

  is_billable BOOLEAN NOT NULL DEFAULT TRUE,
  billed_at   TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_voice_calls_client  ON voice_calls (client_id, initiated_at DESC);
CREATE INDEX idx_voice_calls_contact ON voice_calls (contact_id);

-- ============================================================
-- SECTION 16: USAGE EVENTS — TimescaleDB Hypertable
-- Append-only. Never queried for enforcement (Redis handles that).
-- Source of truth for billing audit and analytics.
-- Partitioned by occurred_at.
-- ============================================================

CREATE TABLE usage_events (
  id          UUID NOT NULL DEFAULT gen_random_uuid(),
  client_id   UUID NOT NULL REFERENCES clients(id),

  event_type  TEXT NOT NULL CHECK (event_type IN (
    'message_sent',
    'message_received',
    'ai_turn',
    'ai_tokens',
    'voice_call_initiated',
    'voice_call_second',
    'webhook_delivered'
  )),

  -- For token counts and fractional quantities
  quantity     DECIMAL(14,4) NOT NULL DEFAULT 1,
  reference_id UUID,    -- message_id, call_id, etc. for traceability
  metadata     JSONB,

  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (id, occurred_at)
);

SELECT create_hypertable('usage_events', 'occurred_at');

CREATE INDEX idx_usage_client_time ON usage_events (client_id, occurred_at DESC);

-- Raw events retained 90 days; aggregates are permanent
SELECT add_retention_policy('usage_events', INTERVAL '90 days');

-- Hourly aggregate — used for dashboard and recent billing checks
CREATE MATERIALIZED VIEW usage_hourly
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', occurred_at) AS bucket,
  client_id,
  event_type,
  SUM(quantity)  AS total_quantity,
  COUNT(*)       AS event_count
FROM usage_events
GROUP BY 1, 2, 3;

SELECT add_continuous_aggregate_policy('usage_hourly',
  start_offset => INTERVAL '3 hours',
  end_offset   => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour');

-- Daily aggregate — used for plan cap enforcement checks and reporting
CREATE MATERIALIZED VIEW usage_daily
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 day', occurred_at) AS bucket,
  client_id,
  event_type,
  SUM(quantity)  AS total_quantity,
  COUNT(*)       AS event_count
FROM usage_events
GROUP BY 1, 2, 3;

SELECT add_continuous_aggregate_policy('usage_daily',
  start_offset => INTERVAL '2 days',
  end_offset   => INTERVAL '1 day',
  schedule_interval => INTERVAL '1 day');

-- ============================================================
-- SECTION 17: SESSION HEALTH SNAPSHOTS — TimescaleDB Hypertable
-- Written by the monitoring service every 60 seconds per session.
-- Feeds the operator dashboard. Retained 30 days.
-- ============================================================

CREATE TABLE session_health_snapshots (
  session_id           UUID NOT NULL REFERENCES whatsapp_sessions(id),
  status               TEXT NOT NULL,
  risk_score           DECIMAL(4,3) NOT NULL,
  is_connected         BOOLEAN NOT NULL,
  messages_sent_1h     INTEGER NOT NULL DEFAULT 0,
  messages_received_1h INTEGER NOT NULL DEFAULT 0,
  outbound_queue_depth INTEGER NOT NULL DEFAULT 0,
  snapshot_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (session_id, snapshot_at)
);

SELECT create_hypertable('session_health_snapshots', 'snapshot_at');

SELECT add_retention_policy('session_health_snapshots', INTERVAL '30 days');

-- ============================================================
-- SECTION 18: ALERT HISTORY
-- Operator-only. Accessed via era_admin role (BYPASSRLS).
-- No RLS needed — never exposed through client-facing API.
-- ============================================================

CREATE TABLE alert_history (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_type TEXT NOT NULL,
  severity   TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),

  -- NULL = system-wide alert
  client_id  UUID REFERENCES clients(id),
  session_id UUID REFERENCES whatsapp_sessions(id),

  message      TEXT NOT NULL,
  metadata     JSONB,

  wa_delivered  BOOLEAN NOT NULL DEFAULT FALSE,
  wa_message_id TEXT,

  resolved_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_alerts_unresolved ON alert_history (created_at DESC) WHERE resolved_at IS NULL;
CREATE INDEX idx_alerts_client     ON alert_history (client_id, created_at DESC)
  WHERE client_id IS NOT NULL;

-- ============================================================
-- SECTION 19: ROW-LEVEL SECURITY
-- All client-scoped tables enforce isolation via RLS.
--
-- Client queries: withClient(clientId, tx) sets
--   SET LOCAL app.current_client_id = '<uuid>'
-- inside a transaction so current_client_id() returns the UUID.
--
-- Admin queries: adminDb pool sets
--   app.current_client_id = '00000000-0000-0000-0000-000000000001'
-- (the ADMIN_SENTINEL) at connection startup. is_admin_context()
-- detects this and the USING clause allows all rows through.
-- No BYPASSRLS or superuser privilege required.
-- ============================================================

ALTER TABLE clients                        ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoints              ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries             ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication_profiles        ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication_profile_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_profiles                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_sessions              ENABLE ROW LEVEL SECURITY;
ALTER TABLE warmup_profiles                ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_events                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_calls                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_events                   ENABLE ROW LEVEL SECURITY;

-- Returns the current client UUID from the session variable.
-- Returns NULL when the variable is not set.
CREATE OR REPLACE FUNCTION current_client_id()
RETURNS UUID LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_client_id', TRUE), '')::UUID
$$;

-- Returns TRUE when the connection is the admin pool (sentinel UUID is set).
-- The sentinel '00000000-0000-0000-0000-000000000001' is set at connection
-- startup by the adminDb postgres.js pool — no BYPASSRLS required.
CREATE OR REPLACE FUNCTION is_admin_context()
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT current_setting('app.current_client_id', TRUE) = '00000000-0000-0000-0000-000000000001'
$$;

CREATE POLICY client_isolation ON clients
  USING (id = current_client_id() OR is_admin_context());

CREATE POLICY client_isolation ON api_keys
  USING (client_id = current_client_id() OR is_admin_context());

CREATE POLICY client_isolation ON webhook_endpoints
  USING (client_id = current_client_id() OR is_admin_context());

CREATE POLICY client_isolation ON webhook_deliveries
  USING (client_id = current_client_id() OR is_admin_context());

CREATE POLICY client_isolation ON communication_profiles
  USING (client_id = current_client_id() OR is_admin_context());

CREATE POLICY client_isolation ON communication_profile_versions
  USING (client_id = current_client_id() OR is_admin_context());

-- NULL client_id = default ERA voice, readable by all authenticated clients
CREATE POLICY client_isolation ON voice_profiles
  USING (client_id = current_client_id() OR client_id IS NULL OR is_admin_context());

CREATE POLICY client_isolation ON whatsapp_sessions
  USING (client_id = current_client_id() OR is_admin_context());

CREATE POLICY client_isolation ON warmup_profiles
  USING (client_id = current_client_id() OR is_admin_context());

CREATE POLICY client_isolation ON contacts
  USING (client_id = current_client_id() OR is_admin_context());

CREATE POLICY client_isolation ON conversations
  USING (client_id = current_client_id() OR is_admin_context());

CREATE POLICY client_isolation ON messages
  USING (client_id = current_client_id() OR is_admin_context());

CREATE POLICY client_isolation ON message_events
  USING (client_id = current_client_id() OR is_admin_context());

CREATE POLICY client_isolation ON voice_calls
  USING (client_id = current_client_id() OR is_admin_context());

CREATE POLICY client_isolation ON usage_events
  USING (client_id = current_client_id() OR is_admin_context());

-- ============================================================
-- GRANT PERMISSIONS
-- Skipped gracefully on managed databases where the roles do not exist.
-- ============================================================

DO $$ BEGIN
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO era_app;
  GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO era_app;
EXCEPTION WHEN undefined_object THEN
  RAISE NOTICE 'Role era_app not found — skipping grants (managed DB)';
         WHEN insufficient_privilege THEN
  RAISE NOTICE 'Cannot grant to era_app — skipping (managed DB)';
END $$;

DO $$ BEGIN
  GRANT SELECT ON ALL TABLES IN SCHEMA public TO era_readonly;
EXCEPTION WHEN undefined_object THEN
  RAISE NOTICE 'Role era_readonly not found — skipping grants (managed DB)';
         WHEN insufficient_privilege THEN
  RAISE NOTICE 'Cannot grant to era_readonly — skipping (managed DB)';
END $$;

DO $$ BEGIN
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO era_admin;
  GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO era_admin;
EXCEPTION WHEN undefined_object THEN
  RAISE NOTICE 'Role era_admin not found — skipping grants (managed DB)';
         WHEN insufficient_privilege THEN
  RAISE NOTICE 'Cannot grant to era_admin — skipping (managed DB)';
END $$;
