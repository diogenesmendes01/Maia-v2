-- P3b: procedure_execution_events — event sourcing log (verdade do runtime)
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE TABLE procedure_execution_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  execution_id UUID NOT NULL REFERENCES procedure_executions(id) ON DELETE CASCADE,
  step_id TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'execution_started', 'step_started', 'input_received', 'decision_made',
    'tool_called', 'tool_result', 'criterion_checked', 'step_completed',
    'step_failed', 'branch_taken', 'state_updated', 'execution_completed',
    'execution_aborted', 'execution_escalated', 'execution_abandoned'
  )),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence NUMERIC(4,3),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX procedure_events_execution_idx
  ON procedure_execution_events(execution_id, created_at);
CREATE INDEX procedure_events_type_idx
  ON procedure_execution_events(event_type, created_at DESC);
