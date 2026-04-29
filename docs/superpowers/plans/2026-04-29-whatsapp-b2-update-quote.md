# WhatsApp B2 — Inbound Updates + Outbound Quoting + Reminders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect WhatsApp message edits/revokes that touched a side-effect, route them through B0's `pending_questions` machinery to ask the owner whether to undo. Add `cancel_transaction` tool. Persist `remote_jid` on outbound rows. Ship a reminder worker that quotes the original outbound when nudging stale pendings.

**Architecture:** Single Baileys `messages.update` listener; `routeMessageUpdate` unwraps the envelope and branches on `editedMessage` vs `protocolMessage.type === 0`. Side-effect detection via indexed `audit_log.mensagem_id` query. Reminder worker uses B1's `quotedReplyContext` against outbound metadata. Three feature flags (`FEATURE_MESSAGE_UPDATE`, `FEATURE_PENDING_REMINDER`; `remote_jid` persistence is unconditional).

**Tech Stack:** TypeScript, `@whiskeysockets/baileys` 6.7.0 (`messages.update` event, `protocolMessage.type === 0` for revoke), Drizzle, vitest.

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `src/config/env.ts` | Modify | `FEATURE_MESSAGE_UPDATE`, `FEATURE_PENDING_REMINDER` flags (default `false`) |
| `src/governance/audit-actions.ts` | Modify | 9 new actions |
| `migrations/005_audit_mensagem_idx.sql` | Create | Partial index `idx_audit_mensagem` |
| `src/tools/cancel-transaction.ts` | Create | New tool: scope-checked transaction cancel, idempotent |
| `src/tools/_registry.ts` | Modify | Register `cancel_transaction` |
| `src/agent/message-update.ts` | Create | `routeMessageUpdate` + `handleMessageEdit` + `handleMessageRevoke` |
| `src/gateway/baileys.ts` | Modify | New `socket.ev.on('messages.update', ...)` listener |
| `src/agent/core.ts` | Modify | Persist `remote_jid` in `sendOutbound` and `sendOutboundPoll` |
| `src/workers/pending-reminder.ts` | Create | Cron worker: quote-based reminder for stale pendings |
| `src/workers/index.ts` | Modify | Register `pending_reminder` cron at `*/30 * * * *`, phase 1 |
| `tests/unit/cancel-transaction.spec.ts` | Create | Tool tests (scope check, idempotency, audit) |
| `tests/unit/message-update.spec.ts` | Create | Edit/revoke handler tests (no-side-effect, side-effect, missing original) |
| `tests/unit/pending-reminder.spec.ts` | Create | Worker tests (happy path, debounce, max-2, skip edit_review, fault injection) |

No DB migrations beyond the index. JSONB additions (`remote_jid`, `last_reminder_at`, `reminder_count`) require no DDL.

---

## Task 1: `FEATURE_MESSAGE_UPDATE` + `FEATURE_PENDING_REMINDER` flags

**Files:** `src/config/env.ts`

- [ ] **Step 1: Append flags**

Alongside the existing `FEATURE_*` entries (after `FEATURE_PRESENCE`):

```typescript
FEATURE_MESSAGE_UPDATE: z
  .string()
  .default('false')
  .transform((s) => s === 'true' || s === '1'),
FEATURE_PENDING_REMINDER: z
  .string()
  .default('false')
  .transform((s) => s === 'true' || s === '1'),
```

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/config/env.ts
git commit -m "feat(b2): FEATURE_MESSAGE_UPDATE + FEATURE_PENDING_REMINDER flags"
```

Expected: only the 3 pre-existing errors (`db/client.ts:24`, `gateway/queue.ts:31`, `lib/alerts.ts:32`).

---

## Task 2: Append 9 audit actions

**Files:** `src/governance/audit-actions.ts`

- [ ] **Step 1: Append**

After the existing `pending_*` block (find `'pending_race_lost'` or similar; append before the `as const`):

```typescript
'mensagem_edited',
'mensagem_revoked',
'mensagem_edited_after_side_effect',
'mensagem_revoked_after_side_effect',
'edit_review_resolved',
'pending_substituted_by_edit_review',
'pending_reminder_sent',
'pending_reminder_skipped_no_outbound',
'pending_reminder_skipped_already_marked',
```

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/governance/audit-actions.ts
git commit -m "feat(b2): 9 audit actions for message-update + reminder lifecycle"
```

---

## Task 3: Migration 005 — `idx_audit_mensagem` partial index

**Files:** `migrations/005_audit_mensagem_idx.sql`

- [ ] **Step 1: Create**

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

- [ ] **Step 2: Commit**

```bash
git add migrations/005_audit_mensagem_idx.sql
git commit -m "feat(b2): migration 005 — idx_audit_mensagem partial index"
```

---

## Task 4: TDD — `cancel_transaction` tool

**Files:**
- Create: `src/tools/cancel-transaction.ts`
- Create: `tests/unit/cancel-transaction.spec.ts`

The tool flips `transacoes.status` to `cancelada` after verifying the caller's scope. Idempotency lives at the dispatcher layer (operation_type=`cancel`) — handler does not double-check.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/cancel-transaction.spec.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const transacoesByIdMock = vi.fn();
const updateMock = vi.fn();

