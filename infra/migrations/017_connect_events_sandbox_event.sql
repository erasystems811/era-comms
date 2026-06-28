-- Add sandbox_injected to the connect_events event_type CHECK constraint.
-- PostgreSQL requires dropping and recreating a CHECK constraint to modify it.

ALTER TABLE connect_events DROP CONSTRAINT IF EXISTS connect_events_event_type_check;

ALTER TABLE connect_events ADD CONSTRAINT connect_events_event_type_check
  CHECK (event_type IN (
    'heartbeat',
    'startup', 'shutdown',
    'patient_synced', 'care_plan_synced',
    'sync_error', 'auth_ok', 'auth_failed',
    'db_connected', 'db_error',
    'config_fetched', 'config_updated',
    'sandbox_injected'
  ));
