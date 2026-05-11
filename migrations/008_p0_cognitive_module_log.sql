-- P0: cria cognitive_module_log (ativa imediatamente — registra reflection.ts existente)
CREATE TABLE cognitive_module_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL DEFAULT 'default' REFERENCES tenants(id),
  agent_id TEXT NOT NULL DEFAULT 'default' REFERENCES agents(id),
  conversa_id UUID,
  turno_id UUID,
  module_name TEXT NOT NULL,
  module_version TEXT NOT NULL DEFAULT 'v1',
  prompt_version TEXT,
  triggered_by TEXT NOT NULL CHECK (triggered_by IN ('sync_required', 'sync_conditional', 'async_event')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  latency_ms INTEGER,
  model_used TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_estimate NUMERIC(10, 6),
  output_summary_hash TEXT,
  confidence NUMERIC(4, 3),
  fallback_triggered BOOLEAN NOT NULL DEFAULT false,
  fallback_reason TEXT,
  status TEXT NOT NULL CHECK (status IN ('success', 'timeout', 'error', 'skipped')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX cognitive_module_log_tenant_agent_idx
  ON cognitive_module_log(tenant_id, agent_id, created_at DESC);
CREATE INDEX cognitive_module_log_module_idx
  ON cognitive_module_log(module_name, created_at DESC);
CREATE INDEX cognitive_module_log_conversa_idx
  ON cognitive_module_log(conversa_id) WHERE conversa_id IS NOT NULL;
