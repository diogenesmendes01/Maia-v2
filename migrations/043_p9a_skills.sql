-- P9a: skills — Skill Contracts versionados (Source of Truth)
-- Master spec v3.1.1 §2.4 + §2.5 (runtime_hints).
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE TABLE skills (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           TEXT NOT NULL,                        -- FK to tenants.id (TEXT slug, see migration 007)
  agent_id            TEXT,                                 -- NULL = tenant-wide skill

  -- Identificação
  skill_descriptor    TEXT NOT NULL,                        -- ex.: 'detect_legal_risk', 'collect_missing_cpf'
  category            TEXT NOT NULL CHECK (category IN (
                        'classify', 'extract', 'compose',
                        'decide', 'tool_mediated',
                        'diagnose', 'plan', 'evaluator'
                      )),
  execution_mode      TEXT NOT NULL CHECK (execution_mode IN (
                        'prompt_only', 'procedure_adapter', 'tool_mediated', 'evaluator'
                      )),

  -- Contrato semântico
  goal                TEXT NOT NULL,                        -- objetivo em uma frase
  when_to_use         TEXT NOT NULL,                        -- condição de aplicabilidade
  procedure           JSONB NOT NULL DEFAULT '{}'::jsonb,   -- system prompt / steps / template
  constraints         JSONB NOT NULL DEFAULT '[]'::jsonb,   -- array de restrições declaradas

  -- Contratos I/O
  input_schema        JSONB NOT NULL,                       -- JSONSchema do input esperado
  output_schema       JSONB NOT NULL,                       -- JSONSchema do output garantido

  -- Recursos
  allowed_tools       TEXT[] NOT NULL DEFAULT '{}',         -- só relevante para tool_mediated
  policy_descriptors  TEXT[] NOT NULL DEFAULT '{}',         -- resolvidos via PolicyDescriptorResolver

  -- Qualidade
  success_criteria    JSONB NOT NULL DEFAULT '[]'::jsonb,   -- tipados (machine_check/llm_judge/etc.)
  failure_modes       JSONB NOT NULL DEFAULT '[]'::jsonb,   -- modos de falha conhecidos

  -- Orçamento runtime (master §2.5 CORREÇÃO #14)
  runtime_hints       JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Versionamento + lifecycle
  status              TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN (
                        'proposed', 'active', 'deprecated', 'rolled_back'
                      )),
  version             INTEGER NOT NULL,
  proposed_by         TEXT NOT NULL,                        -- 'founder' | 'agent' | 'human:<id>'
  proposed_reason     TEXT,
  approved_by         TEXT,
  approved_at         TIMESTAMPTZ,
  activated_at        TIMESTAMPTZ,
  deprecated_at       TIMESTAMPTZ,
  rolled_back_at      TIMESTAMPTZ,
  rollback_reason     TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index 1: lookup rápido por descriptor active (hot path)
CREATE INDEX idx_skills_tenant_active
  ON skills(tenant_id, status, skill_descriptor)
  WHERE status = 'active';

-- Index 2: listagem por categoria (slice builder / Admin UI)
CREATE INDEX idx_skills_tenant_category_active
  ON skills(tenant_id, category, status)
  WHERE status = 'active';

-- Index 3: version monotônica obrigatória (não pode haver v2 antes de v1)
CREATE UNIQUE INDEX idx_skills_version_uq
  ON skills(tenant_id, COALESCE(agent_id, 'tenant_wide'), skill_descriptor, version);

-- Index 4: "ONE ACTIVE" — partial unique, invariante crítico
CREATE UNIQUE INDEX idx_skills_one_active_uq
  ON skills(tenant_id, COALESCE(agent_id, 'tenant_wide'), skill_descriptor)
  WHERE status = 'active';

-- Index 5: proposals pendentes (Admin UI Tela 1 Proposal Inbox)
CREATE INDEX idx_skills_proposed
  ON skills(tenant_id, status, created_at DESC)
  WHERE status = 'proposed';

COMMENT ON TABLE skills IS
  'Skill Contracts versionados. DEFAULT status=proposed (nunca nasce active). Partial unique "one active" garante invariante. Master spec v3.1.1 §2.4.';
