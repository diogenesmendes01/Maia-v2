-- Down migration for 042 — removes papel_drift from CHECK while preserving
-- soul_drift (added by P8b migrations 038b). Run only after deleting any rows
-- with drift_type='papel_drift':
--   DELETE FROM agent_drift_alerts WHERE drift_type='papel_drift';
-- Otherwise the ADD CONSTRAINT will fail. The DROP IF EXISTS keeps the rollback
-- idempotent: re-running after a partial down still ends with the new CHECK.

ALTER TABLE agent_drift_alerts DROP CONSTRAINT IF EXISTS agent_drift_alerts_drift_type_check;

ALTER TABLE agent_drift_alerts ADD CONSTRAINT agent_drift_alerts_drift_type_check
  CHECK (drift_type IN (
    'tom',
    'valores',
    'confianca',
    'vies',
    'escopo',
    'linguagem',
    'procedimento',
    'soul_drift'
  ));
