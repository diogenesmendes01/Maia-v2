-- P8b: Estende DriftType para soul_drift (8º tipo, spec §4.1)
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.
ALTER TABLE agent_drift_alerts
  DROP CONSTRAINT IF EXISTS agent_drift_alerts_drift_type_check;

ALTER TABLE agent_drift_alerts
  ADD CONSTRAINT agent_drift_alerts_drift_type_check CHECK (
    drift_type IN (
      'tom', 'valores', 'confianca', 'vies', 'escopo',
      'linguagem', 'procedimento', 'papel_drift', 'soul_drift'
    )
  );
