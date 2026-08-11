-- 100 — Trace Explorer: keyset-pagination + filter indexes (issue #514 §7).
--
-- The Admin Trace Explorer was a stub returning []. Wiring it to
-- `runtime_trace_envelopes` introduces three access patterns that the P10b
-- indexes (migration 052) do not serve well:
--
--   1. Paginated listing per tenant/agent, newest first, with a COMPOSITE
--      keyset cursor `(created_at, trace_id) < (:ts, :id)`. Migration 052's
--      `runtime_trace_env_tenant_created_idx (tenant_id, agent_id, created_at)`
--      is ASC-only and lacks the `trace_id` tiebreaker, so the composite
--      predicate degrades to a filter+sort instead of an index range scan.
--      Rows created in the same transaction batch share `created_at` to the
--      microsecond, which is exactly when the tiebreaker matters.
--
--   2. Listing scoped to a TENANT without pinning an agent ("all agents"),
--      which cannot use a leading-`agent_id` composite.
--
--   3. Filtering by outcome (`decision`) and by side-effect presence, which
--      the issue requires ("filtro por agente, conversa, data, outcome e
--      side effect") and which must not become a full scan.
--
-- Issue #514 acceptance: "Nenhum full scan. Índices verificados."
-- Target: Trace Explorer p95 < 500 ms for a paginated page.
--
-- All indexes are additive; no column, constraint or data is touched.
-- CONCURRENTLY is deliberately NOT used: the project's migration runner wraps
-- each file in a transaction (see docs/runbooks/migrations.md) and
-- CREATE INDEX CONCURRENTLY cannot run inside one. These tables are young and
-- the build is short; an operator with a large table should build the same
-- indexes concurrently by hand ahead of the deploy and let `IF NOT EXISTS`
-- make this file a no-op.

-- 1 + 2. Keyset pagination, newest first, tenant-leading so a tenant-wide
-- listing (no agent filter) still uses the same index by prefix.
CREATE INDEX IF NOT EXISTS runtime_trace_env_explorer_idx
  ON runtime_trace_envelopes (tenant_id, created_at DESC, trace_id DESC);

-- Per-agent listing keeps its own composite so the agent filter is an index
-- range rather than a post-filter on the tenant-wide range.
CREATE INDEX IF NOT EXISTS runtime_trace_env_explorer_agent_idx
  ON runtime_trace_envelopes (tenant_id, agent_id, created_at DESC, trace_id DESC);

-- 3. Outcome filter. `decision` has 5 possible values, so this is only useful
-- combined with the tenant prefix — which is how the Explorer always queries.
CREATE INDEX IF NOT EXISTS runtime_trace_env_explorer_decision_idx
  ON runtime_trace_envelopes (tenant_id, decision, created_at DESC, trace_id DESC);

-- Side-effect filter. PARTIAL: the Explorer only ever asks for "traces that
-- touched the world", never for `none`/`low`, so indexing the low-value rows
-- would be pure write amplification on the hot path (every turn writes an
-- envelope, most of them read-only).
CREATE INDEX IF NOT EXISTS runtime_trace_env_explorer_side_effect_idx
  ON runtime_trace_envelopes (tenant_id, created_at DESC, trace_id DESC)
  WHERE side_effect_level IN ('medium', 'high', 'critical');

-- Body lookup by (tenant, trace) — the detail view. `runtime_trace_bodies` is
-- keyed by `trace_id` alone, so a naive `WHERE trace_id = $1` would find a row
-- belonging to ANOTHER tenant and rely on an application-level check to reject
-- it. The Explorer instead filters `trace_id = $1 AND tenant_id = $2` so the
-- isolation is enforced by the query itself; this index makes that composite
-- predicate an index lookup rather than a PK lookup plus filter.
CREATE INDEX IF NOT EXISTS runtime_trace_bodies_tenant_trace_idx
  ON runtime_trace_bodies (tenant_id, trace_id);
