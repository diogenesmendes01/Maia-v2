-- P3a — add `domain` to procedure_definitions to power WorkflowSelector
-- discrimination (DOMAIN_INTENT_MAP keys: onboarding/support/transfer/cancel).
-- NULL allowed for backfill; values are constrained by CHECK to the allowlist.
-- Idempotent.

ALTER TABLE procedure_definitions
  ADD COLUMN IF NOT EXISTS domain TEXT
  CHECK (domain IS NULL OR domain IN ('onboarding','support','transfer','cancel','unknown'));

CREATE INDEX IF NOT EXISTS idx_procedure_definitions_domain
  ON procedure_definitions(tenant_id, agent_id, domain)
  WHERE domain IS NOT NULL;

COMMENT ON COLUMN procedure_definitions.domain IS
  'Domain key consumed by WorkflowSelector. NULL = backfill pending; uses ''unknown'' fallback in code.';
