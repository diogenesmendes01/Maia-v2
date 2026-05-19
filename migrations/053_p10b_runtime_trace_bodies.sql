-- P10b: runtime_trace_bodies — async body persistence. The envelope is
-- the source of truth for "did this decision happen"; the body is the
-- full ExecutionContextPacket + DecisionPacket payload, redacted.
-- ON CONFLICT DO NOTHING on (trace_id) makes the body writer idempotent
-- under at-least-once delivery.
--
-- This migration ALSO creates `runtime_trace_body_outbox` — a durable
-- queue row that the request path writes BEFORE returning, so that a
-- process crash between envelope-write and body-write doesn't lose the
-- packet (Codex review #102 — issue 4). The body-writer worker claims
-- outbox rows via FOR UPDATE SKIP LOCKED, writes the body, and deletes
-- the outbox row in the same transaction.
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
  -- When encrypted=true and no S3 bucket is configured (test/dev), the
  -- ciphertext is stored inline here so debug bodies stay recoverable.
  -- NULL otherwise.
  ciphertext_inline TEXT,
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

-- When encrypted=true, EITHER s3_uri OR ciphertext_inline MUST be present.
-- This is the durability contract for debug-mode bodies (Codex #102 issue 3).
ALTER TABLE runtime_trace_bodies
  ADD CONSTRAINT runtime_trace_bodies_encrypted_has_storage
  CHECK ((encrypted = false) OR (s3_uri IS NOT NULL) OR (ciphertext_inline IS NOT NULL));

CREATE INDEX IF NOT EXISTS runtime_trace_bodies_tenant_idx
  ON runtime_trace_bodies (tenant_id, agent_id, persisted_at DESC);

-- =====================================================================
-- runtime_trace_body_outbox — durable queue (Codex #102 issue 4).
--
-- Written by the request path BEFORE returning success. Drained by the
-- trace-body-writer worker via FOR UPDATE SKIP LOCKED, which writes the
-- final body row and deletes the outbox row in the same transaction.
-- Survives process crashes and replica swaps; the in-process queue
-- (trace-body-writer.ts) is now a best-effort accelerator only.
-- =====================================================================
CREATE TABLE IF NOT EXISTS runtime_trace_body_outbox (
  trace_id        UUID PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  payload         JSONB NOT NULL,
  redaction_class TEXT NOT NULL,
  enqueued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  last_error      TEXT
);

ALTER TABLE runtime_trace_body_outbox
  ADD CONSTRAINT runtime_trace_body_outbox_redaction_chk
  CHECK (redaction_class IN ('standard', 'debug', 'minimal'));

ALTER TABLE runtime_trace_body_outbox
  ADD CONSTRAINT runtime_trace_body_outbox_payload_shape
  CHECK (jsonb_typeof(payload) = 'object');

-- Worker drains oldest first; partial index keeps the worker scan tight
-- when a poison row is parked at high attempts.
CREATE INDEX IF NOT EXISTS runtime_trace_body_outbox_drain_idx
  ON runtime_trace_body_outbox (enqueued_at)
  WHERE attempts < 10;
