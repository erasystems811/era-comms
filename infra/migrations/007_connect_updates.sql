-- ============================================================
-- MIGRATION 007: ERA CONNECT — RELEASE TABLE + REMOTE CONTROL
-- ============================================================

-- Single-row table tracking the latest official ERAConnect.exe release.
-- Operators update this via era-hub; agents poll /v1/connect/version to
-- detect and download newer versions automatically.
CREATE TABLE IF NOT EXISTS connect_release (
    id           INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    version      TEXT NOT NULL DEFAULT '0.0.0',
    download_url TEXT NOT NULL DEFAULT '',
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO connect_release (id, version, download_url)
VALUES (1, '0.0.0', '')
ON CONFLICT (id) DO NOTHING;

-- Remote restart flag: set to TRUE from era-hub, cleared when the agent
-- fetches config and executes the restart.
ALTER TABLE connect_configs
    ADD COLUMN IF NOT EXISTS pending_restart BOOLEAN NOT NULL DEFAULT FALSE;
