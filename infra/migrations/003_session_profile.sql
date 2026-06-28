-- WhatsApp Business profile fields per session
ALTER TABLE whatsapp_sessions
  ADD COLUMN IF NOT EXISTS profile_name        TEXT,
  ADD COLUMN IF NOT EXISTS profile_description TEXT,
  ADD COLUMN IF NOT EXISTS profile_picture_url TEXT;
