-- 088 — Work loop v1 (issue #469, spec docs/superpowers/specs/2026-06-10-agent-work-loop-design.md)
--
-- agent_objectives: responsabilidades declarativas por agente, owner-aprovadas.
-- objective_tasks: unidades de trabalho idempotentes (natural_key) geradas por
-- perceptores em código (ou manualmente, kind 'manual' na v1) e executadas
-- pelo worker objective_execute. Estado 'waiting_human' é a fila de exceções.

CREATE TABLE agent_objectives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  agent_id text NOT NULL,
  kind text NOT NULL,                 -- registry tipado em src/objectives/kinds.ts
  title text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'archived')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agent_objectives_tenant_agent_idx
  ON agent_objectives (tenant_id, agent_id, status);

CREATE TABLE objective_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  objective_id uuid NOT NULL REFERENCES agent_objectives(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  agent_id text NOT NULL,
  natural_key text NOT NULL,
  title text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'waiting_human', 'done', 'failed', 'cancelled')),
  procedure_execution_id uuid NULL,
  pending_question_id uuid NULL,
  outcome jsonb NULL,
  error_detail text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL
);

CREATE INDEX objective_tasks_objective_idx
  ON objective_tasks (objective_id, created_at DESC);
CREATE INDEX objective_tasks_tenant_agent_status_idx
  ON objective_tasks (tenant_id, agent_id, status);
-- Worker poll (oldest pending first).
CREATE INDEX objective_tasks_queue_idx
  ON objective_tasks (created_at)
  WHERE status = 'pending';
-- Idempotência do perceptor: uma tarefa VIVA por (objetivo, chave natural).
CREATE UNIQUE INDEX objective_tasks_live_natural_key_uq
  ON objective_tasks (objective_id, natural_key)
  WHERE status NOT IN ('done', 'failed', 'cancelled');
