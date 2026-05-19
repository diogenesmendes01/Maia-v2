-- Reverte 038b: restore CHECK original (7 tipos sem papel_drift/soul_drift).
ALTER TABLE agent_drift_alerts
  DROP CONSTRAINT IF EXISTS agent_drift_alerts_drift_type_check;

ALTER TABLE agent_drift_alerts
  ADD CONSTRAINT agent_drift_alerts_drift_type_check CHECK (
    drift_type IN (
      'tom', 'valores', 'confianca', 'vies', 'escopo',
      'linguagem', 'procedimento'
    )
  );
