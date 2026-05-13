-- P4 (PR #86 review): Enforce append-only/immutable-content invariant at the
-- database layer. The four identity-content columns (core_immutable,
-- operational_profile, episodic_temp, growth_backlog) MUST NOT be mutated
-- after the row is inserted. Identity evolution happens by appending a NEW
-- version row, not by editing an existing one. Status/audit metadata
-- (status, approved_*, activated_at, frozen_at, rolled_back_at,
-- rollback_reason) is allowed to change as part of the state machine.
--
-- The reviewer (Superpowers Critical #2) flagged this as "immutable core
-- writeable" — a direct production blocker for operational identity
-- governance. The repo layer currently only updates status metadata, but
-- the DB did not enforce the contract; this trigger makes it impossible to
-- silently rewrite identity content.
--
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE OR REPLACE FUNCTION agent_op_profile_content_immutable()
RETURNS trigger AS $$
BEGIN
  IF NEW.core_immutable      IS DISTINCT FROM OLD.core_immutable      THEN
    RAISE EXCEPTION 'agent_operational_profile_versions.core_immutable is append-only (insert a new version row instead of mutating)';
  END IF;
  IF NEW.operational_profile IS DISTINCT FROM OLD.operational_profile THEN
    RAISE EXCEPTION 'agent_operational_profile_versions.operational_profile is append-only (insert a new version row instead of mutating)';
  END IF;
  IF NEW.episodic_temp       IS DISTINCT FROM OLD.episodic_temp       THEN
    RAISE EXCEPTION 'agent_operational_profile_versions.episodic_temp is append-only (insert a new version row instead of mutating)';
  END IF;
  IF NEW.growth_backlog      IS DISTINCT FROM OLD.growth_backlog      THEN
    RAISE EXCEPTION 'agent_operational_profile_versions.growth_backlog is append-only (insert a new version row instead of mutating)';
  END IF;
  -- Also lock the version number and tenant/agent identity — these are
  -- the row's identity primary keys and changing them post-insert would
  -- silently break tenant isolation.
  IF NEW.version             IS DISTINCT FROM OLD.version             THEN
    RAISE EXCEPTION 'agent_operational_profile_versions.version is immutable after insert';
  END IF;
  IF NEW.tenant_id           IS DISTINCT FROM OLD.tenant_id           THEN
    RAISE EXCEPTION 'agent_operational_profile_versions.tenant_id is immutable after insert';
  END IF;
  IF NEW.agent_id            IS DISTINCT FROM OLD.agent_id            THEN
    RAISE EXCEPTION 'agent_operational_profile_versions.agent_id is immutable after insert';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_op_profile_content_immutable_trg
  BEFORE UPDATE ON agent_operational_profile_versions
  FOR EACH ROW
  EXECUTE FUNCTION agent_op_profile_content_immutable();
