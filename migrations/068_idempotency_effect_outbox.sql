-- =====================================================================
-- Maia — Migration 068 (Issue #316)
-- Transactional outbox for exactly-once NON-IDEMPOTENT external effects.
--
-- Why
-- ---
-- #303/#298 closed the idempotency CACHE convergence: an INSERT … ON
-- CONFLICT reservation + a `reservation_token` fencing mechanism make the
-- cache settle on exactly ONE authoritative result, and a slow/preempted
-- owner whose lease was reclaimed cannot clobber the new owner's result
-- (its stale token no longer matches → markCompleted/releaseReservation
-- become no-ops). For IDEMPOTENT operations that is sufficient.
--
-- Residual gap (#316): a preempted owner can have ALREADY PHYSICALLY FIRED
-- its side effect before being fenced. For NON-IDEMPOTENT external calls
-- (sending a WhatsApp message, charging a card, calling a third-party API)
-- that means a DUPLICATE physical effect even though the cache converged.
--
-- True exactly-once needs a TRANSACTIONAL OUTBOX: the intended external
-- effect is recorded in the SAME DB transaction as the winning reservation
-- completion (idempotency_keys → completed), so the effect is tied to the
-- WINNING reservation, not to whichever worker raced. A single relayer
-- (src/workers/idempotency-outbox-relayer.ts) then dispatches each pending
-- row exactly once and marks it sent/failed with retry/backoff. The handler
-- itself no longer fires the side effect inline (it only PLANS it), so no
-- effect can escape the reservation's atomic commit.
--
-- Distinct from the two pre-existing tables:
--   - outbound_messages (#227/#233/#292): the SYNCHRONOUS reply ledger — one
--     row per inbound turn, guards the reply-to-the-same-conversa path.
--   - outbox_messages (Spec 18 scheduling): the async scheduling queue for
--     reminders/recurring outreach.
-- idempotency_effect_outbox is specifically the effect-side of a tool
-- dispatch's idempotency reservation: keyed back to the (tenant, agent,
-- idempotency_key) tuple that won the reservation in idempotency_keys.
--
-- Columns
-- -------
--   id              — surrogate PK.
--   tenant_id/agent_id — INVIOLABLE isolation scope. NOT NULL (mirrors the
--                     idempotency_keys default 'default' for legacy parity;
--                     the relayer fans out per real (tenant, agent) tuple and
--                     never assumes the 'default' sentinel).
--   idempotency_key — the SAME key as the winning idempotency_keys row. The
--                     UNIQUE (tenant_id, agent_id, idempotency_key) makes the
--                     in-transaction INSERT idempotent: a fenced/duplicate
--                     completion attempt cannot enqueue a second effect for
--                     the same reservation.
--   effect_type     — discriminator for the relayer's dispatch switch
--                     (e.g. 'whatsapp_text'). Keeps the table effect-agnostic.
--   effect_payload  — JSONB describing the intended effect (recipient jid,
--                     text, …). Opaque to the table; validated by the relayer
--                     per effect_type before dispatch.
--   status          — pending | sent | failed. pending = awaiting relay;
--                     sent = dispatched exactly once (terminal-ish, retained
--                     for audit + retention cleanup); failed = exhausted
--                     max_attempts (terminal, ops_alert).
--   attempts        — dispatch attempt counter (incremented each relay try).
--   max_attempts    — per-row attempt budget; status→failed when exceeded.
--   last_error      — last dispatch error text (NULL until a failure).
--   next_attempt_at — backoff gate: the relayer only claims a pending row
--                     when now() >= next_attempt_at. Set forward on each
--                     transient failure (exponential backoff).
--   provider_ref    — provider message id / external ref returned on a
--                     successful dispatch (audit trail; mirrors
--                     outbound_messages.provider_message_id).
--   created_at/updated_at — lifecycle timestamps.
--
-- Indexes
-- -------
--   (tenant_id, agent_id, status, next_attempt_at) — the relayer sweep hot
--     path: per (tenant, agent) it claims pending rows whose backoff gate has
--     elapsed, oldest-first. The equality columns anchor the probe and
--     next_attempt_at backs BOTH the `next_attempt_at <= now()` predicate and
--     the ORDER BY the per-tenant LIMIT walks. Created CONCURRENTLY in
--     migration 069 (no-tx) — see the note below.
--
-- Transaction
-- -----------
-- This file runs INSIDE a BEGIN/COMMIT envelope (no -- maia:no-transaction
-- marker): CREATE TABLE / CREATE UNIQUE INDEX (non-concurrent) are fine
-- transactionally. The hot-path covering index is created CONCURRENTLY in a
-- SEPARATE no-tx migration (069) so this DDL stays atomic and the large-table
-- index build doesn't take an ACCESS EXCLUSIVE lock. Everything is
-- IF NOT EXISTS for idempotent re-runs.
-- =====================================================================

CREATE TABLE IF NOT EXISTS idempotency_effect_outbox (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL DEFAULT 'default',
  agent_id        TEXT NOT NULL DEFAULT 'default',
  idempotency_key TEXT NOT NULL,
  effect_type     TEXT NOT NULL,
  effect_payload  JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 5,
  last_error      TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  provider_ref    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Coherence: only the three known statuses; a 'failed' row must carry the
  -- error text that explains why it exhausted retries (ops can triage it).
  CONSTRAINT idempotency_effect_outbox_status_chk
    CHECK (status IN ('pending', 'sent', 'failed')),
  CONSTRAINT idempotency_effect_outbox_failed_has_error_chk
    CHECK (status <> 'failed' OR last_error IS NOT NULL)
);

-- One outbox row per winning reservation. The in-transaction INSERT (atomic
-- with idempotency_keys → completed) is ON CONFLICT DO NOTHING against this
-- key, so a fenced/duplicate completion never enqueues a second effect.
CREATE UNIQUE INDEX IF NOT EXISTS idempotency_effect_outbox_tenant_agent_key
  ON idempotency_effect_outbox (tenant_id, agent_id, idempotency_key);
