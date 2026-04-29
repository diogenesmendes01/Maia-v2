# WhatsApp B2 — Inbound Updates + Outbound Quoting + Pending Reminders — Design

**Date:** 2026-04-29
**Status:** Approved (in brainstorm), pending spec review and user review.
**Scope:** Sub-project B2 of the WhatsApp brainstorm tracks. Sub-A (PR #11), B0 (PR #12) merged. B3a/B3b/B4 deferred.
**Hard prerequisite:** **B1 (PR #15) must merge to `main` before this spec's plan starts.** §4.2 modifies `sendOutboundPoll`, which only exists on B1's branch. The plan is unexecutable otherwise.
**Depends on:** sub-A (presence — `quotedReplyContext` already accepts any metadata), B0 (`pending_questions` lifecycle + `ask_pending_question` tool + `pendingQuestionsRepo.createTx`), B1 (`sendOutboundPoll`), spec 04 (gateway), spec 06 (agent loop), spec 09 (audit taxonomy).

---

## 1. Purpose

Three complementary capabilities, all about **context preservation** in the WhatsApp UI:

1. **`messages.update`** — when the user **edits** or **deletes (revokes)** an inbound message, detect it, audit it, and — if that original message already triggered a side-effect — open a **pending review** for the owner. No auto-undo (chosen Path A in brainstorm).
2. **Outbound `remote_jid` persistence** — today outbound `mensagens` rows store `whatsapp_id` only. Adding `remote_jid` enables Maia to **quote her own previous messages** as the parent of a new send.
3. **Pending reminder worker** — uses #2 to nudge the user when they haven't answered a pending question in N hours, by sending "lembra disso?" **quoting the original question** instead of repeating fresh text.

## 2. Goals

- Edits/deletes never silently break the audit trail.
- Side-effect-bearing edits/deletes always surface to the owner via the existing B0 `pending_questions` machinery — same UX as any other "Maia precisa decidir algo" prompt. No new approval mechanism.
- Reminder worker is throttled (≤ 2 reminders per pending) and idempotent so it can run on a fixed cron without spamming.
- All three behaviours are feature-flagged off by default.
- Zero regression: when flags are off, the gateway and agent loop behave identically to current main.

## 3. Non-goals

- **Auto-undo** of transactions following an edit/delete. Owner decides via the review pending. (Brainstorm Path A.)
- **Editing outbound messages** (Maia editing her own past message). No flow needs it.
- **Revoking outbound messages** ("ops, mandei errado"). Defer to a post-B2 if the use case appears.
- **Quoting outbound** in arbitrary places. Only the reminder worker uses it in v1.
- **Multi-language reminder copy.** Portuguese only; localisation comes if/when needed.

## 4. Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│  src/agent/message-update.ts (NEW)                                        │
│    routeMessageUpdate(update: proto.IWebMessageInfo) — single entry       │
│    branches internally on update.message:                                  │
│      .editedMessage           → handleEdit                                 │
│      .protocolMessage.type=0  → handleRevoke                               │
│    Other shapes (read receipts etc.) ignored — Baileys reuses              │
│    messages.update for receipts too.                                       │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│  src/gateway/baileys.ts                                                   │
│    socket.ev.on('messages.update', updates) — NEW listener (gated by      │
│      FEATURE_MESSAGE_UPDATE). For each update, calls routeMessageUpdate.   │
│    handleIncoming UNCHANGED — revokes do NOT come via messages.upsert      │
│      in Baileys 6.7.0; both edits and revokes flow through messages.update.│
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│  src/agent/core.ts                                                        │
│    sendOutbound / sendOutboundPoll: persist remote_jid in metadata        │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│  src/workers/pending-reminder.ts (NEW)                                    │
│    runPendingReminder() — picks pendings >1h old without recent reminder, │
│    sends a quoted "lembra disso?" referencing the original outbound       │
│    mensagens row, increments reminder_count + last_reminder_at            │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│  src/workers/index.ts                                                     │
│    Cron registry: pending_reminder every 30 min, phase 1                  │
└──────────────────────────────────────────────────────────────────────────┘
```

### 4.1 `routeMessageUpdate`, `handleMessageEdit`, `handleMessageRevoke`

`routeMessageUpdate` accepts the raw `proto.IWebMessageInfo` from Baileys' `messages.update` event and is the single entry point. It unwraps the envelope, classifies, and dispatches to one of two private handlers.

```typescript
// src/agent/message-update.ts
import type { proto } from '@whiskeysockets/baileys';

export async function routeMessageUpdate(update: proto.IWebMessageInfo): Promise<void> {
  const wid = update.key?.id;
  if (!wid) return;
  const m = update.message;
  if (!m) return;

  // Edit: Baileys 6.7.0 wraps the new content under editedMessage.message.<typeOfMessage>.
  // We support text edits initially; media/audio edits noted as out-of-scope (§11).
  const edited = m.editedMessage?.message;
  if (edited) {
    const new_conteudo =
      edited.conversation ??
      edited.extendedTextMessage?.text ??
      null;
    if (typeof new_conteudo === 'string') {
      await handleMessageEdit({ whatsapp_id: wid, new_conteudo });
    }
    return;
  }

  // Revoke: protocolMessage.type === REVOKE (numeric 0 in Baileys 6.7.0 enum).
  // The `key` of the revoked message lives at protocolMessage.key.
  const proto_msg = m.protocolMessage;
  if (proto_msg && proto_msg.type === 0 && proto_msg.key?.id) {
    await handleMessageRevoke({
      whatsapp_id: proto_msg.key.id,
      revoked_by_jid: update.key.remoteJid ?? '',
    });
    return;
  }

  // Anything else (read receipts, message-status updates) is not interesting.
}
```

`handleMessageEdit({ whatsapp_id, new_conteudo: string })` and `handleMessageRevoke({ whatsapp_id, revoked_by_jid: string })` are private and share the body shape:

1. `mensagensRepo.findByWhatsappId(whatsapp_id)` → `original | null`. If null, log + return (we don't know about that message; can't act).
2. Detect side-effect: query `audit_log` for rows where `mensagem_id = original.id` AND `acao IN (transaction_created, transaction_corrected, transaction_cancelled, pending_action_dispatched)`. If any → side-effect existed and the audit row's `alvo_id` carries the `transacao_id`.
3. **No side-effect path** — emit one of:
   - `mensagem_edited` with `diff: { before: original.conteudo, after: new_conteudo }`
   - `mensagem_revoked`
   Then return.
4. **Side-effect path** — emit one of `mensagem_edited_after_side_effect` / `mensagem_revoked_after_side_effect`, then create a `pending_question` for the **owner** via `pendingQuestionsRepo.createTx`:

```typescript
{
  conversa_id: <owner's active conversa>,
  pessoa_id: owner.id,
  tipo: 'edit_review',
  pergunta: `Você ${editou|deletou} uma mensagem que virou transação. Quer cancelar?`,
  opcoes_validas: [
    { key: 'sim', label: 'Sim, cancela' },
    { key: 'nao', label: 'Não, mantém' },
  ],
  acao_proposta: { tool: 'cancel_transaction', args: { transacao_id: <id from audit> } },
  expira_em: now() + 24h,
  metadata: { source: 'edit_review', original_mensagem_id, original_whatsapp_id },
}
```

When the owner answers (via text, reaction, or poll — B0+B1 already handle all three), the gate's `resolveAndDispatch` runs the `cancel_transaction` tool.

**`cancel_transaction` does not exist on main today** (verified: `src/tools/_registry.ts` has 18 tools, none named `cancel_transaction`). B2 introduces it as a thin tool:

```typescript
// src/tools/cancel-transaction.ts
const inputSchema = z.object({
  transacao_id: z.string().uuid(),
  motivo: z.string().max(200).optional(),  // populated from edit_review pending
});

const outputSchema = z.union([
  z.object({ ok: z.literal(true), transacao_id: z.string() }),
  z.object({ error: z.string() }),
]);

// Handler:
//   1. Verify the transaction exists and is within ctx.scope.entidades.
//      Out-of-scope or missing → { error: 'forbidden' }.
//   2. UPDATE transacoes SET status='cancelada', cancelada_em=now(), updated_at=now()
//      WHERE id=$1.
//   3. (Optional) revert account balance if the transaction was 'paga'/'recebida' —
//      the existing transaction-correction flow already does this; reuse the same
//      helper if available, else leave a TODO and let owner reconcile manually.
//   4. Audit transaction_cancelled (existing closed-taxonomy entry).
//   5. Idempotent on transacao_id (operation_type='cancel') — repeated calls
//      from the dispatcher cache return the same {ok:true,transacao_id}.
//
// side_effect: 'write'
// required_actions: ['cancel_transaction']  (existing ActionKey)
// audit_action: 'transaction_cancelled'  (existing AuditAction)
// operation_type: 'cancel'
```

Registered in `_registry.ts`. The `transaction_cancelled` audit action and `cancel_transaction` permission ActionKey **already exist** in `src/governance/audit-actions.ts` — only the tool implementation is new. **Zero new audit/permission surface.**

### 4.2 Outbound `remote_jid` persistence

Today `core.ts` calls `mensagensRepo.create({ ..., metadata: { whatsapp_id: wid, in_reply_to } })`. Two add-one-line edits:

```typescript
// In sendOutbound:
metadata: { whatsapp_id: wid, remote_jid: jid, in_reply_to, ...(pending_question_id && { pending_question_id }) }

// In sendOutboundPoll:
metadata: { whatsapp_id: sent.whatsapp_id, remote_jid: jid, in_reply_to,
            pending_question_id: pending.id,
            poll_options: pending.opcoes_validas,
            poll_message_secret: sent.message_secret }
```

`quotedReplyContext` (sub-A) already accepts any metadata with `whatsapp_id` + `remote_jid`. Once outbound rows carry both, the existing helper works for both inbound and outbound parents — no signature change.

### 4.3 Reminder worker

`src/workers/pending-reminder.ts`:

```typescript
export async function runPendingReminder(): Promise<void>;
```

Per-tick logic:

```sql
-- Pseudo-SQL describing the scan; real impl uses Drizzle.
SELECT pq.*, m.metadata AS outbound_metadata, p.telefone_whatsapp
  FROM pending_questions pq
  JOIN pessoas p ON p.id = pq.pessoa_id
  LEFT JOIN mensagens m ON
    m.direcao = 'out'
    AND (m.metadata->>'pending_question_id') = pq.id::text
 WHERE pq.status = 'aberta'
   AND pq.expira_em > now()
   AND pq.created_at < now() - interval '1 hour'
   AND COALESCE((pq.metadata->>'reminder_count')::int, 0) < 2
   AND (
     pq.metadata->>'last_reminder_at' IS NULL
     OR (pq.metadata->>'last_reminder_at')::timestamptz < now() - interval '1 hour'
   )
 ORDER BY pq.created_at ASC
 LIMIT 50;
```

For each row:
1. If `outbound_metadata` is null → skip (nothing to quote — pending was created out-of-band, e.g. by B2 itself for an `edit_review`; we don't reminder those, owner gets a fresh one if desired). Audit `pending_reminder_skipped_no_outbound`.
2. Build quote via `quotedReplyContext(outbound_metadata, original_pergunta)`.
3. Send: `sendOutboundText(jid, "Lembra dessa? Tô aguardando.", { quoted })`.
4. Update `pending_questions.metadata`:
   - `last_reminder_at = now()`
   - `reminder_count = COALESCE(reminder_count, 0) + 1`
5. Audit `pending_reminder_sent` with `{ pending_question_id, reminder_count }`.

Idempotency: the cron tick is non-transactional but the `last_reminder_at` update happens **before** the reminder send. If the send fails the timestamp is already advanced — the next tick won't double-send. Trade-off: occasional missed reminder on send failure, **never duplicate**. Acceptable for v1.

Observability: when a tick scans a pending whose `last_reminder_at` is within 1h, it emits a debug-level `pending_reminder_skipped_already_marked` audit. This makes the crash-during-send case testable — a deliberate crash between metadata-update and send produces a `pending_reminder_skipped_already_marked` audit on the next tick (instead of a second `pending_reminder_sent`).

**Cron**: registered in `src/workers/index.ts` as `pending_reminder` at `*/30 * * * *`, phase 1, gated by `FEATURE_PENDING_REMINDER`.

### 4.4 Edit-review pending excluded from reminder loop

The reminder worker SKIPS pendings whose `tipo = 'edit_review'`. Reminding the owner about their own edit is noise — they either care immediately or not at all. Filter in the SQL: `AND pq.tipo != 'edit_review'`.

## 5. Schema / migration

One migration. `audit_log.mensagem_id` is queried by `handleMessageEdit` / `handleMessageRevoke` to detect side-effects (§4.1 step 2). The current schema has no index on that column, so the query degrades to a seq scan as `audit_log` grows.

`migrations/005_audit_mensagem_idx.sql`:

```sql
-- =====================================================================
-- Maia — Migration 005 (B2: message-update side-effect detection)
-- Indexes audit_log.mensagem_id so the per-edit lookup stays O(log n)
-- as audit_log grows. Partial — only rows that actually carry a
-- mensagem_id are interesting to this query path.
-- =====================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_mensagem
  ON audit_log (mensagem_id)
  WHERE mensagem_id IS NOT NULL;
```

`mensagens.metadata` and `pending_questions.metadata` JSONB additions (`remote_jid`, `last_reminder_at`, `reminder_count`) require **no** DDL.

## 6. Configuration

Two new flags (default `false`):

- `FEATURE_MESSAGE_UPDATE` — gates the edit + revoke handlers in baileys.ts.
- `FEATURE_PENDING_REMINDER` — gates the reminder worker.

Outbound `remote_jid` persistence is **always on** — it costs nothing (one extra JSONB key) and is a prerequisite for the reminder, view-once (B3a), and any future quote-back use case. Persisting it without consumers is harmless.

## 7. Audit-action additions

In `src/governance/audit-actions.ts`:

```typescript
'mensagem_edited',
'mensagem_revoked',
'mensagem_edited_after_side_effect',
'mensagem_revoked_after_side_effect',
'edit_review_resolved',                 // when owner decides via the pending
'pending_substituted_by_edit_review',   // visibility for §8 trade-off
'pending_reminder_sent',
'pending_reminder_skipped_no_outbound',
'pending_reminder_skipped_already_marked', // §4.3 idempotency trace
```

`edit_review_resolved` fires from the gate's `resolveAndDispatch` path when the resolved pending's `tipo === 'edit_review'`. (Small addition to `resolveAndDispatch` or a side-listener — the spec leaves the implementation choice to the plan.)

## 8. Concurrency

- The reminder worker runs every 30 min. The 1-hour `last_reminder_at` debounce means a single pending can't be reminded twice within an hour even if the worker runs fast or two cron instances overlap.
- Edit/revoke handlers are eventually-consistent: the original `mensagens` row may be in flight when the edit arrives (rare; Baileys typically delivers in order). If `findByWhatsappId` returns null, we log and skip — no retry. Trade-off: a race-edited message before its inbound persists is lost. Acceptable.
- B0's `cancelOpenForConversaTx` invariant (one active pending per conversa) means creating an `edit_review` pending will **substitute** any existing pending on the owner's conversa — including unrelated ones (e.g., a `query_balance` follow-up). **Trade-off (deliberate)**: edit-review takes priority because it's about reverting financial state; an unrelated balance question is cheap to re-ask. To make the loss observable, the substitution emits an extra audit `pending_substituted_by_edit_review` (in addition to B0's standard `pending_substituted`) carrying the substituted pending's `tipo` so cost monitoring / cost ledger can detect spurious cancellations and the team can revisit if it becomes a real complaint.

## 9. Error handling

- All inbound dispatches (`messages.update`, REVOKE branch) are wrapped `Promise.catch` at the gateway and audit `one_tap_dispatch_error`-style (or a new `message_update_dispatch_error` — TBD by plan; probably fold into `message_update_failed`).
- The reminder worker's send failure is logged + audited; the timestamp advance prevents re-attempt within the hour.

## 10. Testing

### Unit

- `tests/unit/message-update.spec.ts`:
  - `handleMessageEdit`: original not found → no-op.
  - `handleMessageEdit`: no side-effect → audits `mensagem_edited` with diff, no pending created.
  - `handleMessageEdit`: side-effect detected → creates `edit_review` pending with `cancel_transaction` action; audits `mensagem_edited_after_side_effect`.
  - `handleMessageRevoke`: same three branches as edit, with `mensagem_revoked` / `mensagem_revoked_after_side_effect`.
- `tests/unit/pending-reminder.spec.ts`:
  - happy path: pending older than 1h, no prior reminder → sends quoted text, updates metadata, audits.
  - skips when `reminder_count >= 2`.
  - skips when `last_reminder_at` is within 1h.
  - skips and audits `pending_reminder_skipped_no_outbound` when no matching outbound row exists.
  - skips when `tipo = 'edit_review'`.

### Integration (deferred to manual checklist)

- Real WhatsApp edit + WhatsApp revoke. Not in CI — verified by the operator.

## 11. Out of scope (future)

| Item | Sub-project |
|---|---|
| Auto-undo on edit/delete | post-B (high risk, low demand) |
| Outbound message edit (Maia editing her own past message) | post-B (no flow needs it) |
| Outbound revoke ("ops") | post-B |
| Reminder for `edit_review` pending | post-B (noisy) |
| Localised reminder copy | post-B |
| View-once for sensitive replies (saldos) | B3a |
| PDF / chart export | B3b |
| Voice-note polish | B4 |

## 12. Acceptance criteria

- [ ] `FEATURE_MESSAGE_UPDATE=true` + edit of a message that triggered `transaction_created` → `edit_review` pending exists for the owner; audit `mensagem_edited_after_side_effect` written.
- [ ] `FEATURE_MESSAGE_UPDATE=true` + edit of a message **without** side-effect → only `mensagem_edited` audit; no pending created.
- [ ] `FEATURE_MESSAGE_UPDATE=true` + WhatsApp revoke of a message → analogous behaviour for both with-side-effect and no-side-effect paths.
- [ ] `FEATURE_MESSAGE_UPDATE=false` → edits and revokes are dropped silently (no audit, no pending — preserves pre-B2 behaviour).
- [ ] Owner answers the `edit_review` pending with "sim" → existing `cancel_transaction` tool dispatches via `resolveAndDispatch`; audit `edit_review_resolved`.
- [ ] Outbound `mensagens` rows authored by `sendOutbound` and `sendOutboundPoll` carry `metadata.remote_jid`.
- [ ] `quotedReplyContext` builds a valid `WAQuotedContext` from an outbound row (regression test against an outbound metadata fixture).
- [ ] `FEATURE_PENDING_REMINDER=true`: a pending older than 1h without a prior reminder → reminder sent, metadata updated, audit `pending_reminder_sent`.
- [ ] `FEATURE_PENDING_REMINDER=true`: a pending with `reminder_count = 2` → not reminded again.
- [ ] `FEATURE_PENDING_REMINDER=true`: a pending with `tipo = 'edit_review'` → never reminded.
- [ ] `FEATURE_PENDING_REMINDER=false` → worker is a no-op.
- [ ] **Crash-during-send guarantee**: a process crash between `last_reminder_at` write and the WhatsApp send → next tick observes `last_reminder_at` already set, emits `pending_reminder_skipped_already_marked`, and does **not** re-send (verified via fault injection in unit test).
- [ ] **Substitution visibility**: creating an `edit_review` pending while another open pending exists for the same conversa emits both `pending_substituted` (B0) and `pending_substituted_by_edit_review` (B2) so the loss is observable.
- [ ] **`cancel_transaction` tool**: registered in `_registry.ts`; refuses out-of-scope `transacao_id` with `error: 'forbidden'`; idempotent on repeat call (dispatcher cache).
- [ ] Quote in reminder is verified by mock socket receiving `{ quoted: { key: { id: <original_wid>, remoteJid: <jid>, fromMe: true }, message: { conversation: <truncated original pergunta> } } }`.

## 13. References

- Sub-A design — `docs/superpowers/specs/2026-04-29-whatsapp-ux-polish-design.md` (`quotedReplyContext`, `sendOutboundText` quoted opt)
- B0 design — `docs/superpowers/specs/2026-04-29-whatsapp-b0-pending-gate-design.md` (`pending_questions`, `ask_pending_question`, `resolveAndDispatch`)
- B1 design — `docs/superpowers/specs/2026-04-29-whatsapp-b1-one-tap-design.md` (poll/reaction handlers feeding the same `resolveAndDispatch`)
- Spec 04 §6 — gateway pipeline
- Spec 09 — pending lifecycle, audit taxonomy
- Spec 12 — proactive workers (reminder worker registers there)
- Baileys docs: `messages.update` event shape, `message.protocolMessage.type === 0` (REVOKE)
