-- P4: agent_drift_alerts — audit das execuções do drift detector
-- Cada alert = 1 tipo de drift detectado + severidade + decisão + audit
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE TABLE agent_drift_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  profile_version_id UUID REFERENCES agent_operational_profile_versions(id),
  drift_type TEXT NOT NULL CHECK (
    drift_type IN ('tom', 'valores', 'confianca', 'vies', 'escopo', 'linguagem', 'procedimento')
  ),
  severity TEXT NOT NULL CHECK (
    severity IN ('baixo', 'medio', 'alto', 'critico')
  ),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  detected_by TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (
    decision IN ('auto_approved', 'queued_human', 'frozen', 'rollback')
  ),
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by TEXT NOT NULL,
  resolution_note TEXT,
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX agent_drift_tenant_agent_severity_idx
  ON agent_drift_alerts(tenant_id, agent_id, severity, created_at DESC);
CREATE INDEX agent_drift_profile_version_idx
  ON agent_drift_alerts(profile_version_id);
CREATE INDEX agent_drift_unresolved_idx
  ON agent_drift_alerts(tenant_id, agent_id, created_at DESC)
  WHERE resolved_at IS NULL;
