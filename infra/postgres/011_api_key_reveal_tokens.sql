ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS api_key_reveal_tokens (
  token       TEXT PRIMARY KEY,
  api_key_id  UUID        NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  key_value   TEXT        NOT NULL,  -- plaintext key, deleted after first reveal
  label       TEXT        NOT NULL,
  client_name TEXT        NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reveal_tokens_api_key ON api_key_reveal_tokens(api_key_id);
