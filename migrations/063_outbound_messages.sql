-- Issue #227 (PR #216 HIGH-1 follow-up): outbound delivery idempotency ledger.
--
-- Context: #216 closed every SYNCHRONOUS silent-drop in dispatchOutput by
-- phase-tagging delivery failures (text / voice / document / poll, pre-send +
-- send + persist). The residual risk is the "delivered-but-threw" window:
-- a provider that DELIVERED the message and THEN threw post-relay (e.g., a
-- socket drop after the network ack) makes safeDispatchOutput tag the throw
-- delivered:false → the skill caller falls through to ReAct → 2nd send =
-- DOUBLE-SEND of a (potentially financial) message. The window is narrow
-- (transports rarely throw post-relay), but the cost of one double-send on a
-- saldo/transferência message is high enough to warrant a ledger.
--
-- Design: optimistic PRE-send insert with a turn-scoped idempotency_key
-- ('${conversa_id}:${in_reply_to}' — the SAME value already emitted in the
-- audit 'outbound_dispatch_failed' breadcrumb by #216, so this ledger keys off
-- a unit that's already observable). One row per inbound turn (any channel):
--   PRE-SEND: optimistic upsert. If the existing row's status is 'sent' or
--     'unknown', SKIP the send entirely (the user already got that turn's
--     reply, or might have — either way, do not re-send).
--   AFTER SEND: markSent(key, provider_message_id) when the gateway acked;
--     markFailed(key, error, status='failed' or 'unknown'). The 'unknown'
--     status is the crux: when a throw could mean "delivered then dropped",
--     we record 'unknown' (NOT 'failed') so the per-turn guard treats this as
--     "an attempt was made" and forbids the ReAct re-send, trading a sliver
--     of silence risk for zero double-send. This matches the conservative
--     'sent_no_persist' semantics safeDispatchOutput already uses.
--
-- Why a new table (vs. reusing existing):
--   - 'idempotency_keys' is tool-shaped (NOT NULL tool_name/entity_id/
--     operation_type) — doesn't fit reply-level dedupe.
--   - 'outbox_messages' is the asynchronous, worker-driven outbox queue;
--     reply dispatch is synchronous to the inbound turn. Different lifecycle,
--     different ownership. The name 'outbound_messages' (below) is documented
--     to distinguish it from 'outbox_messages'.
--
-- This migration adds ONLY the schema. The repo + dispatch wiring + retry
-- guard land in subsequent commits on the same PR so the schema can be
-- reviewed in isolation before the critical-path code starts depending on it.
CREATE TABLE IF NOT EXISTS outbound_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL DEFAULT 'default',
  agent_id text NOT NULL DEFAULT 'default',
  -- Turn-scoped dedupe unit: '${conversa_id}:${in_reply_to}'. Matches the
  -- 'outbound_dispatch_failed' audit metadata.idempotency_key already emitted
  -- by #216. UNIQUE → one row per inbound turn (any channel). Channel
  -- fall-backs within a turn (e.g. poll → text) UPDATE the channel column on
  -- the same row rather than inserting a second row — one reply per turn.
  idempotency_key text NOT NULL UNIQUE,
  conversa_id uuid NOT NULL,
  -- The inbound mensagem.id this reply is responding to.
  in_reply_to uuid NOT NULL,
  -- The channel finally used (or attempted). Updated when poll/voice fall back.
  channel text NOT NULL,
  -- WhatsApp message id once the gateway acks; NULL while pending or after a
  -- send that returned no key.id (the 'sent without id' case discriminated by
  -- isBaileysConnected() in output-dispatch.ts).
  provider_message_id text,
  -- 'pending'  — pre-send optimistic insert; no provider ack yet.
  -- 'sent'     — provider acked with an id; safe to skip re-attempts.
  -- 'failed'   — pre-send failure (disconnected gateway, recipient lookup
  --              throw, etc.); nothing reached the user → ReAct re-attempt is
  --              SAFE (no double-send). Guard allows retry.
  -- 'unknown'  — throw with ambiguous delivery (post-relay timeout, untyped
  --              error). Guard treats as 'sent' (NO re-send) — trades a sliver
  --              of silence risk for zero double-send. The crux of this ledger.
  status text NOT NULL DEFAULT 'pending',
  error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbound_messages_status_check
    CHECK (status IN ('pending', 'sent', 'failed', 'unknown')),
  CONSTRAINT outbound_messages_channel_check
    CHECK (channel IN ('text', 'voice', 'document', 'poll'))
);

-- Hot-path access (pre-send optimistic upsert + per-turn guard) keys off
-- idempotency_key — the UNIQUE constraint above provides that index.
-- Operational queries ("recent attempts per tenant") get this composite.
CREATE INDEX IF NOT EXISTS idx_outbound_messages_tenant_created
  ON outbound_messages (tenant_id, created_at DESC);

COMMENT ON TABLE outbound_messages IS
  'Issue #227: outbound delivery idempotency ledger. One row per inbound turn (any channel). Pre-send optimistic insert + status-aware guard closes the "delivered-but-threw" window left open by #216 phase-tagging. NOT the same as outbox_messages (async worker queue).';

COMMENT ON COLUMN outbound_messages.idempotency_key IS
  'Turn-scoped dedupe unit: ${conversa_id}:${in_reply_to}. Matches metadata.idempotency_key on outbound_dispatch_failed audits emitted by #216.';

COMMENT ON COLUMN outbound_messages.status IS
  'pending|sent|failed|unknown. ''unknown'' is the crux: ambiguous delivery (likely sent) — guard treats as sent (NO re-send) to forbid double-sends, trading a sliver of silence risk for zero double-send.';