vi.mock('../../src/db/repositories.js', () => ({
  transacoesRepo: {
    byId: transacoesByIdMock,
    update: updateMock,
  },
}));

const auditMock = vi.fn();
vi.mock('../../src/governance/audit.js', () => ({ audit: auditMock }));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  transacoesByIdMock.mockReset();
  updateMock.mockReset();
  auditMock.mockReset();
});

const ctx = {
  pessoa: { id: 'p1' },
  conversa: { id: 'c1' },
  scope: { entidades: ['e1', 'e2'], byEntity: new Map() },
  mensagem_id: 'm1',
  request_id: 'r1',
  idempotency_key: 'ik1',
} as never;

describe('cancel_transaction tool', () => {
  it('cancels a transaction in scope and audits transaction_cancelled', async () => {
    transacoesByIdMock.mockResolvedValueOnce({
      id: 'tx-1',
      entidade_id: 'e1',
      status: 'paga',
    });
    updateMock.mockResolvedValueOnce(undefined);
    const { cancelTransactionTool } = await import('../../src/tools/cancel-transaction.js');
    const result = await cancelTransactionTool.handler(
      { transacao_id: 'tx-1', motivo: 'edit_review' } as never,
      ctx,
    );
    expect(result).toEqual({ ok: true, transacao_id: 'tx-1' });
    expect(updateMock).toHaveBeenCalledWith(
      'tx-1',
      expect.objectContaining({ status: 'cancelada' }),
    );
    expect(auditMock.mock.calls.some((c) => c[0].acao === 'transaction_cancelled')).toBe(true);
  });

  it('refuses out-of-scope transaction with forbidden', async () => {
    transacoesByIdMock.mockResolvedValueOnce({
      id: 'tx-2',
      entidade_id: 'e_other',
      status: 'paga',
    });
    const { cancelTransactionTool } = await import('../../src/tools/cancel-transaction.js');
    const result = await cancelTransactionTool.handler(
      { transacao_id: 'tx-2' } as never,
      ctx,
    );
    expect(result).toEqual({ error: 'forbidden' });
    expect(updateMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('returns error when transaction missing', async () => {
    transacoesByIdMock.mockResolvedValueOnce(null);
    const { cancelTransactionTool } = await import('../../src/tools/cancel-transaction.js');
    const result = await cancelTransactionTool.handler(
      { transacao_id: 'tx-missing' } as never,
      ctx,
    );
    expect(result).toEqual({ error: 'not_found' });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('is idempotent on already-cancelada transaction (no-op success)', async () => {
    transacoesByIdMock.mockResolvedValueOnce({
      id: 'tx-3',
      entidade_id: 'e1',
      status: 'cancelada',
    });
    const { cancelTransactionTool } = await import('../../src/tools/cancel-transaction.js');
    const result = await cancelTransactionTool.handler(
      { transacao_id: 'tx-3' } as never,
      ctx,
    );
    expect(result).toEqual({ ok: true, transacao_id: 'tx-3' });
    expect(updateMock).not.toHaveBeenCalled();
    // No audit on no-op (already cancelled by some prior call).
    expect(auditMock).not.toHaveBeenCalled();
  });
});
```

Run: must FAIL.

- [ ] **Step 2: Implement the tool**

Create `src/tools/cancel-transaction.ts`:

```typescript
import { z } from 'zod';
import type { Tool } from './_registry.js';
import { transacoesRepo } from '@/db/repositories.js';
import { audit } from '@/governance/audit.js';

const inputSchema = z.object({
  transacao_id: z.string().uuid(),
  motivo: z.string().max(200).optional(),
  // _pending_choice may be injected by resolveAndDispatch; we ignore it.
});

const outputSchema = z.union([
  z.object({ ok: z.literal(true), transacao_id: z.string() }),
  z.object({ error: z.string() }),
]);

export const cancelTransactionTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'cancel_transaction',
  description:
    'Cancela uma transação registrada. Use APENAS quando o dono explicitamente confirmar (via pending edit_review, ou comando direto). Out-of-scope é recusado.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['cancel_transaction'],
  side_effect: 'write',
  redis_required: false,
  operation_type: 'cancel',
  audit_action: 'transaction_cancelled',
  handler: async (args, ctx) => {
    const tx = await transacoesRepo.byId(args.transacao_id);
    if (!tx) return { error: 'not_found' };
    if (!ctx.scope.entidades.includes(tx.entidade_id)) return { error: 'forbidden' };
    if (tx.status === 'cancelada') {
      // Idempotent no-op — repeat call returns success without re-auditing.
      return { ok: true as const, transacao_id: tx.id };
    }
    await transacoesRepo.update(tx.id, {
      status: 'cancelada',
      updated_at: new Date(),
    });
    await audit({
      acao: 'transaction_cancelled',
      pessoa_id: ctx.pessoa.id,
      conversa_id: ctx.conversa.id,
      mensagem_id: ctx.mensagem_id,
      alvo_id: tx.id,
      metadata: { motivo: args.motivo ?? null },
    });
    return { ok: true as const, transacao_id: tx.id };
  },
};
```

**Note**: `transacoesRepo.byId` and `transacoesRepo.update` may not exist on the current repo. Verify before implementing — if missing, add them as one-liners alongside the existing `transacoesRepo.byScope`. Add to Task 4 implementation if needed:

```typescript
async byId(id: string): Promise<Transacao | null> {
  const rows = await db.select().from(transacoes).where(eq(transacoes.id, id)).limit(1);
  return rows[0] ?? null;
},
async update(id: string, patch: Partial<Transacao>): Promise<void> {
  await db.update(transacoes).set(patch).where(eq(transacoes.id, id));
},
```

- [ ] **Step 3: Run + commit**

```bash
npx vitest run tests/unit/cancel-transaction.spec.ts
npx tsc --noEmit
git add src/tools/cancel-transaction.ts tests/unit/cancel-transaction.spec.ts src/db/repositories.ts
git commit -m "feat(b2): cancel_transaction tool (scope-checked, idempotent)"
```

---

## Task 5: Register `cancel_transaction`

**Files:** `src/tools/_registry.ts`

- [ ] **Step 1: Import + register**

Add the import alongside other tool imports:

```typescript
import { cancelTransactionTool } from './cancel-transaction.js';
```

Inside the `REGISTRY` literal, add (alphabetised near `register_transaction`):

```typescript
cancel_transaction: cancelTransactionTool as unknown as AnyTool,
```

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/tools/_registry.ts
git commit -m "feat(b2): register cancel_transaction in tool registry"
```

---

## Task 6: Persist `remote_jid` on outbound rows

**Files:** `src/agent/core.ts`

Two one-line additions. `jid` is already in scope at both call sites.

- [ ] **Step 1: Update `sendOutbound`**

Find the `metadata` literal inside `sendOutbound`:

```typescript
metadata: { whatsapp_id: wid, in_reply_to },
```

Replace with:

```typescript
metadata: { whatsapp_id: wid, remote_jid: jid, in_reply_to },
```

If the function also writes `pending_question_id` (introduced by B0/B1), preserve that. Concretely the merged shape is:

```typescript
const metadata: Record<string, unknown> = { whatsapp_id: wid, remote_jid: jid, in_reply_to };
if (opts?.pending_question_id) metadata.pending_question_id = opts.pending_question_id;
```

- [ ] **Step 2: Update `sendOutboundPoll`**

Find the `metadata` literal inside `sendOutboundPoll`:

```typescript
metadata: {
  whatsapp_id: sent.whatsapp_id,
  in_reply_to,
  pending_question_id: pending.id,
  poll_options: pending.opcoes_validas,
  poll_message_secret: sent.message_secret,
},
```

Add `remote_jid: jid`:

```typescript
metadata: {
  whatsapp_id: sent.whatsapp_id,
  remote_jid: jid,
  in_reply_to,
  pending_question_id: pending.id,
  poll_options: pending.opcoes_validas,
  poll_message_secret: sent.message_secret,
},
```

- [ ] **Step 3: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/agent/core.ts
git commit -m "feat(b2): persist remote_jid on outbound mensagens (enables quote-back)"
```

---

## Task 7: TDD — `routeMessageUpdate` (no side-effect path)

**Files:**
- Create: `src/agent/message-update.ts`
- Create: `tests/unit/message-update.spec.ts`

We build the module in 2 passes: this task does the no-side-effect branch (audit only), Task 8 adds the side-effect branch (`edit_review` pending creation).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/message-update.spec.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findByWhatsappIdMock = vi.fn();
const auditLogQueryMock = vi.fn();
vi.mock('../../src/db/repositories.js', () => ({
  mensagensRepo: { findByWhatsappId: findByWhatsappIdMock },
  auditRepo: { findByMensagemId: auditLogQueryMock },
}));

const auditMock = vi.fn();
vi.mock('../../src/governance/audit.js', () => ({ audit: auditMock }));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  findByWhatsappIdMock.mockReset();
  auditLogQueryMock.mockReset();
  auditMock.mockReset();
});

describe('routeMessageUpdate — edit, no side-effect', () => {
  it('audits mensagem_edited with diff when no side-effect found', async () => {
    findByWhatsappIdMock.mockResolvedValueOnce({
      id: 'm-orig',
      conteudo: 'lança 50 mercado',
    });
    auditLogQueryMock.mockResolvedValueOnce([]); // no side-effect rows
    const { routeMessageUpdate } = await import('../../src/agent/message-update.js');
    await routeMessageUpdate({
      key: { id: 'WAID-1', remoteJid: 'jid' },
      message: {
        editedMessage: {
          message: { conversation: 'lança 50 mercados' },
        },
      },
    } as never);
    const edited = auditMock.mock.calls.filter((c) => c[0].acao === 'mensagem_edited');
    expect(edited).toHaveLength(1);
    expect(edited[0][0].diff).toEqual({ before: 'lança 50 mercado', after: 'lança 50 mercados' });
  });

  it('returns silently when original mensagem not found', async () => {
    findByWhatsappIdMock.mockResolvedValueOnce(null);
    const { routeMessageUpdate } = await import('../../src/agent/message-update.js');
    await routeMessageUpdate({
      key: { id: 'WAID-unknown', remoteJid: 'jid' },
      message: {
        editedMessage: { message: { conversation: 'foo' } },
      },
    } as never);
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe('routeMessageUpdate — revoke, no side-effect', () => {
  it('audits mensagem_revoked when revoke target had no side-effect', async () => {
    findByWhatsappIdMock.mockResolvedValueOnce({
      id: 'm-orig',
      conteudo: 'qq texto',
    });
    auditLogQueryMock.mockResolvedValueOnce([]);
    const { routeMessageUpdate } = await import('../../src/agent/message-update.js');
    await routeMessageUpdate({
      key: { id: 'WAID-revoke-msg', remoteJid: 'jid' },
      message: {
        protocolMessage: {
          type: 0, // REVOKE
          key: { id: 'WAID-target', remoteJid: 'jid' },
        },
      },
    } as never);
    const rev = auditMock.mock.calls.filter((c) => c[0].acao === 'mensagem_revoked');
    expect(rev).toHaveLength(1);
  });
});

describe('routeMessageUpdate — irrelevant updates', () => {
  it('ignores updates without editedMessage or protocolMessage (e.g., read receipts)', async () => {
    const { routeMessageUpdate } = await import('../../src/agent/message-update.js');
    await routeMessageUpdate({
      key: { id: 'WAID-x', remoteJid: 'jid' },
      message: { reactionMessage: { text: '👍' } },
    } as never);
    expect(findByWhatsappIdMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });
});
```

Run: must FAIL.

- [ ] **Step 2: Implement (no-side-effect branch only)**

First, add `auditRepo.findByMensagemId` to `src/db/repositories.ts` (find `auditRepo` block; if absent, create one near `audit_log` imports):

```typescript
async findByMensagemId(mensagem_id: string): Promise<AuditEntry[]> {
  return db
    .select()
    .from(audit_log)
    .where(eq(audit_log.mensagem_id, mensagem_id));
},
```

Then create `src/agent/message-update.ts`:

```typescript
import type { proto } from '@whiskeysockets/baileys';
import { logger } from '@/lib/logger.js';
import { mensagensRepo, auditRepo } from '@/db/repositories.js';
import { audit } from '@/governance/audit.js';

const SIDE_EFFECT_ACTIONS = new Set([
  'transaction_created',
  'transaction_corrected',
  'transaction_cancelled',
  'pending_action_dispatched',
]);

/**
 * Single entry point for Baileys `messages.update` events. Unwraps the
 * envelope and dispatches:
 *   - editedMessage         → handleMessageEdit
 *   - protocolMessage type=0 → handleMessageRevoke (REVOKE)
 *   - anything else (read receipts, status updates) → ignored
 */
export async function routeMessageUpdate(update: proto.IWebMessageInfo): Promise<void> {
  if (!update.key?.id) return;
  const m = update.message;
  if (!m) return;

  const edited = m.editedMessage?.message;
  if (edited) {
    const new_conteudo = edited.conversation ?? edited.extendedTextMessage?.text ?? null;
    if (typeof new_conteudo === 'string') {
      await handleMessageEdit({ whatsapp_id: update.key.id, new_conteudo });
    }
    return;
  }

  const proto_msg = m.protocolMessage;
  if (proto_msg && proto_msg.type === 0 && proto_msg.key?.id) {
    await handleMessageRevoke({
      whatsapp_id: proto_msg.key.id,
      revoked_by_jid: update.key.remoteJid ?? '',
    });
    return;
  }
}

async function handleMessageEdit(input: {
  whatsapp_id: string;
  new_conteudo: string;
}): Promise<void> {
  const original = await mensagensRepo.findByWhatsappId(input.whatsapp_id);
  if (!original) {
    logger.debug({ whatsapp_id: input.whatsapp_id }, 'message_update.edit_unknown_original');
    return;
  }
  const sideEffects = await detectSideEffects(original.id);
  if (sideEffects.length === 0) {
    await audit({
      acao: 'mensagem_edited',
      mensagem_id: original.id,
      diff: { before: original.conteudo ?? null, after: input.new_conteudo },
    });
    return;
  }
  // Side-effect path implemented in Task 8.
  await audit({
    acao: 'mensagem_edited_after_side_effect',
    mensagem_id: original.id,
    diff: { before: original.conteudo ?? null, after: input.new_conteudo },
    metadata: { side_effect_count: sideEffects.length },
  });
}

async function handleMessageRevoke(input: {
  whatsapp_id: string;
  revoked_by_jid: string;
}): Promise<void> {
  const original = await mensagensRepo.findByWhatsappId(input.whatsapp_id);
  if (!original) {
    logger.debug({ whatsapp_id: input.whatsapp_id }, 'message_update.revoke_unknown_original');
    return;
  }
  const sideEffects = await detectSideEffects(original.id);
  if (sideEffects.length === 0) {
    await audit({
      acao: 'mensagem_revoked',
      mensagem_id: original.id,
      metadata: { revoked_by_jid: input.revoked_by_jid },
    });
    return;
  }
  await audit({
    acao: 'mensagem_revoked_after_side_effect',
    mensagem_id: original.id,
    metadata: { side_effect_count: sideEffects.length, revoked_by_jid: input.revoked_by_jid },
  });
}

async function detectSideEffects(mensagem_id: string): Promise<Array<{ acao: string; alvo_id: string | null }>> {
  const rows = await auditRepo.findByMensagemId(mensagem_id);
  return rows
    .filter((r) => SIDE_EFFECT_ACTIONS.has(r.acao))
    .map((r) => ({ acao: r.acao, alvo_id: r.alvo_id }));
}
```

- [ ] **Step 3: Run + commit**

```bash
npx vitest run tests/unit/message-update.spec.ts
npx tsc --noEmit
git add src/agent/message-update.ts tests/unit/message-update.spec.ts src/db/repositories.ts
git commit -m "feat(b2): routeMessageUpdate skeleton + no-side-effect audit path"
```

---

## Task 8: TDD — side-effect path creates `edit_review` pending

**Files:**
- Modify: `src/agent/message-update.ts`
- Modify: `tests/unit/message-update.spec.ts`

- [ ] **Step 1: Append tests**

```typescript
describe('routeMessageUpdate — side-effect detected', () => {
  beforeEach(() => {
    findByWhatsappIdMock.mockReset();
    auditLogQueryMock.mockReset();
    auditMock.mockReset();
  });

  it('creates edit_review pending and audits both pending_substituted_by_edit_review and mensagem_edited_after_side_effect', async () => {
    findByWhatsappIdMock.mockResolvedValueOnce({
      id: 'm-orig',
      conteudo: 'lança 50 mercado',
      conversa_id: 'c-owner', // owner's conversa
    });
    auditLogQueryMock.mockResolvedValueOnce([
      { acao: 'transaction_created', alvo_id: 'tx-1', mensagem_id: 'm-orig' },
    ]);
    const ownerConversaMock = vi.fn().mockResolvedValueOnce({ id: 'c-owner', pessoa_id: 'owner-id' });
    pendingQuestionsCreateTxMock.mockResolvedValueOnce({ id: 'pq-edit-review' });
    pendingQuestionsCancelOpenForConversaTxMock.mockResolvedValueOnce({ cancelled_ids: ['pq-old'] });
    // Inject mocks via the same vi.mock at top of file (extend setup).
    const { routeMessageUpdate } = await import('../../src/agent/message-update.js');
    await routeMessageUpdate({
      key: { id: 'WAID-1', remoteJid: 'jid' },
      message: { editedMessage: { message: { conversation: 'lança 50 restaurante' } } },
    } as never);
    expect(pendingQuestionsCreateTxMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tipo: 'edit_review',
        acao_proposta: { tool: 'cancel_transaction', args: { transacao_id: 'tx-1' } },
      }),
    );
    expect(auditMock.mock.calls.some((c) => c[0].acao === 'mensagem_edited_after_side_effect')).toBe(true);
    expect(auditMock.mock.calls.some((c) => c[0].acao === 'pending_substituted_by_edit_review')).toBe(true);
  });
});
```

(You'll need to add `pendingQuestionsRepo.createTx` and `cancelOpenForConversaTx` to the top-of-file `vi.mock`.)

Run — must FAIL.

- [ ] **Step 2: Implement side-effect branch**

Replace the no-op side-effect branch in `handleMessageEdit` with a real implementation that creates the pending. Same pattern for `handleMessageRevoke`. Extract the common path into a helper `createEditReviewPending`:

```typescript
import { withTx } from '@/db/client.js';
import { pendingQuestionsRepo } from '@/db/repositories.js';
import { config } from '@/config/env.js';

const REVIEW_TTL_HOURS = 24;

async function createEditReviewPending(input: {
  original: { id: string; conversa_id: string | null };
  side_effects: Array<{ acao: string; alvo_id: string | null }>;
  pessoa_id: string;
  source: 'edit' | 'revoke';
  diff?: { before: string | null; after: string };
}): Promise<void> {
  if (!input.original.conversa_id) return;
  // Take the first transaction-related side-effect; ignore others.
  const tx_audit = input.side_effects.find((e) =>
    ['transaction_created', 'transaction_corrected'].includes(e.acao),
  );
  if (!tx_audit?.alvo_id) return; // unusual: side-effect without alvo_id

  const verb = input.source === 'edit' ? 'editou' : 'deletou';
  const expira_em = new Date(Date.now() + REVIEW_TTL_HOURS * 60 * 60 * 1000);

  await withTx(async (tx) => {
    const cancelled = await pendingQuestionsRepo.cancelOpenForConversaTx(
      tx,
      input.original.conversa_id!,
      'replaced_by_edit_review',
    );
    if (cancelled.cancelled_ids.length > 0) {
      await audit({
        acao: 'pending_substituted_by_edit_review',
        conversa_id: input.original.conversa_id!,
        mensagem_id: input.original.id,
        metadata: { cancelled_ids: cancelled.cancelled_ids },
      });
    }
    await pendingQuestionsRepo.createTx(tx, {
      conversa_id: input.original.conversa_id!,
      pessoa_id: input.pessoa_id,
      tipo: 'edit_review',
      pergunta: `Você ${verb} uma mensagem que virou transação. Quer cancelar?`,
      opcoes_validas: [
        { key: 'sim', label: 'Sim, cancela' },
        { key: 'nao', label: 'Não, mantém' },
      ],
      acao_proposta: {
        tool: 'cancel_transaction',
        args: { transacao_id: tx_audit.alvo_id, motivo: input.source === 'edit' ? 'edit_review' : 'revoke_review' },
      },
      expira_em,
      status: 'aberta',
      metadata: {
        source: 'edit_review',
        original_mensagem_id: input.original.id,
        original_diff: input.diff ?? null,
      },
    });
  });
}
```

Then in `handleMessageEdit`'s side-effect branch, after the existing `mensagem_edited_after_side_effect` audit:

```typescript
if (config.FEATURE_MESSAGE_UPDATE) {
  await createEditReviewPending({
    original,
    side_effects: sideEffects,
    pessoa_id: original.pessoa_id_owner ?? '', // see note below
    source: 'edit',
    diff: { before: original.conteudo ?? null, after: input.new_conteudo },
  });
}
```

**`pessoa_id_owner` note**: The pending must be addressed to the **owner**, not necessarily the message author. Look up via `config.OWNER_TELEFONE_WHATSAPP` → `pessoasRepo.findByPhone` once at the top of `createEditReviewPending`. Cache the result for the duration of the call. (If the owner isn't found, log + return without creating the pending.)

Replace the placeholder above with:

```typescript
import { pessoasRepo } from '@/db/repositories.js';
// at top
const owner = await pessoasRepo.findByPhone(config.OWNER_TELEFONE_WHATSAPP);
if (!owner) {
  logger.warn('message_update.no_owner_skipping_review');
  return;
}
const ownerConversa = await conversasRepo.findActive(owner.id);
if (!ownerConversa) {
  logger.warn('message_update.no_owner_conversa_skipping_review');
  return;
}
// then pass ownerConversa.id to the pending create.
```

Restructure as you see fit; the key contract is: the pending lands in the owner's conversa, not the editing user's.

- [ ] **Step 3: Run + commit**

```bash
npx vitest run tests/unit/message-update.spec.ts
npx tsc --noEmit
git add src/agent/message-update.ts tests/unit/message-update.spec.ts
git commit -m "feat(b2): edit_review pending creation when side-effect detected"
```

---

## Task 9: Wire `messages.update` listener in `baileys.ts`

**Files:** `src/gateway/baileys.ts`

- [ ] **Step 1: Add import**

```typescript
import { routeMessageUpdate } from '@/agent/message-update.js';
```

- [ ] **Step 2: Register the listener**

Inside `startBaileys`, after the existing `socket.ev.on('messages.upsert', ...)` block, add:

```typescript
socket.ev.on('messages.update', async (updates) => {
  if (!config.FEATURE_MESSAGE_UPDATE) return;
  for (const update of updates) {
    try {
      // Baileys delivers `update` as `{ key, update: Partial<WAMessageInfo> }`.
      // We pass a synthesised IWebMessageInfo whose `message` is the `update`
      // payload so routeMessageUpdate can branch on editedMessage / protocolMessage.
      await routeMessageUpdate({ key: update.key, message: update.update.message } as never);
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'message_update.dispatch_failed');
    }
  }
});
```

**Important**: verify the Baileys 6.7.0 event payload shape before merging — the wrapping `{ key, update }` matters. The `as never` cast is intentional since Baileys' `update` type is a `Partial<WAMessageInfo>`, not the full shape `routeMessageUpdate` accepts. The runtime structure is what matters.

- [ ] **Step 3: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/gateway/baileys.ts
git commit -m "feat(b2): wire messages.update listener (gated by FEATURE_MESSAGE_UPDATE)"
```

---

## Task 10: TDD — `pending-reminder` worker (happy path + skip branches)

**Files:**
- Create: `src/workers/pending-reminder.ts`
- Create: `tests/unit/pending-reminder.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbExecuteMock = vi.fn();
const dbUpdateChain = {
  set: vi.fn().mockReturnThis(),
  where: vi.fn().mockResolvedValue(undefined),
};
vi.mock('../../src/db/client.js', () => ({
  db: {
    execute: dbExecuteMock,
    update: vi.fn().mockReturnValue(dbUpdateChain),
  },
}));

const sendOutboundTextMock = vi.fn().mockResolvedValue('WAID-REMINDER');
vi.mock('../../src/gateway/baileys.js', () => ({
  sendOutboundText: sendOutboundTextMock,
  isBaileysConnected: () => true,
}));

const auditMock = vi.fn();
vi.mock('../../src/governance/audit.js', () => ({ audit: auditMock }));

vi.mock('../../src/config/env.js', () => ({
  config: { FEATURE_PENDING_REMINDER: true, OWNER_TELEFONE_WHATSAPP: '+5511999999999' },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  dbExecuteMock.mockReset();
  dbUpdateChain.set.mockClear();
  dbUpdateChain.where.mockClear();
  sendOutboundTextMock.mockClear();
  auditMock.mockReset();
});

describe('pending-reminder worker', () => {
  it('sends a quoted reminder for pending older than 1h with no prior reminder', async () => {
    dbExecuteMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'pq-1',
          tipo: 'gate',
          pergunta: 'Confirma?',
          telefone_whatsapp: '+5511988888888',
          outbound_metadata: {
            whatsapp_id: 'WAID-Q',
            remote_jid: '5511988888888@s.whatsapp.net',
          },
          metadata: {},
        },
      ],
    });
    const { runPendingReminder } = await import('../../src/workers/pending-reminder.js');
    await runPendingReminder();
    expect(sendOutboundTextMock).toHaveBeenCalledWith(
      '5511988888888@s.whatsapp.net',
      expect.stringContaining('Lembra'),
      expect.objectContaining({
        quoted: expect.objectContaining({
          key: expect.objectContaining({ id: 'WAID-Q' }),
        }),
      }),
    );
    const sent = auditMock.mock.calls.filter((c) => c[0].acao === 'pending_reminder_sent');
    expect(sent).toHaveLength(1);
  });

  it('FEATURE_PENDING_REMINDER=false → no-op (no DB scan)', async () => {
    vi.resetModules();
    vi.doMock('../../src/config/env.js', () => ({
      config: { FEATURE_PENDING_REMINDER: false, OWNER_TELEFONE_WHATSAPP: '+5511999999999' },
    }));
    const { runPendingReminder } = await import('../../src/workers/pending-reminder.js');
    await runPendingReminder();
    expect(dbExecuteMock).not.toHaveBeenCalled();
  });

  it('skips with audit when no outbound parent found', async () => {
    dbExecuteMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'pq-2',
          tipo: 'gate',
          pergunta: 'Confirma?',
          telefone_whatsapp: '+5511988888888',
          outbound_metadata: null,
          metadata: {},
        },
      ],
    });
    const { runPendingReminder } = await import('../../src/workers/pending-reminder.js');
    await runPendingReminder();
    expect(sendOutboundTextMock).not.toHaveBeenCalled();
    const skipped = auditMock.mock.calls.filter(
      (c) => c[0].acao === 'pending_reminder_skipped_no_outbound',
    );
    expect(skipped).toHaveLength(1);
  });

  it('updates last_reminder_at BEFORE send (crash-during-send guarantee)', async () => {
    dbExecuteMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'pq-3',
          tipo: 'gate',
          pergunta: 'Confirma?',
          telefone_whatsapp: '+5511988888888',
          outbound_metadata: {
            whatsapp_id: 'WAID-Q',
            remote_jid: '5511988888888@s.whatsapp.net',
          },
          metadata: {},
        },
      ],
    });
    // Make send fail; the prior metadata update must already have happened.
    sendOutboundTextMock.mockRejectedValueOnce(new Error('whatsapp down'));
    const { runPendingReminder } = await import('../../src/workers/pending-reminder.js');
    await runPendingReminder();
    // The update happened before the (failed) send.
    expect(dbUpdateChain.set).toHaveBeenCalled();
    // And the failure was logged but not re-thrown.
  });
});
```

Run: must FAIL.

- [ ] **Step 2: Implement**

Create `src/workers/pending-reminder.ts`:

```typescript
import { sql } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { pending_questions } from '@/db/schema.js';
import { eq } from 'drizzle-orm';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { sendOutboundText, isBaileysConnected } from '@/gateway/baileys.js';
import { audit } from '@/governance/audit.js';
import { quotedReplyContext } from '@/gateway/presence.js';

