-- Spec 18 — Scheduling: reminders + recurring workflows
-- Phase 2 schema additions. Phase 1 (reminder firer) needs no schema change
-- because reminders live in agent_facts.valor JSONB.

-- chain_id links consecutive cycles of the same logical recurring workflow.
-- Generated at first start_workflow call and copied to each rescheduled row.
-- Lets cancel_workflow stop an entire series with one call.
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS chain_id UUID;

CREATE INDEX IF NOT EXISTS idx_workflows_chain
  ON workflows (chain_id)
  WHERE chain_id IS NOT NULL;

-- Engine scan hot path: pending/in-progress/waiting-third-party workflows
-- whose proxima_acao_em has passed.
CREATE INDEX IF NOT EXISTS idx_workflows_due
  ON workflows (proxima_acao_em)
  WHERE status IN ('pendente', 'em_andamento', 'aguardando_terceiro');

-- Reminder firer scan path: agent_facts rows with the reminder.* key
-- whose JSON valor.quando has passed. A GIN index on valor speeds up
-- the JSON predicate; partial index keeps it tiny.
CREATE INDEX IF NOT EXISTS idx_agent_facts_reminder_due
  ON agent_facts
  USING gin ((valor) jsonb_path_ops)
  WHERE chave LIKE 'reminder.%';
