-- P3b: procedure_executions — estado atual (derivado de events)
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE TABLE procedure_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  conversa_id UUID,
  definition_id UUID NOT NULL REFERENCES procedure_definitions(id),
  definition_version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (
    status IN ('in_progress', 'completed', 'aborted', 'escalated', 'abandoned')
  ),
  current_step_id TEXT,
  execution_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  completed_steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  outcome TEXT CHECK (outcome IN ('success', 'failure', 'partial', 'escalated', 'no_response')),
  notes TEXT
);

CREATE INDEX procedure_exec_tenant_agent_status_idx
  ON procedure_executions(tenant_id, agent_id, status, last_activity_at DESC);
CREATE INDEX procedure_exec_conversa_idx
  ON procedure_executions(conversa_id) WHERE conversa_id IS NOT NULL;
CREATE INDEX procedure_exec_in_progress_idx
  ON procedure_executions(tenant_id, agent_id, conversa_id, last_activity_at)
  WHERE status = 'in_progress';
