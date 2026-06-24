-- 008_operator_settings.sql
-- Stores global operator-level configuration (AI model settings, rate limits).
-- Single-row table with a fixed primary key 'global'.

CREATE TABLE IF NOT EXISTS operator_settings (
  id                         text          PRIMARY KEY DEFAULT 'global',
  ai_temperature             numeric(3,1)  NOT NULL DEFAULT 0.7,
  ai_system_prompt           text          NOT NULL DEFAULT 'You are a helpful business assistant. Be concise, friendly, and professional. Only answer questions related to the business you are serving. If you don''t know something, say so clearly and offer to connect the customer with a human representative.',
  ai_max_requests_per_hour   int           NOT NULL DEFAULT 100,
  ai_max_tokens_per_response int           NOT NULL DEFAULT 1000,
  ai_daily_spend_cutoff      numeric(12,2) NOT NULL DEFAULT 5000.00,
  updated_at                 timestamptz   NOT NULL DEFAULT NOW()
);

INSERT INTO operator_settings (id) VALUES ('global')
ON CONFLICT (id) DO NOTHING;
