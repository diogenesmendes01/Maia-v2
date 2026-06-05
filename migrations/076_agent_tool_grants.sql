-- =====================================================================
-- Maia — Migration 076 (issue #408)
-- Per-agent TOOL GRANTS: what tools an AGENT has installed.
--
-- WHY (issue #408): until now the LLM-visible tool set was filtered ONLY by
-- what the HUMAN can do (`permissoes`). #408 introduces the orthogonal axis —
-- what the AGENT has installed — and composes the two by AND (the Runtime Tool
-- Filter). Tool PACKS are a product definition in code (src/tools/packs.ts:
-- baseline.core + domain.*); the per-agent GRANT is data, and lives here.
--
-- A grant row carries:
--   - granted_packs : pack ids from src/tools/packs.ts (default ['baseline.core']),
--   - granted_tools : individual tool names granted outside a pack,
--   - denied_tools  : HARD deny — never visible to the LLM AND refused by the
--                     dispatcher (`tool_not_granted` guard), even if also in a
--                     granted pack/tool (invariant #5, fail-closed).
-- baseline.core is ALWAYS unioned in at runtime, so a default agent that only
-- has ['baseline.core'] sees exactly the conservative floor — no domain tools.
--
-- TENANT ISOLATION (invariant #1): tenant_id + agent_id NOT NULL; UNIQUE on
-- (tenant_id, agent_id) — one effective grant per agent. The repo
-- (agentToolGrantsRepo) scopes every read/write to the ALS context. See
-- tests/integration/agent-tool-grants-leak.spec.ts +
-- tests/unit/agent-tool-grants-repo-scope.spec.ts.
--
-- BACKFILL: idempotently seed one default grant (['baseline.core']) per EXISTING
-- agent so no agent is left without a grant (which would be fail-closed to
-- zero tools at runtime — a silent regression). New agents get their default
-- grant in the same tx as creation (agentsRepo.createWithSeedAndAudit).
--
-- NOTE: no BEGIN/COMMIT — scripts/migrate.ts wraps each forward migration in a
-- transaction (no `-- maia:no-transaction` marker here). Mirrors migration 074.
-- =====================================================================

CREATE TABLE IF NOT EXISTS agent_tool_grants (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ON DELETE CASCADE: a grant is owned by its agent/tenant — deleting the
  -- agent (or tenant) removes its grants. Without this, deleting an agent that
  -- has a default grant (every agent gets one via createWithSeedAndAudit) fails
  -- the FK, breaking any caller that deletes agents (e.g. test cleanup).
  tenant_id      TEXT NOT NULL DEFAULT 'default' REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id       TEXT NOT NULL DEFAULT 'default' REFERENCES agents(id) ON DELETE CASCADE,
  granted_packs  TEXT[] NOT NULL DEFAULT '{baseline.core}'::text[],
  granted_tools  TEXT[] NOT NULL DEFAULT '{}'::text[],
  denied_tools   TEXT[] NOT NULL DEFAULT '{}'::text[],
  granted_by     TEXT,
  reason         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One effective grant per agent (invariant #1 — tenant-scoped uniqueness).
  CONSTRAINT agent_tool_grants_tenant_agent_key UNIQUE (tenant_id, agent_id)
);

-- Lookup index for the runtime filter hot path: given (tenant, agent), fetch
-- the effective grant.
CREATE INDEX IF NOT EXISTS agent_tool_grants_tenant_agent_idx
  ON agent_tool_grants (tenant_id, agent_id);

-- updated_at trigger — mirrors the per-table triggers in migration 001.
CREATE TRIGGER set_updated_at_agent_tool_grants
  BEFORE UPDATE ON agent_tool_grants
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- Idempotent backfill: one default ['baseline.core'] grant per existing agent.
-- ON CONFLICT DO NOTHING (the (tenant_id, agent_id) unique is the target) makes
-- re-runs safe and never overwrites an operator-edited grant.
INSERT INTO agent_tool_grants (tenant_id, agent_id, granted_packs, granted_by, reason)
SELECT a.tenant_id, a.id, '{baseline.core}'::text[], 'system', 'baseline.core default grant (issue #408 backfill)'
FROM agents a
ON CONFLICT ON CONSTRAINT agent_tool_grants_tenant_agent_key
  DO NOTHING;
