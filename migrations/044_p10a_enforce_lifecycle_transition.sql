-- 044_p10a_enforce_lifecycle_transition.sql
-- P10a — DB-level enforcement of ALLOWED_TRANSITIONS via trigger.
--
-- This migration adds a PL/pgSQL trigger to the 4 user-layer knowledge
-- tables (memory_entry, agent_facts, learned_rules, behavioral_hint)
-- that mirrors the runtime ALLOWED_TRANSITIONS table in
-- `src/control-plane/knowledge-state-machine/transitions.ts`.
--
-- This is defense-in-depth: KnowledgeStateMachine.transition() already
-- validates against the same table at the TypeScript level. The trigger
-- here catches:
--   (1) Direct SQL updates that bypass the state-machine API
--   (2) Race conditions between two concurrent transitions (the trigger
--       sees OLD.lifecycle_status from the row's current persisted state,
--       not the stale read the application started from).
--
-- Per Codex review #104: lifecycle state was not actually enforced at
-- the DB level. Without this trigger, a buggy migration / ad-hoc psql
-- session / parallel worker could resurrect a revoked row by writing
-- lifecycle_status='active' directly. Now any attempt produces:
--   ERROR: illegal knowledge lifecycle transition: revoked -> active
--
-- Forward-only and idempotent (CREATE OR REPLACE for function, DROP +
-- CREATE TRIGGER for triggers so re-running picks up new ALLOWED rules).
--
-- ARCHITECTURE LOCK (master §0.1): The hard-coded transitions list
-- here MUST mirror ALLOWED_TRANSITIONS in transitions.ts byte-for-byte.
-- Any change requires founder approval via CODEOWNERS + simultaneous
-- update to both.

BEGIN;

-- ============================================================
-- (1) Enforcement function
-- ============================================================
CREATE OR REPLACE FUNCTION enforce_lifecycle_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_old text := OLD.lifecycle_status;
  v_new text := NEW.lifecycle_status;
  v_allowed boolean := false;
BEGIN
  -- No-op when status unchanged (the trigger still fires on every UPDATE
  -- because we don't use WHEN clauses — those depend on the table and
  -- complicate trigger creation).
  IF v_old = v_new THEN
    RETURN NEW;
  END IF;

  -- ALLOWED_TRANSITIONS table — mirror of src/control-plane/
  -- knowledge-state-machine/transitions.ts. The 'proposed' state is a
  -- transit-only state (rows never persist with it), but we still allow
  -- its outbound edges for completeness — they will fire only on rows
  -- inserted with proposed (currently none through the harness path).
  CASE v_old
    WHEN 'proposed' THEN
      v_allowed := v_new IN ('pending_review', 'ephemeral');
    WHEN 'pending_review' THEN
      v_allowed := v_new IN ('active', 'verified', 'revoked');
    WHEN 'ephemeral' THEN
      v_allowed := v_new IN ('observed', 'deprecated', 'revoked');
    WHEN 'observed' THEN
      v_allowed := v_new IN ('reinforced', 'deprecated', 'revoked');
    WHEN 'reinforced' THEN
      v_allowed := v_new IN ('verified', 'deprecated', 'revoked');
    WHEN 'verified' THEN
      v_allowed := v_new IN ('active', 'deprecated', 'revoked');
    WHEN 'active' THEN
      v_allowed := v_new IN ('deprecated', 'revoked');
    WHEN 'deprecated' THEN
      v_allowed := v_new = 'revoked';
    WHEN 'revoked' THEN
      v_allowed := false; -- terminal
    ELSE
      -- Unknown state in the database — should be impossible given the
      -- CHECK on lifecycle_status, but be defensive.
      v_allowed := false;
  END CASE;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'illegal knowledge lifecycle transition: % -> %', v_old, v_new
      USING ERRCODE = 'check_violation',
            HINT = 'Use KnowledgeStateMachine.transition() — direct SQL UPDATE bypasses the state machine.';
  END IF;

  RETURN NEW;
END;
$$;

-- ============================================================
-- (2) Apply trigger to all 4 user-layer knowledge tables
-- ============================================================
DROP TRIGGER IF EXISTS trg_enforce_lifecycle_transition_memory_entry ON memory_entry;
CREATE TRIGGER trg_enforce_lifecycle_transition_memory_entry
  BEFORE UPDATE OF lifecycle_status ON memory_entry
  FOR EACH ROW
  EXECUTE FUNCTION enforce_lifecycle_transition();

DROP TRIGGER IF EXISTS trg_enforce_lifecycle_transition_agent_facts ON agent_facts;
CREATE TRIGGER trg_enforce_lifecycle_transition_agent_facts
  BEFORE UPDATE OF lifecycle_status ON agent_facts
  FOR EACH ROW
  EXECUTE FUNCTION enforce_lifecycle_transition();

DROP TRIGGER IF EXISTS trg_enforce_lifecycle_transition_learned_rules ON learned_rules;
CREATE TRIGGER trg_enforce_lifecycle_transition_learned_rules
  BEFORE UPDATE OF lifecycle_status ON learned_rules
  FOR EACH ROW
  EXECUTE FUNCTION enforce_lifecycle_transition();

DROP TRIGGER IF EXISTS trg_enforce_lifecycle_transition_behavioral_hint ON behavioral_hint;
CREATE TRIGGER trg_enforce_lifecycle_transition_behavioral_hint
  BEFORE UPDATE OF lifecycle_status ON behavioral_hint
  FOR EACH ROW
  EXECUTE FUNCTION enforce_lifecycle_transition();

COMMIT;
