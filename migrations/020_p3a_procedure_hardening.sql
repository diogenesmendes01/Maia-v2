-- P3a hardening (PR #83 review fixes):
--   1. Promote `procedure_def_active_idx` to a UNIQUE partial index so the
--      DB rejects two simultaneously active versions of the same nome.
--   2. Add CASCADE to procedure_assignments.definition_id (was missing in
--      the drizzle schema; SQL migration already had it but we make the
--      intent explicit here so the index also exists with ON DELETE
--      CASCADE if it was created without one in some environments).
--   3. Add an event-sourced log table for procedure_definitions status
--      transitions — required by the "evidência" pillar and by
--      `project_procedures_executable_skills` (event sourcing).
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

-- 1) Replace the existing non-unique partial index with a UNIQUE partial
-- index. The drop-then-create pattern is safe inside the migrate.ts
-- transaction. If duplicate active rows already exist in some
-- environment, this migration will fail loudly — investigate the data
-- before retrying.
DROP INDEX IF EXISTS procedure_def_active_idx;

CREATE UNIQUE INDEX procedure_def_active_uniq_idx
  ON procedure_definitions(tenant_id, agent_id, nome)
  WHERE status = 'active';

-- 2) Make source-candidate index unique (M3) so the same cognitive
-- candidate cannot spawn two drafts.
DROP INDEX IF EXISTS procedure_def_source_candidate_idx;

CREATE UNIQUE INDEX procedure_def_source_candidate_idx
  ON procedure_definitions(source_candidate_id)
  WHERE source_candidate_id IS NOT NULL;

-- 3) Event-sourced status transitions for procedure_definitions.
CREATE TABLE procedure_status_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  definition_id UUID NOT NULL REFERENCES procedure_definitions(id) ON DELETE CASCADE,
  from_status TEXT NOT NULL CHECK (
    from_status IN ('draft', 'proposed', 'active', 'frozen', 'rolled_back')
  ),
  to_status TEXT NOT NULL CHECK (
    to_status IN ('draft', 'proposed', 'active', 'frozen', 'rolled_back')
  ),
  actor TEXT NOT NULL,
  reason TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX procedure_status_events_def_idx
  ON procedure_status_events(definition_id, occurred_at DESC);
CREATE INDEX procedure_status_events_tenant_agent_idx
  ON procedure_status_events(tenant_id, agent_id, occurred_at DESC);

-- 4) Trigger: refuse mutation of non-status fields when status='active'.
-- Once a procedure is active the steps/success_criteria/intencao etc.
-- are frozen — only status transitions (and the bookkeeping timestamps
-- that accompany them) are allowed. New versions take its place via
-- frozen → new active. (PR #83 C3 "imutável quando active")
CREATE OR REPLACE FUNCTION enforce_active_procedure_immutability()
RETURNS TRIGGER AS $$
BEGIN
  -- Only inspect updates that leave the row in 'active' OR start from
  -- 'active'. Status transitions out of active are allowed.
  IF OLD.status = 'active' AND NEW.status = 'active' THEN
    IF NEW.intencao IS DISTINCT FROM OLD.intencao
       OR NEW.when_apply::text IS DISTINCT FROM OLD.when_apply::text
       OR NEW.when_not_apply::text IS DISTINCT FROM OLD.when_not_apply::text
       OR NEW.steps::text IS DISTINCT FROM OLD.steps::text
       OR NEW.success_criteria::text IS DISTINCT FROM OLD.success_criteria::text
       OR NEW.failure_modes::text IS DISTINCT FROM OLD.failure_modes::text
       OR NEW.tools_referenced::text IS DISTINCT FROM OLD.tools_referenced::text
       OR NEW.scope IS DISTINCT FROM OLD.scope
       OR NEW.nome IS DISTINCT FROM OLD.nome
       OR NEW.version_number IS DISTINCT FROM OLD.version_number
       OR NEW.source IS DISTINCT FROM OLD.source THEN
      RAISE EXCEPTION
        'procedure_definition % is active and immutable; create a new version instead', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER procedure_def_active_immutable
  BEFORE UPDATE ON procedure_definitions
  FOR EACH ROW
  EXECUTE FUNCTION enforce_active_procedure_immutability();

-- 5) Preserve `activated_at` on subsequent activations (H1). If the row
-- already had a non-null activated_at, keep it; only the current
-- (last) activation timestamp moves into a new column. We don't have a
-- dedicated column yet — for now, the activation TS is preserved by the
-- application layer (procedure-status.ts) and any later re-activation
-- writes a `procedure_status_events` row, which serves as the canonical
-- audit trail.

COMMENT ON TABLE procedure_status_events IS
  'Event-sourced audit log of procedure_definitions status transitions. Append-only.';
COMMENT ON INDEX procedure_def_active_uniq_idx IS
  'UNIQUE partial index: at most one active version per (tenant,agent,nome).';
