-- Down migration for 007_scheduling.sql
DROP INDEX IF EXISTS idx_agent_facts_reminder_due;
DROP INDEX IF EXISTS idx_workflows_due;
DROP INDEX IF EXISTS idx_workflows_chain;
ALTER TABLE workflows DROP COLUMN IF EXISTS chain_id;
