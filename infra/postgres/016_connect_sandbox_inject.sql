-- Sandbox inject: allows ERA Hub to queue a fake patient or treatment
-- for ERAConnect to insert into its local DB on the next config poll.
-- One-shot delivery — cleared as soon as ERAConnect acknowledges it.

ALTER TABLE connect_configs
  ADD COLUMN IF NOT EXISTS sandbox_inject JSONB DEFAULT NULL;
