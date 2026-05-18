-- P8d §6 / review #100 — Extend agent_drift_alerts.drift_type CHECK to include papel_drift.
--
-- Migration 026 originally defined the CHECK with 7 values (tom, valores, confianca,
-- vies, escopo, linguagem, procedimento). P8d adds papel_drift as the 9th detector
-- (8th in this branch — soul_drift from P8b joins via 038/039 when those merge).
-- Without this migration the CHECK rejects papel_drift inserts and decideAndApply
-- in src/cognition/drift/decision-engine.ts has already mutated profile state
-- (freeze/rollback) before the alert insert blows up — violating audit trail.
--
-- Migration numbers 036–039 are coordinated for P8e/P8c/P8b reviews on PRs
-- #93/#94/#95; this branch owns 040.
--
-- Idempotent via DROP CONSTRAINT IF EXISTS — re-running this migration after
-- partial failure leaves the table with the new CHECK and a single audit row.
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

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
    'papel_drift'
  ));