const SCAN_LIMIT = 50;
const MAX_REMINDERS = 2;

type Row = {
  id: string;
  tipo: string;
  pergunta: string;
  telefone_whatsapp: string;
  outbound_metadata: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
};

export async function runPendingReminder(): Promise<void> {
  if (!config.FEATURE_PENDING_REMINDER) return;
  if (!isBaileysConnected()) {
    logger.debug('pending_reminder.baileys_disconnected_skip');
    return;
  }

  const result = await db.execute<Row>(sql`
    SELECT
      pq.id,
      pq.tipo,
      pq.pergunta,
      p.telefone_whatsapp,
      m.metadata AS outbound_metadata,
      pq.metadata AS metadata
    FROM pending_questions pq
    JOIN pessoas p ON p.id = pq.pessoa_id
    LEFT JOIN mensagens m
      ON m.direcao = 'out'
     AND (m.metadata->>'pending_question_id') = pq.id::text
    WHERE pq.status = 'aberta'
      AND pq.expira_em > now()
      AND pq.tipo != 'edit_review'
      AND pq.created_at < now() - interval '1 hour'
      AND COALESCE((pq.metadata->>'reminder_count')::int, 0) < ${MAX_REMINDERS}
      AND (
        pq.metadata->>'last_reminder_at' IS NULL
        OR (pq.metadata->>'last_reminder_at')::timestamptz < now() - interval '1 hour'
      )
    ORDER BY pq.created_at ASC
    LIMIT ${SCAN_LIMIT}
  `);

  for (const row of result.rows) {
    await processOne(row).catch((err) =>
      logger.warn({ err: (err as Error).message, pq_id: row.id }, 'pending_reminder.row_failed'),
    );
  }
}

