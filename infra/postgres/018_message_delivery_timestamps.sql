-- Track when messages were actually delivered to / read by the recipient.
-- WhatsApp sends delivery receipts asynchronously via Baileys messages.update events.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS read_at      TIMESTAMPTZ;
