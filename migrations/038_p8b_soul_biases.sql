-- P8b: soul_biases — append-only, versionado por (tenant, agent, scope, scope_value, principle).
-- Soul Bias modula comportamento; NUNCA bloqueia.
-- DEFAULT 'proposed' (invariante 5 — Source of Truth nunca nasce active por acidente).
-- Partial unique index "one active" garante 1 active por (tenant, agent, scope, scope_value, principle).
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE TABLE soul_biases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id  TEXT NOT NULL REFERENCES agents(id),

  -- Escopo de aplicabilidade.
  -- tenant         → vale para qualquer agent do tenant
  -- agent          → vale para 1 agent específico (scope_value = agent_id; redundante mas explícito)
  -- role           → vale quando o role atual = scope_value (P6)
  -- domain         → vale quando o domínio conversacional inferido = scope_value (P9 intent)
  scope TEXT NOT NULL CHECK (
    scope IN ('tenant', 'agent', 'role', 'domain')
  ),
  scope_value TEXT NOT NULL,

  -- Texto operacional curto identificador da bias (slug humano).
  principle TEXT NOT NULL CHECK (length(principle) BETWEEN 3 AND 80),

  -- Texto narrativo que entra no prompt como orientação.
  guidance TEXT NOT NULL CHECK (length(guidance) BETWEEN 10 AND 1000),

  -- Origem do bias.
  origin TEXT NOT NULL CHECK (
    origin IN (
      'founder_explicit',
      'human_approved',
      'tenant_culture_explicit',
      'learned_strong_evidence'
    )
  ),

  -- Strength ∈ [0,1].
  strength NUMERIC(4,3) NOT NULL CHECK (strength >= 0 AND strength <= 1),

  -- Condições estruturadas para ativar a bias.
  activation_context JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Status de versionamento. Default 'proposed' (invariante 5).
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (
    status IN ('proposed', 'active', 'deprecated', 'rolled_back')
  ),

  -- Lineage append-only.
  version INTEGER NOT NULL,
  previous_version_id UUID REFERENCES soul_biases(id),

  -- Audit
  proposed_by  TEXT NOT NULL,
  proposed_reason TEXT,
  approved_by  TEXT,
  approved_at  TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  frozen_at    TIMESTAMPTZ,
  deprecated_at TIMESTAMPTZ,
  deprecated_reason TEXT,
  rolled_back_at TIMESTAMPTZ,
  rollback_reason TEXT,

  -- Liga a proposal de origem (quando origin in human_approved/learned).
  proposal_id UUID REFERENCES capability_proposals(id),

  -- Liga a drift alert que gerou (quando origin = learned_strong_evidence).
  source_drift_alert_id UUID REFERENCES agent_drift_alerts(id),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Versionamento append-only por chave compostas.
  UNIQUE (tenant_id, agent_id, scope, scope_value, principle, version)
);

-- Partial unique "one active": garante 1 row ACTIVE por (tenant, agent, scope, scope_value, principle).
CREATE UNIQUE INDEX soul_biases_one_active_idx
  ON soul_biases (tenant_id, agent_id, scope, scope_value, principle)
  WHERE status = 'active';

-- Índices de leitura quente (slice builder filtra por tenant + agent + status='active').
CREATE INDEX soul_biases_active_lookup_idx
  ON soul_biases (tenant_id, agent_id, status, scope, scope_value)
  WHERE status = 'active';

CREATE INDEX soul_biases_proposed_inbox_idx
  ON soul_biases (tenant_id, agent_id, status, created_at DESC)
  WHERE status = 'proposed';

-- Pra auditoria por proposta de origem
CREATE INDEX soul_biases_proposal_idx
  ON soul_biases (proposal_id) WHERE proposal_id IS NOT NULL;

-- Pra rastrear bias derivada de drift
CREATE INDEX soul_biases_drift_source_idx
  ON soul_biases (source_drift_alert_id) WHERE source_drift_alert_id IS NOT NULL;
