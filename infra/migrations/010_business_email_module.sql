-- Add email_campaigns module flag to module_config
ALTER TABLE module_config ADD COLUMN IF NOT EXISTS email_campaigns BOOLEAN NOT NULL DEFAULT FALSE;
