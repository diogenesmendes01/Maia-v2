-- P3c: procedure_tests — cenários executáveis que validam um procedimento
-- antes de promover proposed → active. Cada test é uma sequência de
-- (user_message → expected_outcome) que o test-runner executa em sandbox.
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE TABLE procedure_tests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  definition_id UUID NOT NULL REFERENCES procedure_definitions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  scenario JSONB NOT NULL,
  expected_outcome TEXT NOT NULL CHECK (
    expected_outcome IN ('success', 'failure', 'partial', 'escalated')
  ),
  expected_step_path JSONB,
  last_run_at TIMESTAMPTZ,
  last_run_status TEXT CHECK (
    last_run_status IS NULL OR last_run_status IN ('pass', 'fail', 'error', 'skipped')
  ),
  last_run_details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX procedure_tests_definition_idx
  ON procedure_tests(definition_id, last_run_status);
CREATE INDEX procedure_tests_tenant_agent_idx
  ON procedure_tests(tenant_id, agent_id);
