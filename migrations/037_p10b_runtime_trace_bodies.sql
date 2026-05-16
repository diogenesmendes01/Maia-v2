-- P10b: runtime_trace_bodies — async body persistence. The envelope is
-- the source of truth for "did this decision happen"; the body is the
-- full ExecutionContextPacket + DecisionPacket payload, redacted.
-- ON CONFLICT DO NOTHING on (trace_id) makes the body writer idempotent
-- under at-least-once delivery.
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE TABLE IF NOT EXISTS runtime_trace_bodies (
  trace_id        UUID PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  packet          JSONB NOT NULL,
  packet_hmac     TEXT NOT NULL,
  hmac_key_version INTEGER NOT NULL,
  redaction_applied TEXT NOT NULL,
  bytes_redacted  INTEGER NOT NULL DEFAULT 0,
  encrypted       BOOLEAN NOT NULL DEFAULT false,
  s3_uri          TEXT,
  persisted_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Shape guard — packet must be an object, not array/scalar.
ALTER TABLE runtime_trace_bodies
  ADD CONSTRAINT runtime_trace_bodies_packet_shape
  CHECK (jsonb_typeof(packet) = 'object');

-- redaction_applied is the human label of what redaction policy ran.
ALTER TABLE runtime_trace_bodies
  ADD CONSTRAINT runtime_trace_bodies_redaction_chk
  CHECK (redaction_applied IN ('standard_v1', 'debug_encrypted_v1', 'minimal_v1'));

-- When encrypted=true, s3_uri MUST be present (debug mode contract).
ALTER TABLE runtime_trace_bodies
  ADD CONSTRAINT runtime_trace_bodies_encrypted_has_uri
  CHECK ((encrypted = false) OR (s3_uri IS NOT NULL));

CREATE INDEX IF NOT EXISTS runtime_trace_bodies_tenant_idx
  ON runtime_trace_bodies (tenant_id, agent_id, persisted_at DESC);