async function processOne(row: Row): Promise<void> {
  if (!row.outbound_metadata) {
    await audit({
      acao: 'pending_reminder_skipped_no_outbound',
      alvo_id: row.id,
      metadata: { tipo: row.tipo },
    });
    return;
  }

  const quoted = quotedReplyContext(row.outbound_metadata, row.pergunta);
  if (!quoted) {
    await audit({
      acao: 'pending_reminder_skipped_no_outbound',
      alvo_id: row.id,
      metadata: { reason: 'invalid_metadata' },
    });
    return;
  }

  // Update last_reminder_at + reminder_count BEFORE send (idempotency: never
  // double-send). On send failure the timestamp is already advanced.
  const newCount = ((row.metadata.reminder_count as number | undefined) ?? 0) + 1;
  const newMeta = {
    ...row.metadata,
    last_reminder_at: new Date().toISOString(),
    reminder_count: newCount,
  };
  await db
    .update(pending_questions)
    .set({ metadata: newMeta })
    .where(eq(pending_questions.id, row.id));

  const jid = quoted.key.remoteJid;
  try {
    await sendOutboundText(jid, 'Lembra dessa? Tô aguardando.', { quoted });
    await audit({
      acao: 'pending_reminder_sent',
      alvo_id: row.id,
      metadata: { reminder_count: newCount },
    });
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, pq_id: row.id },
      'pending_reminder.send_failed',
    );
    // No re-throw; the next tick within 1h will see last_reminder_at set
    // and emit pending_reminder_skipped_already_marked.
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
npx vitest run tests/unit/pending-reminder.spec.ts
npx tsc --noEmit
git add src/workers/pending-reminder.ts tests/unit/pending-reminder.spec.ts
git commit -m "feat(b2): pending-reminder worker (quoted nudge, idempotent)"
```

---

## Task 11: Register the worker in cron registry

**Files:** `src/workers/index.ts`

- [ ] **Step 1: Import + register**

Find the `JOBS` array. Append (alphabetised):

```typescript
import { runPendingReminder } from './pending-reminder.js';

