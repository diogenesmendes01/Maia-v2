-- Down migration for 040 — restores the original P4 CHECK (7 values, no papel_drift).
-- Run only after deleting any rows with drift_type='papel_drift':
--   DELETE FROM agent_drift_alerts WHERE drift_type='papel_drift';
-- Otherwise the ADD CONSTRAINT will fail. The DROP IF EXISTS keeps the rollback
-- idempotent: re-running after a partial down still ends with the original CHECK.

ALTER TABLE agent_drift_alerts DROP CONSTRAINT IF EXISTS agent_drift_alerts_drift_type_check;

ALTER TABLE agent_drift_alerts ADD CONSTRAINT agent_drift_alerts_drift_type_check
  CHECK (drift_type IN (
    'tom',
    'valores',
    'confianca',
    'vies',
    'escopo',
    'linguagem',
    'procedimento'
  ));
