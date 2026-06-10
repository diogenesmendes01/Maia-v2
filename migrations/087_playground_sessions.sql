-- 087 — Playground sandbox (issue #464, spec docs/superpowers/specs/2026-06-10-agent-playground-design.md)
--
-- Two tables backing the admin-console "Testar agente" chat:
--   - playground_sessions: one sandbox conversation per operator, optionally
--     pinned to a PROPOSED operational profile version (NULL = active profile).
--   - playground_turns: user/agent messages. The `status` column doubles as
--     the work queue: the runtime worker polls for status='queued' rows
--     (Postgres-as-queue — the admin-ui has no Redis client; both processes
--     already share Postgres).
--
-- Sandbox contract (enforced in code, summarized here):
--   - turns NEVER touch outbox, episodic/working memory, or learning;
--   - side-effect tools are never executed — proposals are recorded in
--     decision_meta;
--   - sessions expire (expires_at) and are swept by a cleanup worker.
--
-- Tenant isolation: every row carries tenant_id + agent_id; all reads are
-- scoped by both (invariant 1).

CREATE TABLE playground_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  agent_id text NOT NULL,
  -- NULL = converse with the ACTIVE profile; otherwise a (typically
  -- 'proposed') agent_operational_profile_versions.id whose body is used for
  -- prompt assembly WITHOUT activating it.
  profile_version_id uuid NULL
    REFERENCES agent_operational_profile_versions(id) ON DELETE SET NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours'
);

CREATE INDEX playground_sessions_tenant_agent_idx
  ON playground_sessions (tenant_id, agent_id, created_at DESC);
CREATE INDEX playground_sessions_expiry_idx
  ON playground_sessions (expires_at);

CREATE TABLE playground_turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES playground_sessions(id) ON DELETE CASCADE,
  -- Denormalized for cheap tenant-guarded reads + the worker's poll predicate.
  tenant_id text NOT NULL,
  agent_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'agent')),
  content text NOT NULL,
  -- Populated on agent turns: intents, tools the model proposed and whether
  -- the sandbox blocked them, confidence, profile_version used, latency.
  decision_meta jsonb NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'error')),
  error_detail text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL
);

CREATE INDEX playground_turns_session_idx
  ON playground_turns (session_id, created_at);
-- Worker poll: oldest queued first, across tenants (worker re-derives
-- tenant context per row).
CREATE INDEX playground_turns_queue_idx
  ON playground_turns (created_at)
  WHERE status = 'queued';
