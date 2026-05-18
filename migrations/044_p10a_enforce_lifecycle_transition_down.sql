-- Down migration for 044 — drop lifecycle transition enforcement trigger.
-- Idempotent (uses DROP IF EXISTS).
--
-- WARNING: Rolling this back removes DB-level enforcement of
-- ALLOWED_TRANSITIONS. Application-level enforcement (via
-- KnowledgeStateMachine.transition) remains, but direct SQL updates
-- could resurrect revoked rows. Use only when migration breakage forces
-- a rollback.

BEGIN;

DROP TRIGGER IF EXISTS trg_enforce_lifecycle_transition_behavioral_hint ON behavioral_hint;
DROP TRIGGER IF EXISTS trg_enforce_lifecycle_transition_learned_rules ON learned_rules;
DROP TRIGGER IF EXISTS trg_enforce_lifecycle_transition_agent_facts ON agent_facts;
DROP TRIGGER IF EXISTS trg_enforce_lifecycle_transition_memory_entry ON memory_entry;

DROP FUNCTION IF EXISTS enforce_lifecycle_transition();

COMMIT;
