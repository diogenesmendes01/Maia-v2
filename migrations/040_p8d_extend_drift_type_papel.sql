-- P8d §6 / review #100 round-2 — Extend agent_drift_alerts.drift_type CHECK to
-- include papel_drift while preserving the full expected enum superset.
--
-- Migration 026 originally defined the CHECK with 7 values (tom, valores, confianca,
-- vies, escopo, linguagem, procedimento). P8d adds papel_drift as the 9th detector.
-- P8b adds soul_drift (8th, via migrations 038/039 on a parallel branch).
--
-- Merge-safety rationale: this migration drops and recreates the CHECK with the
-- FULL union of all known drift_type values (P4 original 7 + soul_drift from P8b
-- + papel_drift from P8d). Regardless of which branch merges first, the final
-- merged state will contain every value. If soul_drift rows already exist (P8b
-- merged first) this CHECK keeps them valid; if they don't exist yet (P8d merges
-- first) the value is pre-registered harmlessly — future P8b rows will pass.
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
    'soul_drift',
    'papel_drift'
  ));
