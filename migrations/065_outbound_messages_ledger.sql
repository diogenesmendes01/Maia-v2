-- Issue #227 — Outbound idempotency / dedupe ledger.
--
-- Closes the double-send crux flagged in PR #216 review HIGH-1:
--
--   In the shared `sendOutbound` path, a throw from `sendOutboundText`
--   is classified as `delivered:false` and the caller falls through to
--   ReAct, which may generate a 2nd reply. If the underlying provider
--   already DELIVERED the message before throwing (rare post-relay
--   timeout), this becomes a duplicate-send. The premise
--   "throw ⇒ nothing delivered" holds in the overwhelming majority of
--   cases (connection/crypto/serialization), but is NOT guaranteed by
--   the transport — i.e. there is a narrow ambiguous window.
--
-- The owner's chosen design (issue spec §Design):
--   1. New table `outbound_messages` UNIQUE on
--      `(tenant_id, agent_id, idempotency_key)` (composite — not on key
--      alone, so two tenants reusing a key never collide and never see
--      each other's rows).
--   2. Optimistic pre-send registration via `INSERT ... ON CONFLICT
--      DO UPDATE`: a Postgres-native atomic claim. Two same-turn
--      writers race the INSERT; exactly one wins (`xmax = 0` after the
--      RETURNING). The loser sees the existing row and skips the send.
--   3. Stale-pending recovery: if a prior attempt left a `pending` row
--      and the row's `created_at` is older than 30 seconds, the ON
--      CONFLICT clause OVERWRITES it (the previous claim crashed mid-
--      resolve; nobody marked it sent/failed/unknown). Otherwise the
--      DO UPDATE WHERE clause filters out the conflict and the row
--      stays untouched — RETURNING then returns the prior row.
--   4. Per-turn guard before ReAct fall-through: a recent attempt for
--      this turn with `status ∈ {sent, unknown}` BLOCKS ReAct from
--      sending a second reply (it would risk a double-send).
--      `status='failed'` does NOT block (genuine pre-send failure,
--      safe to retry via ReAct). `unknown` is TERMINAL-SKIP — the
--      caller does NOT cascade to ReAct in the same turn (owner's
--      explicit "rare silence > zero double-send" trade-off).
--
-- Status semantics (the spec's "important nuance"):
--   pending — row reserved before the provider call; not yet resolved.
--             Reclaimable after 30s (stale-pending recovery).
--   sent    — provider returned a `whatsapp_id`; persisted; final.
--             Per-turn guard BLOCKS ReAct fall-through.
--   failed  — pre-send failure that DEFINITIVELY did NOT reach the
--             provider (e.g. JID resolution, payload serialization).
--             The ReAct fall-through MAY proceed; no risk of double-send.
--   unknown — ambiguous throw (the provider call errored after a
--             possible partial relay, or post-persist failure where the
--             user already received the reply). Recorded as a
--             do-not-resend signal: terminal-skip — does NOT cascade
--             to ReAct fall-through in the same turn (owner's "zero
--             double-send" choice; see issue spec §Design point 3).
--
-- Why not reuse `idempotency_keys` or `outbox_messages`:
--   - `idempotency_keys` (migration 002 / 063) is tool-shaped (NOT NULL
--     tool_name/entity_id/operation_type/payload_hash) and indexed for
--     5-min dedupe windows on side-effect-tool calls.
--   - `outbox_messages` (migration 007) is the asynchronous / worker-
--     driven scheduled outbox (kind/payload/claimed_by/attempts), not
--     a synchronous reply ledger.
--   A dedicated table keeps the contract tight + the indexes scoped to
--   reply-time lookups.
--
-- Multi-tenant:
--   `tenant_id NOT NULL` AND `agent_id NOT NULL` (default 'default'
--   for legacy callers — same pattern as #232/#237/#247 rules_repo,
--   agent_memories, etc.). The UNIQUE constraint is COMPOSITE on
--   `(tenant_id, agent_id, idempotency_key)` so two tenants reusing a
--   key NEVER collide and never see each other's rows. All queries
--   (upsertPending/markSent/markFailed/markUnknown/findByConversaTurn)
--   carry the agent_id filter alongside tenant_id.
--
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps the script in a transaction.

CREATE TABLE IF NOT EXISTS outbound_messages (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           TEXT NOT NULL,
  agent_id            TEXT NOT NULL DEFAULT 'default',

  -- Stable across retries within the SAME turn (same conversa_id +
  -- in_reply_to + content hash). UNIQUE is COMPOSITE with
  -- (tenant_id, agent_id) so cross-tenant key collisions never race.
  idempotency_key     TEXT NOT NULL,

  -- Turn anchoring — the guard's lookup key. `conversa_id` is uuid in
  -- mensagens/conversas; `in_reply_to` is the inbound `mensagens.id`
  -- the reply addresses (the turn marker).
  conversa_id         UUID NOT NULL,
  in_reply_to         UUID NOT NULL,

  -- Provider response when the send succeeded (whatsapp_id from
  -- baileys). NULL until status transitions to 'sent'.
  provider_message_id TEXT,

  -- See file header for status semantics. `failed` does NOT block
  -- ReAct fall-through; `sent`/`unknown` do (terminal-skip).
  status              TEXT NOT NULL DEFAULT 'pending',

  -- Wall clock when the provider returned a message id (transition
  -- pending → sent). NULL while pending/failed/unknown.
  sent_at             TIMESTAMPTZ,

  -- Last error message (truncated by caller — column is TEXT). NULL
  -- on success rows.
  error               TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- TTL hint for cleanup (operator-side cron or follow-up worker).
  -- Default 30d retention — long enough to debug a complaint, short
  -- enough that the table doesn't grow unbounded.
  expires_at          TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '30 days'),

  -- Allowed statuses pinned at the DB so a stray UPDATE can't park a
  -- row in an invalid state.
  CONSTRAINT outbound_messages_status_check
    CHECK (status IN ('pending', 'sent', 'failed', 'unknown'))
);

COMMENT ON TABLE outbound_messages IS
  'Idempotency ledger for synchronous reply outbound. UNIQUE on (tenant_id, agent_id, idempotency_key). Closes the double-send crux from #216/#227. See migration 065 header.';

COMMENT ON COLUMN outbound_messages.idempotency_key IS
  'Stable across retries within the same turn. Derived from conversa_id + in_reply_to + sha256(text). UNIQUE composite with (tenant_id, agent_id) — atomic claim via INSERT ON CONFLICT DO UPDATE. See migration 065 header.';

COMMENT ON COLUMN outbound_messages.status IS
  'pending = reserved pre-send (reclaimable after 30s); sent = provider returned an id; failed = pre-send failure (safe to retry via ReAct); unknown = ambiguous throw (TERMINAL-SKIP, do NOT retry — zero double-send). See migration 065 header.';

COMMENT ON COLUMN outbound_messages.agent_id IS
  'NOT NULL with default ''default'' for legacy callers (#232/#237 pattern). Composite-unique with (tenant_id, idempotency_key).';

COMMENT ON COLUMN outbound_messages.expires_at IS
  'TTL hint for cleanup (operator-side cron / follow-up worker). Default 30 days from created_at. Not enforced at the DB; rows are deleted by a maintenance job.';

-- UNIQUE composite: tenant_id + agent_id + idempotency_key. The
-- atomic claim (INSERT ... ON CONFLICT DO UPDATE) targets this
-- constraint. Same pattern as #232/#237 (rules_repo, agent_memories)
-- — never UNIQUE on key alone (cross-tenant collision risk).
CREATE UNIQUE INDEX IF NOT EXISTS idx_outbound_messages_tenant_agent_key
  ON outbound_messages (tenant_id, agent_id, idempotency_key);

-- TURN-LEVEL UNIQUE constraint: closes the
-- "same-turn / different-content double-send" race surfaced after the
-- initial idempotency-key UNIQUE landed.
--
-- The crux: two workers handling the same `(conversa_id, in_reply_to)`
-- pair can deterministically generate DIFFERENT content (different LLM
-- completions, view-once toggles flipping, retry with edited input,
-- etc.), which hash to DIFFERENT `idempotency_key` values. With ONLY
-- the per-key UNIQUE in place each worker would CLAIM ITS OWN row
-- (no conflict between distinct keys) and BOTH would send. The user
-- receives two replies for one inbound turn — the exact failure mode
-- the ledger was supposed to prevent.
--
-- The fix is a SECOND, NARROWER UNIQUE on the turn boundary:
--   (tenant_id, agent_id, conversa_id, in_reply_to)
-- A turn has AT MOST ONE row across all idempotency keys. The atomic
-- claim in `upsertPending` now targets this constraint instead of the
-- key constraint; same-turn / different-content racers conflict on the
-- turn, the WHERE clause forbids overwriting a non-stale claim, and
-- the loser sees `inserted=false` with `existing_key ≠ candidate_key`
-- — the caller treats this as TERMINAL-SKIP (audit emitted) per the
-- owner's "zero double-send" choice.
--
-- The per-key UNIQUE stays for cross-turn idempotency (a retried turn
-- with the SAME content still resolves to the same key and short-
-- circuits on the prior row). Both constraints are required:
--   - key UNIQUE: dedupe across retries with identical content.
--   - turn UNIQUE: dedupe across racers with conflicting content.
ALTER TABLE outbound_messages
  ADD CONSTRAINT outbound_messages_turn_uniq
  UNIQUE (tenant_id, agent_id, conversa_id, in_reply_to);

-- Per-turn lookup hot path: the guard reads
-- `WHERE conversa_id=? AND in_reply_to=? AND tenant_id=? AND agent_id=? ORDER BY created_at DESC LIMIT 1`.
-- Composite index keys the common case; `created_at DESC` lets the
-- planner return the latest row without a separate sort.
CREATE INDEX IF NOT EXISTS idx_outbound_messages_turn_lookup
  ON outbound_messages (conversa_id, in_reply_to, tenant_id, agent_id, created_at DESC);

-- Optional analytics: how many failures vs sent per tenant. Cheap to
-- maintain (low write volume per turn).
CREATE INDEX IF NOT EXISTS idx_outbound_messages_tenant_status
  ON outbound_messages (tenant_id, agent_id, status, created_at DESC);

-- TTL cleanup hint: lets a cleanup cron scan only expired rows.
CREATE INDEX IF NOT EXISTS idx_outbound_messages_expires_at
  ON outbound_messages (expires_at);