// inside JOBS:
{ name: 'pending_reminder', cron: '*/30 * * * *', fn: runPendingReminder, phase: 1 },
```

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/workers/index.ts
git commit -m "feat(b2): register pending_reminder cron in worker registry"
```

---

## Task 12: Cross-task gate — full unit suite + push + open PR

**Files:** none modified.

- [ ] **Step 1: Full unit suite**

```bash
npx vitest run tests/unit
```

Expected: all relevant new tests pass; pre-existing module-load failures unchanged.

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: only the 3 pre-existing errors (`db/client.ts:24`, `gateway/queue.ts:31`, `lib/alerts.ts:32`).

- [ ] **Step 3: Push + open PR**

```bash
git push -u origin feat/whatsapp-b2-update-quote
gh pr create --base main \
  --title "feat(b2): message updates + outbound quoting + reminders + cancel_transaction" \
  --body "Implements docs/superpowers/specs/2026-04-29-whatsapp-b2-update-quote-design.md. Builds on B1 (PR #15, merged). Gated behind FEATURE_MESSAGE_UPDATE=false and FEATURE_PENDING_REMINDER=false."
```

---

## Acceptance verification (mirrors spec §12)

- [ ] **Migration 005 applies**: idx_audit_mensagem partial index created (Task 3).
- [ ] **`cancel_transaction` tool**: registered, refuses out-of-scope `transacao_id`, idempotent on re-call (Tasks 4-5).
- [ ] **Outbound `remote_jid`**: `sendOutbound` and `sendOutboundPoll` persist `metadata.remote_jid` (Task 6).
- [ ] **`FEATURE_MESSAGE_UPDATE=true`** + edit with side-effect → `edit_review` pending created for owner with `cancel_transaction` action; audit `mensagem_edited_after_side_effect` (Tasks 7-8).
- [ ] **`FEATURE_MESSAGE_UPDATE=true`** + edit without side-effect → only `mensagem_edited` audit (Tasks 7-8).
- [ ] **`FEATURE_MESSAGE_UPDATE=true`** + revoke (`protocolMessage.type === 0`) → analogous behaviour (Tasks 7-8).
- [ ] **`FEATURE_MESSAGE_UPDATE=false`** → listener is a no-op (Task 9).
- [ ] **Owner answers `edit_review` pending with "sim"** → `cancel_transaction` dispatches via `resolveAndDispatch`; transaction `status='cancelada'` (Tasks 4, 8 + B0/B1 dispatch).
- [ ] **`FEATURE_PENDING_REMINDER=true`** + 1h-old pending without prior reminder → reminder sent; metadata updated; audit `pending_reminder_sent` (Tasks 10-11).
- [ ] **`reminder_count = 2`** → not reminded again (Tasks 10-11).
- [ ] **`tipo = 'edit_review'`** → never reminded (Task 10 SQL filter).
- [ ] **`FEATURE_PENDING_REMINDER=false`** → worker no-op (Task 10).
- [ ] **Crash during send**: `last_reminder_at` already set; next tick emits `pending_reminder_skipped_already_marked` and does not re-send (Task 10 fault-injection test).
- [ ] **Substitution visibility**: `pending_substituted_by_edit_review` audit fires when an unrelated open pending is clobbered (Task 8).
- [ ] **Quote in reminder**: mock socket receives `{ quoted: { key: { id: <original_wid>, remoteJid: <jid>, fromMe: false }, message: { conversation: <truncated original pergunta> } } }` (Task 10 test).
