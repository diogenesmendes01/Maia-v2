-- P8e: policy_rules — Source of Truth versionada para regras de governança.
-- Schema do master spec v3.1.1 §2.1. Versionamento append-only:
--   proposed → active|rolled_back  (terminal: rolled_back)
--   active   → deprecated|rolled_back
--   deprecated — terminal (uma nova versão active substitui)
-- DEFAULT 'proposed' garante invariante #5 do master §15: "Source of Truth
-- versionada nunca nasce active por acidente". hard_limit nunca pode auto-ativar
-- (Non-goal master §0.2 + matriz de approval classes §9: dual approval owner+compliance).
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE TABLE policy_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  agent_id        TEXT NULL REFERENCES agents(id),  -- NULL = tenant-wide
  rule_kind       TEXT NOT NULL CHECK (rule_kind IN (
    'hard_limit', 'soft_guidance', 'dual_approval', 'lockdown_trigger'
  )),
  rule_descriptor TEXT NOT NULL,
  rule_body       JSONB NOT NULL,                   -- DSL/AST opaco em P8e; P9d avalia
  scope           JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_of_truth TEXT NOT NULL CHECK (source_of_truth IN (
    'founder_explicit', 'legal_compliance', 'tenant_culture', 'incident_postmortem'
  )),
  status          TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN (
    'proposed', 'active', 'deprecated', 'rolled_back'
  )),
  version         INTEGER NOT NULL,
  proposed_by     TEXT NOT NULL,
  proposed_reason TEXT,
  approved_by     TEXT,
  approved_at     TIMESTAMPTZ,
  activated_at    TIMESTAMPTZ,
  deprecated_at   TIMESTAMPTZ,
  rolled_back_at  TIMESTAMPTZ,
  rollback_reason TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Sanity: rule_body é objeto (não array, não null, não scalar)
  CONSTRAINT policy_rules_body_is_object CHECK (jsonb_typeof(rule_body) = 'object'),
  CONSTRAINT policy_rules_scope_is_object CHECK (jsonb_typeof(scope) = 'object'),

  -- Sanity: hard_limit + dual_approval nunca podem nascer com approved_at preenchido
  -- (defesa em profundidade contra script de seed que esquece DEFAULT)
  CONSTRAINT policy_rules_proposed_unapproved CHECK (
    status != 'proposed' OR (approved_at IS NULL AND activated_at IS NULL)
  )
);

-- Hot-path lookup pelo resolver (status='active' filtra via WHERE)
CREATE INDEX idx_policy_rules_tenant_active
  ON policy_rules (tenant_id, status, rule_kind)
  WHERE status = 'active';

-- Hot-path lookup por descriptor (resolver bate aqui)
CREATE INDEX idx_policy_rules_descriptor_active
  ON policy_rules (tenant_id, rule_descriptor)
  WHERE status = 'active';

-- Append-only versioning: (tenant, agent_or_tenant_wide, descriptor, version) único
CREATE UNIQUE INDEX idx_policy_rules_version_uq
  ON policy_rules (
    tenant_id,
    COALESCE(agent_id::text, 'tenant_wide'),
    rule_descriptor,
    version
  );

-- Invariante #6 do master §15: "Partial unique index 'one active' em toda Source of
-- Truth versionada". Garante no DB que NUNCA exista 2 active simultâneos para o
-- mesmo (tenant, agent_or_wide, descriptor).
CREATE UNIQUE INDEX idx_policy_rules_one_active_uq
  ON policy_rules (
    tenant_id,
    COALESCE(agent_id::text, 'tenant_wide'),
    rule_descriptor
  )
  WHERE status = 'active';
