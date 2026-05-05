-- Down migration for 001_initial.sql
-- WARNING: destructive — review before applying. Run in transaction.
-- =====================================================================
-- Reverts the entire initial schema: drops every table, trigger, function,
-- index and seed introduced by 001_initial.sql, in reverse FK order.
-- Extensions are dropped last; if other schemas depend on them, comment
-- out the DROP EXTENSION lines before applying.
-- =====================================================================

BEGIN;

-- ---------- Triggers (drop before functions / tables they depend on) ----------
DROP TRIGGER IF EXISTS set_updated_at_rules ON learned_rules;
DROP TRIGGER IF EXISTS set_updated_at_facts ON agent_facts;
DROP TRIGGER IF EXISTS set_updated_at_pessoas ON pessoas;
DROP TRIGGER IF EXISTS set_updated_at_transacoes ON transacoes;
DROP TRIGGER IF EXISTS set_updated_at_contas ON contas_bancarias;
DROP TRIGGER IF EXISTS set_updated_at_entidades ON entidades;

-- ---------- AUDITORIA ----------
DROP TABLE IF EXISTS audit_log CASCADE;

-- ---------- WORKFLOWS ----------
DROP TABLE IF EXISTS workflow_steps CASCADE;
DROP TABLE IF EXISTS workflows CASCADE;

-- ---------- INTELIGÊNCIA ----------
DROP TABLE IF EXISTS self_state CASCADE;
DROP TABLE IF EXISTS agent_memories CASCADE;
DROP TABLE IF EXISTS learned_rules CASCADE;
DROP TABLE IF EXISTS agent_facts CASCADE;

-- ---------- PESSOAS / CONVERSAS / MENSAGENS ----------
-- FKs added to transacoes in 001 (fk_transacoes_*) are removed automatically
-- when transacoes is dropped below; explicit drop is unnecessary.
DROP TABLE IF EXISTS mensagens CASCADE;
DROP TABLE IF EXISTS conversas CASCADE;
DROP TABLE IF EXISTS permissoes CASCADE;
DROP TABLE IF EXISTS pessoas CASCADE;

-- ---------- FINANCEIRO ----------
DROP TABLE IF EXISTS recorrencias CASCADE;
DROP TABLE IF EXISTS transferencias_internas CASCADE;
DROP TABLE IF EXISTS transacoes CASCADE;
DROP TABLE IF EXISTS categorias CASCADE;
DROP TABLE IF EXISTS contas_bancarias CASCADE;
DROP TABLE IF EXISTS entidades CASCADE;

-- ---------- Functions ----------
DROP FUNCTION IF EXISTS trg_set_updated_at();

-- ---------- Extensions ----------
-- NOTE: only drop these if no other schema in this database uses them.
DROP EXTENSION IF EXISTS "btree_gin";
DROP EXTENSION IF EXISTS "vector";
DROP EXTENSION IF EXISTS "pgcrypto";
DROP EXTENSION IF EXISTS "uuid-ossp";

COMMIT;
