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
--   1. New table `outbound_messages` with a UNIQUE `idempotency_key`.
--   2. Optimistic pre-send registration: insert `status='pending'`
--      keyed by `(conversa_id, in_reply_to, hash(content))` BEFORE
--      calling the provider. A row already at `status='sent'` for the
--      same key → skip the send (the second attempt sees the prior
--      success and returns early).
--   3. Per-turn guard before ReAct fall-through: a recent attempt for
--      this turn with `status ∈ {sent, unknown}` BLOCKS ReAct from
--      sending a second reply (it would risk a double-send).
--      `status='failed'` does NOT block (genuine pre-send failure,
--      safe to retry via ReAct).
--
-- Status semantics (the spec's "important nuance"):
--   pending — row reserved before the provider call; not yet resolved.
--   sent    — provider returned a `whatsapp_id`; persisted; final.
--   failed  — pre-send failure that DEFINITIVELY did NOT reach the
--             provider (e.g. JID resolution, payload serialization).
--             The ReAct fall-through MAY proceed; no risk of double-send.
--   unknown — ambiguous throw (the provider call errored after a
--             possible partial relay, or post-persist failure where the
--             user already received the reply). Recorded as a
--             do-not-resend signal: the per-turn guard treats it like
--             `sent` and BLOCKS ReAct's fall-through. This trades a
--             fraction of risk-of-silence for ZERO double-send (owner's
--             explicit choice — see issue spec §Design point 3 / nuance).
--
-- Why not reuse `idempotency_keys` or `outbox_messages`:
--   - `idempotency_keys` (migration 002) is tool-shaped (NOT NULL
--     tool_name/entity_id/operation_type/payload_hash) and indexed for
--     5-min dedupe windows on side-effect-tool calls.
--   - `outbox_messages` (migration 007) is the asynchronous / worker-
--     driven scheduled outbox (kind/payload/claimed_by/attempts), not
--     a synchronous reply ledger.
--   A dedicated table keeps the contract tight + the indexes scoped to
--   reply-time lookups.
--
-- Multi-tenant:
--   `tenant_id NOT NULL` matches every other governance table since
--   migration 012 (the inviolable tenant isolation invariant).
--   `agent_id` is nullable for parity with `outbox_messages` — the
--   outbound path may run before agent context is fully bound on rare
--   error paths; the per-turn guard always includes the tenant filter
--   regardless. Adversarial seed tests (PR #222 pattern) prove a
--   tenant-B row cannot surface in a tenant-A lookup. See
--   `tests/unit/repos/outbound-messages-repo.spec.ts`.
--
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps the script in a transaction.

CREATE TABLE IF NOT EXISTS outbound_messages (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           TEXT NOT NULL,
  agent_id            TEXT,

  -- Stable across retries within the SAME turn (same conversa_id +
  -- in_reply_to + content hash). UNIQUE so a concurrent retry hits a
  -- constraint and we read back the prior attempt rather than racing
  -- two provider calls.
  idempotency_key     TEXT NOT NULL UNIQUE,

  -- Turn anchoring — the guard's lookup key. `conversa_id` is uuid in
  -- mensagens/conversas; `in_reply_to` is the inbound `mensagens.id`
  -- the reply addresses (the turn marker).
  conversa_id         UUID NOT NULL,
  in_reply_to         UUID NOT NULL,

  -- Provider response when the send succeeded (whatsapp_id from
  -- baileys). NULL until status transitions to 'sent'.
  provider_message_id TEXT,

  -- See file header for status semantics. `failed` does NOT block
  -- ReAct fall-through; `pending`/`sent`/`unknown` do.
  status              TEXT NOT NULL DEFAULT 'pending',

  -- Wall clock when the provider returned a message id (transition
  -- pending → sent). NULL while pending/failed/unknown.
  sent_at             TIMESTAMPTZ,

  -- Last error message (truncated by caller — column is TEXT). NULL
  -- on success rows.
  error               TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Allowed statuses pinned at the DB so a stray UPDATE can't park a
  -- row in an invalid state.
  CONSTRAINT outbound_messages_status_check
    CHECK (status IN ('pending', 'sent', 'failed', 'unknown'))
);

COMMENT ON TABLE outbound_messages IS
  'Idempotency ledger for synchronous reply outbound. One row per (conversa_id, in_reply_to, content-hash). Closes the double-send crux from #216/#227.';

COMMENT ON COLUMN outbound_messages.idempotency_key IS
  'Stable across retries within the same turn. Derived from conversa_id + in_reply_to + sha256(text). UNIQUE — a retry hits the constraint and reads the prior row instead of racing the provider.';

COMMENT ON COLUMN outbound_messages.status IS
  'pending = reserved pre-send; sent = provider returned an id; failed = pre-send failure (safe to retry via ReAct); unknown = ambiguous throw (do NOT retry — trades risk-of-silence for zero double-send). See migration 063 header.';

COMMENT ON COLUMN outbound_messages.agent_id IS
  'Nullable to mirror outbox_messages; the per-turn guard ALWAYS includes tenant_id in its WHERE clause regardless.';

-- Per-turn lookup hot path: the guard reads
-- `WHERE conversa_id=? AND in_reply_to=? AND tenant_id=? ORDER BY created_at DESC LIMIT 1`.
-- Composite index keys the common case; `created_at DESC` lets the
-- planner return the latest row without a separate sort.
CREATE INDEX IF NOT EXISTS idx_outbound_messages_turn_lookup
  ON outbound_messages (conversa_id, in_reply_to, tenant_id, created_at DESC);

-- Optional analytics: how many failures vs sent per tenant. Cheap to
-- maintain (low write volume per turn).
CREATE INDEX IF NOT EXISTS idx_outbound_messages_tenant_status
  ON outbound_messages (tenant_id, status, created_at DESC);
