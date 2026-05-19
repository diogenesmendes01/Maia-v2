-- P10b: runtime_trace_envelopes — sync envelope written BEFORE any side
-- effect with side_effect_level >= medium (CRITICAL invariant 12). Must
-- stay narrow (<20ms p99 audit gate): only the structural decision —
-- policy_id, decision, side_effect_level, redaction_class, hmac. Body
-- (full packet) goes to runtime_trace_bodies asynchronously.
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE TABLE IF NOT EXISTS runtime_trace_envelopes (
  trace_id        UUID PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  conversa_id     UUID,
  turno_id        UUID,
  policy_id       UUID,
  decision        TEXT NOT NULL,
  side_effect_level TEXT NOT NULL,
  redaction_class TEXT NOT NULL DEFAULT 'standard',
  envelope_hmac   TEXT NOT NULL,
  hmac_key_version INTEGER NOT NULL,
  body_status     TEXT NOT NULL DEFAULT 'pending',
  body_persisted_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- decision values are open per phase but should be one of these for now.
ALTER TABLE runtime_trace_envelopes
  ADD CONSTRAINT runtime_trace_env_decision_chk
  CHECK (decision IN ('allow', 'deny', 'soft_block', 'escalate', 'observe'));

-- side_effect_level taxonomy (P10b spec): none < low < medium < high < critical.
-- envelope MUST be written for medium/high/critical BEFORE the side effect runs.
ALTER TABLE runtime_trace_envelopes
  ADD CONSTRAINT runtime_trace_env_side_effect_chk
  CHECK (side_effect_level IN ('none', 'low', 'medium', 'high', 'critical'));

-- redaction_class controls how the body is redacted before persist:
--   standard  → redactPacket() strips PII, preserves structure
--   debug     → AES-GCM encrypted snapshot to S3 with 24h TTL, MFA-gated
--   minimal   → envelope-only, body never persisted
ALTER TABLE runtime_trace_envelopes
  ADD CONSTRAINT runtime_trace_env_redaction_chk
  CHECK (redaction_class IN ('standard', 'debug', 'minimal'));

-- body_status: pending → persisted | orphaned (recoverer alerta >5min)
ALTER TABLE runtime_trace_envelopes
  ADD CONSTRAINT runtime_trace_env_body_status_chk
  CHECK (body_status IN ('pending', 'persisted', 'orphaned'));

-- Hot path: looking up by tenant + recent (Admin UI trace browser).
CREATE INDEX IF NOT EXISTS runtime_trace_env_tenant_created_idx
  ON runtime_trace_envelopes (tenant_id, agent_id, created_at DESC);

-- Body recoverer cron picks up old pending envelopes.
CREATE INDEX IF NOT EXISTS runtime_trace_env_body_pending_idx
  ON runtime_trace_envelopes (created_at)
  WHERE body_status = 'pending';

-- conversa-level browse.
CREATE INDEX IF NOT EXISTS runtime_trace_env_conversa_idx
  ON runtime_trace_envelopes (conversa_id, created_at DESC)
  WHERE conversa_id IS NOT NULL;
