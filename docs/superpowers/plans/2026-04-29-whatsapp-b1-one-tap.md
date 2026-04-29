# WhatsApp B1 — One-Tap Resolution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve `pending_questions` with a single emoji reaction or poll vote, reusing B0's transactional resolve. Both paths funnel through a shared `resolveAndDispatch` helper extracted from B0's gate.

**Architecture:** Refactor first (extract `resolveAndDispatch` from `pending-gate.ts` and absorb the dispatch that today lives in `core.ts`). Add `sendOutboundPoll` for 3–12-option pendings. Add gateway prefix branches for `pollUpdateMessage` and reaction stubs that map deterministically to the same helper. Feature-flagged `FEATURE_ONE_TAP=false`.

**Tech Stack:** TypeScript, `@whiskeysockets/baileys` (poll API + `decryptPollVote`), Drizzle, vitest.

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `src/config/env.ts` | Modify | `FEATURE_ONE_TAP` flag (default `false`) |
| `src/governance/audit-actions.ts` | Modify | 5 new actions |
| `src/db/repositories.ts` | Modify | Add `conversasRepo.byId(id)` |
| `src/agent/pending-resolver.ts` | Create | `resolveAndDispatch` — tx + dispatch + audit, source-attributed |
| `src/agent/pending-gate.ts` | Modify | Replace inline `applyTx` with call to `resolveAndDispatch`; gate result no longer carries action |
| `src/agent/core.ts` | Modify | Drop the gate-path `dispatchTool` (now done by helper); enrich `latestPendingId` capture; branch to poll send |
| `src/tools/ask-pending-question.ts` | Modify | Output schema enriched with `opcoes_count` and `opcoes_validas` |
| `src/gateway/presence.ts` | Modify | Add `sendPoll` |
| `src/agent/one-tap.ts` | Create | `dispatchPollVote` + `dispatchReactionAsAnswer` |
| `src/gateway/baileys.ts` | Modify | Prefix branches in `handleIncoming`: `pollUpdateMessage`, reaction-stub-as-answer |
| `tests/unit/pending-resolver.spec.ts` | Create | Helper tests (race-loss, dispatch, audit) |
| `tests/unit/pending-gate.spec.ts` | Modify | Update mocks (helper instead of `dispatchTool`) |
| `tests/unit/one-tap-reaction.spec.ts` | Create | Reaction → handler tests |
| `tests/unit/one-tap-poll.spec.ts` | Create | Poll-vote → handler tests (mock `decryptPollVote`) |
| `tests/unit/ask-pending-question.spec.ts` | Modify | Assert new output fields |

No DB migrations.

---

## Task 1: `FEATURE_ONE_TAP` config flag

**Files:** `src/config/env.ts`

- [ ] **Step 1:** Append alongside other `FEATURE_*` entries:

```typescript
FEATURE_ONE_TAP: z
  .string()
  .default('false')
  .transform((s) => s === 'true' || s === '1'),
```

- [ ] **Step 2:** `npx tsc --noEmit` — only the 3 pre-existing errors remain (`db/client.ts:24`, `gateway/queue.ts:31`, `lib/alerts.ts:32` nodemailer).
- [ ] **Step 3:** Commit
```bash
git add src/config/env.ts
git commit -m "feat(b1): FEATURE_ONE_TAP env flag"
```

---

## Task 2: Append 5 audit actions

**Files:** `src/governance/audit-actions.ts`

- [ ] **Step 1:** Append to `AUDIT_ACTIONS`:

```typescript
'pending_resolved_by_reaction',
'pending_resolved_by_poll',
'reaction_ignored_unmapped_emoji',
'one_tap_no_pending_anchor',
'one_tap_dispatch_error',
```

- [ ] **Step 2:** Typecheck + commit
```bash
git add src/governance/audit-actions.ts
git commit -m "feat(b1): audit actions for one-tap resolution"
```

---

## Task 3: Add `conversasRepo.byId`

**Files:** `src/db/repositories.ts`

- [ ] **Step 1:** Inside `conversasRepo`, after `findActive`:

```typescript
async byId(id: string): Promise<Conversa | null> {
  const rows = await db.select().from(conversas).where(eq(conversas.id, id)).limit(1);
  return rows[0] ?? null;
},
```

- [ ] **Step 2:** Typecheck + commit
```bash
git add src/db/repositories.ts
git commit -m "feat(b1): conversasRepo.byId"
```

---

## Task 4: TDD — extract `resolveAndDispatch` helper

This is the core refactor: B0's `applyTx` (private in `pending-gate.ts`) plus the dispatch+audit currently in `core.ts:128-145` consolidate into one function.

**Files:**
- Create: `src/agent/pending-resolver.ts`
- Create: `tests/unit/pending-resolver.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/pending-resolver.spec.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findActiveForUpdate = vi.fn();
const resolveTx = vi.fn();
vi.mock('../../src/db/repositories.js', () => ({
  pendingQuestionsRepo: { findActiveForUpdate, resolveTx },
}));

const withTx = vi.fn(async (fn) => fn({} as never));
vi.mock('../../src/db/client.js', () => ({ withTx, db: {} as never }));

const dispatchTool = vi.fn();
vi.mock('../../src/tools/_dispatcher.js', () => ({ dispatchTool }));

const resolveScope = vi.fn().mockResolvedValue({ entidades: [], byEntity: new Map() });
vi.mock('../../src/governance/permissions.js', () => ({ resolveScope }));

const audit = vi.fn();
vi.mock('../../src/governance/audit.js', () => ({ audit }));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const pessoa = { id: 'p1' } as never;
const conversa = { id: 'c1' } as never;

beforeEach(() => {
  findActiveForUpdate.mockReset();
  resolveTx.mockReset();
  dispatchTool.mockReset();
  audit.mockReset();
});

describe('resolveAndDispatch', () => {
  it('resolves, audits source, and dispatches the action', async () => {
    findActiveForUpdate.mockResolvedValueOnce({
      id: 'pq-1',
      acao_proposta: { tool: 'register_transaction', args: { valor: 50 } },
    });
    resolveTx.mockResolvedValueOnce(undefined);
    const { resolveAndDispatch } = await import('../../src/agent/pending-resolver.js');
    const out = await resolveAndDispatch({
      pessoa,
      conversa,
      mensagem_id: 'm1',
      expected_pending_id: 'pq-1',
      option_chosen: 'sim',
      confidence: 1.0,
      source: 'reaction',
    });
    expect(out).toEqual({ resolved: true, action_tool: 'register_transaction' });
    expect(resolveTx).toHaveBeenCalledWith(expect.anything(), 'pq-1', expect.objectContaining({
      option_chosen: 'sim',
    }));
    expect(audit.mock.calls.some((c) => c[0].acao === 'pending_resolved_by_reaction')).toBe(true);
    expect(audit.mock.calls.some((c) => c[0].acao === 'pending_action_dispatched')).toBe(true);
    expect(dispatchTool).toHaveBeenCalledTimes(1);
    expect(dispatchTool.mock.calls[0]![0].args).toMatchObject({ valor: 50, _pending_choice: 'sim' });
  });

  it('race-loss: re-check id mismatch → audit pending_race_lost, no dispatch', async () => {
    findActiveForUpdate.mockResolvedValueOnce({ id: 'pq-different', acao_proposta: {} });
    const { resolveAndDispatch } = await import('../../src/agent/pending-resolver.js');
    const out = await resolveAndDispatch({
      pessoa,
      conversa,
      mensagem_id: 'm1',
      expected_pending_id: 'pq-1',
      option_chosen: 'sim',
      confidence: 1.0,
      source: 'reaction',
    });
    expect(out).toEqual({ resolved: false, race_lost: true });
    expect(resolveTx).not.toHaveBeenCalled();
    expect(dispatchTool).not.toHaveBeenCalled();
    expect(audit.mock.calls.some((c) => c[0].acao === 'pending_race_lost')).toBe(true);
  });

  it('source=gate audits pending_resolved_by_gate', async () => {
    findActiveForUpdate.mockResolvedValueOnce({
      id: 'pq-1',
      acao_proposta: { tool: 'register_transaction', args: {} },
    });
    const { resolveAndDispatch } = await import('../../src/agent/pending-resolver.js');
    await resolveAndDispatch({
      pessoa, conversa, mensagem_id: 'm1',
      expected_pending_id: 'pq-1',
      option_chosen: 'sim',
      confidence: 0.8,
      source: 'gate',
    });
    expect(audit.mock.calls.some((c) => c[0].acao === 'pending_resolved_by_gate')).toBe(true);
  });

  it('no action_proposta in row → resolves but no dispatch', async () => {
    findActiveForUpdate.mockResolvedValueOnce({ id: 'pq-1', acao_proposta: {} });
    const { resolveAndDispatch } = await import('../../src/agent/pending-resolver.js');
    const out = await resolveAndDispatch({
      pessoa, conversa, mensagem_id: 'm1',
      expected_pending_id: 'pq-1',
      option_chosen: 'sim',
      confidence: 1.0,
      source: 'poll_vote',
    });
    expect(out.resolved).toBe(true);
    expect(out.action_tool).toBeUndefined();
    expect(dispatchTool).not.toHaveBeenCalled();
    expect(audit.mock.calls.some((c) => c[0].acao === 'pending_resolved_by_poll')).toBe(true);
  });
});
```

Run: `npx vitest run tests/unit/pending-resolver.spec.ts` — must FAIL.

- [ ] **Step 2: Implement**

```typescript
// src/agent/pending-resolver.ts
import { logger } from '@/lib/logger.js';
import { withTx } from '@/db/client.js';
import { pendingQuestionsRepo } from '@/db/repositories.js';
import { audit } from '@/governance/audit.js';
import { dispatchTool } from '@/tools/_dispatcher.js';
import { resolveScope } from '@/governance/permissions.js';
import { uuid } from '@/lib/utils.js';
import type { Pessoa, Conversa } from '@/db/schema.js';

export type ResolveSource = 'gate' | 'reaction' | 'poll_vote';

const SOURCE_TO_AUDIT: Record<ResolveSource, string> = {
  gate: 'pending_resolved_by_gate',
  reaction: 'pending_resolved_by_reaction',
  poll_vote: 'pending_resolved_by_poll',
};

export type ResolveAndDispatchInput = {
  pessoa: Pessoa;
  conversa: Conversa;
  mensagem_id: string;
  expected_pending_id: string;
  option_chosen: string;
  confidence: number;
  source: ResolveSource;
};

export type ResolveAndDispatchOutput =
  | { resolved: true; action_tool?: string }
  | { resolved: false; race_lost: true };

export async function resolveAndDispatch(
  input: ResolveAndDispatchInput,
): Promise<ResolveAndDispatchOutput> {
  type Captured = { action: { tool?: string; args?: Record<string, unknown> } } | { race_lost: true };

  const captured: Captured = await withTx(async (tx): Promise<Captured> => {
    const locked = await pendingQuestionsRepo.findActiveForUpdate(tx, input.conversa.id);
    if (!locked || locked.id !== input.expected_pending_id) {
      await audit({
        acao: 'pending_race_lost',
        pessoa_id: input.pessoa.id,
        conversa_id: input.conversa.id,
        mensagem_id: input.mensagem_id,
        metadata: {
          pending_question_id: input.expected_pending_id,
          source: input.source,
          observed_id: locked?.id ?? null,
        },
      });
      return { race_lost: true };
    }
    await pendingQuestionsRepo.resolveTx(tx, locked.id, {
      option_chosen: input.option_chosen,
      confidence: input.confidence,
      source: input.source,
    });
    await audit({
      acao: SOURCE_TO_AUDIT[input.source] as never,
      pessoa_id: input.pessoa.id,
      conversa_id: input.conversa.id,
      mensagem_id: input.mensagem_id,
      alvo_id: locked.id,
      metadata: { option_chosen: input.option_chosen, confidence: input.confidence },
    });
    return { action: (locked.acao_proposta ?? {}) as { tool?: string; args?: Record<string, unknown> } };
  });

  if ('race_lost' in captured) return { resolved: false, race_lost: true };

  const action = captured.action;
  if (!action.tool) return { resolved: true };

  // Outside the tx: dispatch.
  try {
    const scope = await resolveScope(input.pessoa);
    await dispatchTool({
      tool: action.tool,
      args: { ...(action.args ?? {}), _pending_choice: input.option_chosen },
      ctx: {
        pessoa: input.pessoa,
        scope,
        conversa: input.conversa,
        mensagem_id: input.mensagem_id,
        request_id: uuid(),
      },
    });
    await audit({
      acao: 'pending_action_dispatched',
      pessoa_id: input.pessoa.id,
      conversa_id: input.conversa.id,
      mensagem_id: input.mensagem_id,
      metadata: {
        tool: action.tool,
        pending_question_id: input.expected_pending_id,
        source: input.source,
      },
    });
    return { resolved: true, action_tool: action.tool };
  } catch (err) {
    logger.error(
      { err: (err as Error).message, tool: action.tool, source: input.source },
      'pending_resolver.dispatch_failed',
    );
    return { resolved: true, action_tool: action.tool };
  }
}
```

Run: `npx vitest run tests/unit/pending-resolver.spec.ts` — must PASS.

- [ ] **Step 3: Commit**
```bash
git add src/agent/pending-resolver.ts tests/unit/pending-resolver.spec.ts
git commit -m "feat(b1): resolveAndDispatch helper (extracted from gate)"
```

---

## Task 5: Refactor `pending-gate.ts` to use the helper

**Files:**
- Modify: `src/agent/pending-gate.ts`
- Modify: `tests/unit/pending-gate.spec.ts`

The gate currently does its own `applyTx` + leaves dispatch to core.ts. Now it calls `resolveAndDispatch` and the gate's `GateResult.resolved` carries no action (already dispatched).

- [ ] **Step 1: Update `GateResult`**

```typescript
export type GateResult =
  | { kind: 'no_pending' }
  | { kind: 'resolved' }
  | { kind: 'unresolved'; reason: 'low_confidence' | 'topic_change' | 'cancelled' };
```

- [ ] **Step 2: Replace `applyTx` body with `resolveAndDispatch`**

Replace the entire private `applyTx(...)` function with:

```typescript
import { resolveAndDispatch } from './pending-resolver.js';

async function applyTx(
  snapshot_id: string,
  snapshot: { acao_proposta: unknown; opcoes_validas: unknown },
  resolution: ClassifyOut,
  input: { pessoa: Pessoa; conversa: Conversa; inbound: Mensagem },
): Promise<GateResult> {
  // Topic change / explicit cancellation short-circuit without touching
  // resolveAndDispatch — that helper is for SUCCESSFUL resolutions only.
  // Both reasons cancel the row but keep distinct audit + return values
  // so the caller can react differently if needed.
  if (resolution.is_topic_change || resolution.is_cancellation) {
    const reason = resolution.is_cancellation ? 'cancelled' : 'topic_change';
    const cancel_reason = resolution.is_cancellation ? 'user_cancelled' : 'topic_change';
    const audit_acao =
      resolution.is_cancellation ? 'pending_cancelled' : 'pending_unresolved_topic_change';
    return await withTx(async (tx) => {
      const locked = await pendingQuestionsRepo.findActiveForUpdate(tx, input.conversa.id);
      if (!locked || locked.id !== snapshot_id) return { kind: 'no_pending' };
      await pendingQuestionsRepo.cancelTx(tx, snapshot_id, cancel_reason);
      await audit({
        acao: audit_acao as never,
        pessoa_id: input.pessoa.id,
        conversa_id: input.conversa.id,
        mensagem_id: input.inbound.id,
        alvo_id: snapshot_id,
      });
      return { kind: 'unresolved', reason };
    });
  }

  const opts = snapshot.opcoes_validas as Array<{ key: string; label: string }>;
  const validKeys = new Set(opts.map((o) => o.key));
  const isResolved =
    resolution.resolves_pending &&
    resolution.confidence >= CONFIDENCE_THRESHOLD &&
    typeof resolution.option_chosen === 'string' &&
    validKeys.has(resolution.option_chosen);

  if (!isResolved) {
    await audit({
      acao: 'pending_unresolved_low_confidence',
      pessoa_id: input.pessoa.id,
      conversa_id: input.conversa.id,
      mensagem_id: input.inbound.id,
      alvo_id: snapshot_id,
      metadata: { confidence: resolution.confidence ?? null },
    });
    return { kind: 'unresolved', reason: 'low_confidence' };
  }

  const result = await resolveAndDispatch({
    pessoa: input.pessoa,
    conversa: input.conversa,
    mensagem_id: input.inbound.id,
    expected_pending_id: snapshot_id,
    option_chosen: resolution.option_chosen!,
    confidence: resolution.confidence,
    source: 'gate',
  });

  if (!result.resolved) return { kind: 'no_pending' }; // race lost
  return { kind: 'resolved' };
}
```

- [ ] **Step 3: Update `tests/unit/pending-gate.spec.ts`**

The existing file has 6 tests. Map each to its new behaviour:

| # | Existing test title | What changes |
|---|---|---|
| 1 | "snapshot path → no_pending when no active row" | unchanged (snapshot mock returns null) |
| 2 | "snapshot path → calls Haiku and re-check fails → no_pending" | mock `resolveAndDispatch` to return `{ resolved: false, race_lost: true }` instead of `findActiveForUpdate` returning null |
| 3 | "resolve path → resolves and dispatches" | replace `resolveTx`/`audit` assertions with `resolveAndDispatch.mockResolvedValueOnce({ resolved: true, action_tool: '...' })` and assert `out.kind === 'resolved'` |
| 4 | "resolve path → topic_change cancels" | unchanged (topic-change still bypasses `resolveAndDispatch` and calls `cancelTx` + `audit` directly) |
| 5 | "resolve path → low_confidence audits, no DB write" | unchanged (low-confidence still calls `audit` directly without `resolveAndDispatch`) |
| 6 | "resolve path → race_lost via helper" | drop the `findActiveForUpdate.mockResolvedValueOnce(null)` line; use `resolveAndDispatch.mockResolvedValueOnce({ resolved: false, race_lost: true })` instead |

**Concrete mock setup at the top of the file** (replace `findActiveForUpdate` and `resolveTx` mocks; keep `cancelTx` and `audit` because tests 4 and 5 still use them):

```typescript
const findActiveSnapshot = vi.fn();
const cancelTx = vi.fn();
vi.mock('../../src/db/repositories.js', () => ({
  pendingQuestionsRepo: {
    findActiveSnapshot,
    cancelTx,
    // findActiveForUpdate, resolveTx removed — now lives behind resolveAndDispatch
  },
}));

const resolveAndDispatch = vi.fn();
vi.mock('../../src/agent/pending-resolver.js', () => ({ resolveAndDispatch }));

const audit = vi.fn();
vi.mock('../../src/governance/audit.js', () => ({ audit }));

// callLLM, withTx, classifier mocks unchanged from B0.
```

**Resolve-path test (replaces #3 in the table above):**

```typescript
it('resolves via helper when classify succeeds', async () => {
  findActiveSnapshot.mockResolvedValueOnce({
    id: 'pq-1', pergunta: 'Confirma?',
    opcoes_validas: [{ key: 'sim', label: 'Sim' }, { key: 'nao', label: 'Não' }],
    acao_proposta: { tool: 'register_transaction', args: { valor: 50 } },
  });
  callLLM.mockResolvedValueOnce({
    content: '{"resolves_pending":true,"option_chosen":"sim","confidence":0.95}',
    usage: { input_tokens: 0, output_tokens: 0 }, tool_uses: [], stop_reason: 'end_turn', model: 'haiku',
  });
  resolveAndDispatch.mockResolvedValueOnce({ resolved: true, action_tool: 'register_transaction' });
  const { checkPendingFirst } = await import('../../src/agent/pending-gate.js');
  const out = await checkPendingFirst({ pessoa, conversa, inbound });
  expect(out).toEqual({ kind: 'resolved' });
  expect(resolveAndDispatch).toHaveBeenCalledWith(expect.objectContaining({
    expected_pending_id: 'pq-1',
    option_chosen: 'sim',
    source: 'gate',
  }));
});
```

**Race-loss test (replaces #6 — the `findActiveForUpdate(null)` test):**

```typescript
it('race-loss surfaces from helper as no_pending', async () => {
  findActiveSnapshot.mockResolvedValueOnce({
    id: 'pq-4', pergunta: 'Confirma?',
    opcoes_validas: [{ key: 'sim', label: 'Sim' }, { key: 'nao', label: 'Não' }],
    acao_proposta: {},
  });
  callLLM.mockResolvedValueOnce({
    content: '{"resolves_pending":true,"option_chosen":"sim","confidence":0.95}',
    usage: { input_tokens: 0, output_tokens: 0 }, tool_uses: [], stop_reason: 'end_turn', model: 'haiku',
  });
  resolveAndDispatch.mockResolvedValueOnce({ resolved: false, race_lost: true });
  const { checkPendingFirst } = await import('../../src/agent/pending-gate.js');
  const out = await checkPendingFirst({ pessoa, conversa, inbound });
  expect(out).toEqual({ kind: 'no_pending' });
});
```

Tests #1, #2, #4, #5 keep the same body. Run after the rewrite:

```
npx vitest run tests/unit/pending-gate.spec.ts
```

Expected: 6 green.

- [ ] **Step 4: Verify**

```
npx vitest run tests/unit/pending-gate.spec.ts tests/unit/pending-resolver.spec.ts
npx tsc --noEmit
```

- [ ] **Step 5: Commit**
```bash
git add src/agent/pending-gate.ts tests/unit/pending-gate.spec.ts
git commit -m "refactor(b1): pending-gate uses resolveAndDispatch (no longer dispatches itself)"
```

---

## Task 6: Update `core.ts` — drop the gate-path dispatch

**Files:** `src/agent/core.ts`

- [ ] **Step 1: Find the gate-resolved branch**

Around line 124-150, the current code looks like:

```typescript
const gate = await checkPendingFirst({ pessoa, conversa: c, inbound });
if (gate.kind === 'resolved') {
  if (gate.action) {
    const args = { ...gate.action.args, _pending_choice: gate.option_chosen };
    await dispatchTool({ ... });
    await audit({ acao: 'pending_action_dispatched', ... });
  }
  await mensagensRepo.markProcessed(inbound.id, 0);
  await conversasRepo.touch(c.id);
  return;
}
```

Replace with the simplified version (helper already dispatched):

```typescript
const gate = await checkPendingFirst({ pessoa, conversa: c, inbound });
if (gate.kind === 'resolved') {
  await mensagensRepo.markProcessed(inbound.id, 0);
  await conversasRepo.touch(c.id);
  return;
}
```

- [ ] **Step 2:** Typecheck + commit
```bash
npx tsc --noEmit
git add src/agent/core.ts
git commit -m "refactor(b1): drop gate-path dispatchTool from core.ts"
```

---

## Task 7: Enrich `ask_pending_question` output schema

**Files:** `src/tools/ask-pending-question.ts`, `tests/unit/ask-pending-question.spec.ts`

- [ ] **Step 1: Update output schema**

```typescript
const outputSchema = z.union([
  z.object({
    pending_question_id: z.string(),
    opcoes_count: z.number().int().min(2).max(12),
    opcoes_validas: z.array(z.object({ key: z.string(), label: z.string() })),
  }),
  z.object({ error: z.string() }),
]);
```

- [ ] **Step 2: Update handler return**

Replace `return { pending_question_id: created.id };` with:

```typescript
return {
  pending_question_id: created.id,
  opcoes_count: args.opcoes_validas.length,
  opcoes_validas: args.opcoes_validas,
};
```

- [ ] **Step 3: Update test**

In `tests/unit/ask-pending-question.spec.ts` modify the "accepts canonical sim/nao binary" test:

```typescript
expect(result).toEqual({
  pending_question_id: 'pq-uuid-1',
  opcoes_count: 2,
  opcoes_validas: [{ key: 'sim', label: 'Sim' }, { key: 'nao', label: 'Não' }],
});
```

- [ ] **Step 4: Verify + commit**

```bash
npx vitest run tests/unit/ask-pending-question.spec.ts
npx tsc --noEmit
git add src/tools/ask-pending-question.ts tests/unit/ask-pending-question.spec.ts
git commit -m "feat(b1): ask_pending_question returns opcoes_count + opcoes_validas"
```

---

## Task 8: Add `sendPoll` primitive

**Files:** `src/gateway/presence.ts`

- [ ] **Step 1: Implement**

Append to `src/gateway/presence.ts`:

```typescript
export type SendPollResult = {
  whatsapp_id: string | null;
  message_secret: string | null; // base64 — needed to decrypt votes
};

export async function sendPoll(
  remote_jid: string,
  question: string,
  options: ReadonlyArray<{ key: string; label: string }>,
): Promise<SendPollResult> {
  if (!config.FEATURE_ONE_TAP) return { whatsapp_id: null, message_secret: null };
  if (!isBaileysConnected()) return { whatsapp_id: null, message_secret: null };
  const sock = getSocket();
  if (!sock) return { whatsapp_id: null, message_secret: null };
  try {
    const result = await sock.sendMessage(remote_jid, {
      poll: {
        name: question,
        values: options.map((o) => o.label),
        selectableCount: 1,
      },
    });
    const secretBuf = result?.message?.messageContextInfo?.messageSecret as
      | Uint8Array
      | undefined;
    return {
      whatsapp_id: result?.key?.id ?? null,
      message_secret: secretBuf ? Buffer.from(secretBuf).toString('base64') : null,
    };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'presence.send_poll_failed');
    return { whatsapp_id: null, message_secret: null };
  }
}
```

- [ ] **Step 2:** Typecheck + commit
```bash
npx tsc --noEmit
git add src/gateway/presence.ts
git commit -m "feat(b1): sendPoll primitive on presence module"
```

---

## Task 9: Add `sendOutboundPoll` in core.ts + branch the agent loop

**Files:** `src/agent/core.ts`

- [ ] **Step 1: Replace `latestPendingId` with `latestPending`**

Find:
```typescript
let latestPendingId: string | null = null;
```

Replace with:
```typescript
let latestPending: {
  id: string;
  opcoes_validas: Array<{ key: string; label: string }>;
} | null = null;
```

Update the capture site (around line 226) to read both fields:

```typescript
if (
  tu.tool === 'ask_pending_question' &&
  typeof out === 'object' && out !== null &&
  'pending_question_id' in out
) {
  const candidate = (out as {
    pending_question_id: string;
    opcoes_validas: Array<{ key: string; label: string }>;
  });
  const stillActive = await pendingQuestionsRepo.findActiveSnapshot(c.id).catch(() => null);
  if (stillActive && stillActive.id === candidate.pending_question_id) {
    latestPending = { id: candidate.pending_question_id, opcoes_validas: candidate.opcoes_validas };
  } else {
    logger.warn({ tool: tu.tool, candidate: candidate.pending_question_id, conversa_id: c.id }, 'agent.stale_pending_id_dropped');
  }
}
```

- [ ] **Step 2: Add `sendOutboundPoll` helper**

Append near `sendOutbound`:

```typescript
async function sendOutboundPoll(
  pessoa_id: string,
  conversa_id: string,
  text: string,
  in_reply_to: string,
  pending: { id: string; opcoes_validas: Array<{ key: string; label: string }> },
): Promise<{ fell_back: boolean }> {
  const pessoa = await pessoasRepo.findById(pessoa_id);
  if (!pessoa) return { fell_back: false };
  const jid = pessoa.telefone_whatsapp.replace('+', '') + '@s.whatsapp.net';
  const { sendPoll } = await import('@/gateway/presence.js');
  const sent = await sendPoll(jid, text, pending.opcoes_validas);
  if (!sent.whatsapp_id) {
    // Fallback to plain text with numbered list.
    const numbered = pending.opcoes_validas.map((o, i) => `${i + 1}. ${o.label}`).join('\n');
    await sendOutbound(pessoa_id, conversa_id, `${text}\n\n${numbered}`, in_reply_to, {
      pending_question_id: pending.id,
    });
    return { fell_back: true };
  }
  await mensagensRepo.create({
    conversa_id,
    direcao: 'out',
    tipo: 'texto',
    conteudo: text,
    midia_url: null,
    metadata: {
      whatsapp_id: sent.whatsapp_id,
      in_reply_to,
      pending_question_id: pending.id,
      poll_options: pending.opcoes_validas,
      poll_message_secret: sent.message_secret,
    },
    processada_em: new Date(),
    ferramentas_chamadas: [],
    tokens_usados: null,
  });
  return { fell_back: false };
}
```

- [ ] **Step 3: Branch at the text-send site**

Find (the no-tool-uses branch around line 174):

```typescript
if (res.tool_uses.length === 0) {
  const text = res.content?.trim() ?? '';
  if (text) {
    const shouldQuote =
      (inbound.conteudo && detectCorrection(inbound.conteudo)) ||
      getActivePending(c) !== null;
    await sendOutbound(pessoa.id, c.id, text, inbound.id, {
      pending_question_id: latestPendingId,
      quoted: shouldQuote
        ? quotedReplyContext(inbound.metadata as Record<string, unknown> | null, inbound.conteudo)
        : undefined,
    });
  }
  break;
}
```

Replace with:

```typescript
if (res.tool_uses.length === 0) {
  const text = res.content?.trim() ?? '';
  if (text) {
    const usePoll =
      latestPending &&
      config.FEATURE_ONE_TAP &&
      latestPending.opcoes_validas.length >= 3 &&
      latestPending.opcoes_validas.length <= 12;
    if (usePoll && latestPending) {
      await sendOutboundPoll(pessoa.id, c.id, text, inbound.id, latestPending);
    } else {
      const shouldQuote =
        (inbound.conteudo && detectCorrection(inbound.conteudo)) ||
        getActivePending(c) !== null;
      await sendOutbound(pessoa.id, c.id, text, inbound.id, {
        pending_question_id: latestPending?.id ?? null,
        quoted: shouldQuote
          ? quotedReplyContext(inbound.metadata as Record<string, unknown> | null, inbound.conteudo)
          : undefined,
      });
    }
  }
  break;
}
```

- [ ] **Step 4:** Typecheck + commit
```bash
npx tsc --noEmit
git add src/agent/core.ts
git commit -m "feat(b1): agent loop branches to sendOutboundPoll for 3-12 opt pendings"
```

---

## Task 10: TDD — `dispatchReactionAsAnswer`

**Files:**
- Create: `src/agent/one-tap.ts`
- Create: `tests/unit/one-tap-reaction.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findByWhatsappId = vi.fn();
const conversaById = vi.fn();
const findById = vi.fn();
const findActiveSnapshot = vi.fn();
vi.mock('../../src/db/repositories.js', () => ({
  mensagensRepo: { findByWhatsappId },
  conversasRepo: { byId: conversaById },
  pessoasRepo: { findById },
  pendingQuestionsRepo: { findActiveSnapshot },
}));

const resolveAndDispatch = vi.fn();
vi.mock('../../src/agent/pending-resolver.js', () => ({ resolveAndDispatch }));

const audit = vi.fn();
vi.mock('../../src/governance/audit.js', () => ({ audit }));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  findByWhatsappId.mockReset();
  conversaById.mockReset();
  findById.mockReset();
  findActiveSnapshot.mockReset();
  resolveAndDispatch.mockReset();
  audit.mockReset();
});

const reactionMsg = {
  message: {
    reactionMessage: {
      key: { id: 'WAID-PARENT', remoteJid: 'jid' },
      text: '✅',
    },
  },
} as never;

describe('dispatchReactionAsAnswer', () => {
  it('maps ✅ to opcoes_validas[0].key and calls resolveAndDispatch', async () => {
    findByWhatsappId.mockResolvedValueOnce({
      id: 'msg-out-1',
      conversa_id: 'c1',
      metadata: {
        pending_question_id: 'pq-1',
        whatsapp_id: 'WAID-PARENT',
      },
    });
    conversaById.mockResolvedValueOnce({ id: 'c1', pessoa_id: 'p1' });
    findById.mockResolvedValueOnce({ id: 'p1' });
    findActiveSnapshot.mockResolvedValueOnce({
      id: 'pq-1',
      opcoes_validas: [{ key: 'sim', label: 'Sim' }, { key: 'nao', label: 'Não' }],
    });
    resolveAndDispatch.mockResolvedValueOnce({ resolved: true });
    const { dispatchReactionAsAnswer } = await import('../../src/agent/one-tap.ts');
    await dispatchReactionAsAnswer(reactionMsg);
    expect(resolveAndDispatch).toHaveBeenCalledWith(expect.objectContaining({
      expected_pending_id: 'pq-1',
      option_chosen: 'sim',
      confidence: 1,
      source: 'reaction',
    }));
  });

  it('maps ❌ to opcoes_validas[1].key', async () => {
    const negMsg = { message: { reactionMessage: { key: { id: 'WAID-PARENT', remoteJid: 'jid' }, text: '❌' } } } as never;
    findByWhatsappId.mockResolvedValueOnce({
      id: 'msg-out-1', conversa_id: 'c1',
      metadata: { pending_question_id: 'pq-1', whatsapp_id: 'WAID-PARENT' },
    });
    conversaById.mockResolvedValueOnce({ id: 'c1', pessoa_id: 'p1' });
    findById.mockResolvedValueOnce({ id: 'p1' });
    findActiveSnapshot.mockResolvedValueOnce({
      id: 'pq-1',
      opcoes_validas: [{ key: 'sim', label: 'Sim' }, { key: 'nao', label: 'Não' }],
    });
    resolveAndDispatch.mockResolvedValueOnce({ resolved: true });
    const { dispatchReactionAsAnswer } = await import('../../src/agent/one-tap.ts');
    await dispatchReactionAsAnswer(negMsg);
    expect(resolveAndDispatch).toHaveBeenCalledWith(expect.objectContaining({ option_chosen: 'nao' }));
  });

  it('unmapped emoji → audit reaction_ignored_unmapped_emoji, no resolve', async () => {
    const partyMsg = { message: { reactionMessage: { key: { id: 'WAID-PARENT', remoteJid: 'jid' }, text: '🎉' } } } as never;
    findByWhatsappId.mockResolvedValueOnce({
      id: 'msg-out-1', conversa_id: 'c1',
      metadata: { pending_question_id: 'pq-1' },
    });
    const { dispatchReactionAsAnswer } = await import('../../src/agent/one-tap.ts');
    await dispatchReactionAsAnswer(partyMsg);
    expect(resolveAndDispatch).not.toHaveBeenCalled();
    expect(audit.mock.calls.some((c) => c[0].acao === 'reaction_ignored_unmapped_emoji')).toBe(true);
  });

  it('parent without pending_question_id → audit one_tap_no_pending_anchor', async () => {
    findByWhatsappId.mockResolvedValueOnce({
      id: 'msg-out-1', conversa_id: 'c1',
      metadata: { whatsapp_id: 'WAID-PARENT' }, // no pending_question_id
    });
    const { dispatchReactionAsAnswer } = await import('../../src/agent/one-tap.ts');
    await dispatchReactionAsAnswer(reactionMsg);
    expect(resolveAndDispatch).not.toHaveBeenCalled();
    expect(audit.mock.calls.some((c) => c[0].acao === 'one_tap_no_pending_anchor')).toBe(true);
  });

  it('non-binary pending → does not handle (3+ opts use poll, not reaction)', async () => {
    findByWhatsappId.mockResolvedValueOnce({
      id: 'msg-out-1', conversa_id: 'c1',
      metadata: { pending_question_id: 'pq-1' },
    });
    conversaById.mockResolvedValueOnce({ id: 'c1', pessoa_id: 'p1' });
    findById.mockResolvedValueOnce({ id: 'p1' });
    findActiveSnapshot.mockResolvedValueOnce({
      id: 'pq-1',
      opcoes_validas: [
        { key: 'a', label: 'A' }, { key: 'b', label: 'B' }, { key: 'c', label: 'C' },
      ],
    });
    const { dispatchReactionAsAnswer } = await import('../../src/agent/one-tap.ts');
    await dispatchReactionAsAnswer(reactionMsg);
    expect(resolveAndDispatch).not.toHaveBeenCalled();
  });
});
```

Run: must FAIL (module doesn't exist).

- [ ] **Step 2: Implement**

```typescript
// src/agent/one-tap.ts
import type { proto } from '@whiskeysockets/baileys';
import { logger } from '@/lib/logger.js';
import {
  mensagensRepo,
  conversasRepo,
  pessoasRepo,
  pendingQuestionsRepo,
} from '@/db/repositories.js';
import { audit } from '@/governance/audit.js';
import { resolveAndDispatch } from './pending-resolver.js';

const AFFIRMATIVE_REACTIONS = new Set(['✅', '👍']);
const NEGATIVE_REACTIONS = new Set(['❌', '👎']);

export async function dispatchReactionAsAnswer(msg: proto.IWebMessageInfo): Promise<void> {
  const reaction = msg.message?.reactionMessage;
  if (!reaction || !reaction.key?.id || !reaction.text) return;
  const emoji = reaction.text;
  const parent_wid = reaction.key.id;

  const parent = await mensagensRepo.findByWhatsappId(parent_wid);
  if (!parent) return; // reaction on a message we don't know about; ignore
  const meta = (parent.metadata ?? {}) as Record<string, unknown>;
  const pending_id = meta.pending_question_id;
  if (typeof pending_id !== 'string') {
    await audit({ acao: 'one_tap_no_pending_anchor', metadata: { source: 'reaction', parent_wid } });
    return;
  }

  if (!AFFIRMATIVE_REACTIONS.has(emoji) && !NEGATIVE_REACTIONS.has(emoji)) {
    await audit({
      acao: 'reaction_ignored_unmapped_emoji',
      metadata: { emoji, pending_question_id: pending_id },
    });
    return;
  }

  if (!parent.conversa_id) return;
  const conversa = await conversasRepo.byId(parent.conversa_id);
  if (!conversa) return;
  const pessoa = await pessoasRepo.findById(conversa.pessoa_id);
  if (!pessoa) return;

  // Verify the pending is binary (reactions only resolve binary pendings;
  // 3+ opt pendings are resolved by poll vote).
  const active = await pendingQuestionsRepo.findActiveSnapshot(conversa.id);
  if (!active) return; // pending already gone; resolveAndDispatch would race-loss anyway
  const opcoes = active.opcoes_validas as Array<{ key: string; label: string }>;
  if (!opcoes || opcoes.length !== 2) {
    logger.debug(
      { pending_question_id: active.id, opcoes_count: opcoes?.length },
      'one_tap.reaction_on_non_binary_skipped',
    );
    return;
  }

  const option_chosen = AFFIRMATIVE_REACTIONS.has(emoji) ? opcoes[0]!.key : opcoes[1]!.key;

  try {
    await resolveAndDispatch({
      pessoa,
      conversa,
      mensagem_id: parent.id,
      expected_pending_id: pending_id,
      option_chosen,
      confidence: 1,
      source: 'reaction',
    });
  } catch (err) {
    await audit({
      acao: 'one_tap_dispatch_error',
      metadata: { source: 'reaction', err: (err as Error).message },
    });
  }
}
```

Run: PASSES.

- [ ] **Step 3: Commit**
```bash
git add src/agent/one-tap.ts tests/unit/one-tap-reaction.spec.ts
git commit -m "feat(b1): dispatchReactionAsAnswer for binary pendings"
```

---

## Task 11: TDD — `dispatchPollVote` (with `decryptPollVote`)

**Files:**
- Modify: `src/agent/one-tap.ts`
- Create: `tests/unit/one-tap-poll.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findByWhatsappId = vi.fn();
const conversaById = vi.fn();
const findById = vi.fn();
vi.mock('../../src/db/repositories.js', () => ({
  mensagensRepo: { findByWhatsappId },
  conversasRepo: { byId: conversaById },
  pessoasRepo: { findById },
  pendingQuestionsRepo: { findActiveSnapshot: vi.fn() },
}));

const resolveAndDispatch = vi.fn();
vi.mock('../../src/agent/pending-resolver.js', () => ({ resolveAndDispatch }));

const audit = vi.fn();
vi.mock('../../src/governance/audit.js', () => ({ audit }));

const decryptPollVote = vi.fn();
vi.mock('@whiskeysockets/baileys', () => ({ decryptPollVote }));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  findByWhatsappId.mockReset();
  conversaById.mockReset();
  findById.mockReset();
  resolveAndDispatch.mockReset();
  decryptPollVote.mockReset();
  audit.mockReset();
});

const pollUpdateMsg = {
  message: {
    pollUpdateMessage: {
      pollCreationMessageKey: { id: 'WAID-POLL', remoteJid: 'jid' },
      vote: { encPayload: Buffer.from([1, 2]), encIv: Buffer.from([3, 4]) },
    },
  },
} as never;

describe('dispatchPollVote', () => {
  it('decrypts vote, hash-matches a label, calls resolveAndDispatch', async () => {
    findByWhatsappId.mockResolvedValueOnce({
      id: 'out-1', conversa_id: 'c1',
      metadata: {
        pending_question_id: 'pq-1',
        poll_options: [
          { key: 'mercado', label: 'Mercado' },
          { key: 'restaurante', label: 'Restaurante' },
          { key: 'outro', label: 'Outro' },
        ],
        poll_message_secret: Buffer.from('secret').toString('base64'),
      },
    });
    conversaById.mockResolvedValueOnce({ id: 'c1', pessoa_id: 'p1' });
    findById.mockResolvedValueOnce({ id: 'p1' });
    // decryptPollVote returns selectedOptions as SHA-256 buffers of labels.
    // Stub it to return a single hash matching "Restaurante".
    const crypto = await import('node:crypto');
    const hash = crypto.createHash('sha256').update('Restaurante').digest();
    decryptPollVote.mockReturnValueOnce({ selectedOptions: [hash] });
    resolveAndDispatch.mockResolvedValueOnce({ resolved: true });
    const { dispatchPollVote } = await import('../../src/agent/one-tap.ts');
    await dispatchPollVote(pollUpdateMsg);
    expect(resolveAndDispatch).toHaveBeenCalledWith(expect.objectContaining({
      expected_pending_id: 'pq-1',
      option_chosen: 'restaurante',
      confidence: 1,
      source: 'poll_vote',
    }));
  });

  it('parent without pending_question_id → audit no_pending_anchor', async () => {
    findByWhatsappId.mockResolvedValueOnce({
      id: 'out-1', conversa_id: 'c1',
      metadata: { whatsapp_id: 'WAID-POLL' },
    });
    const { dispatchPollVote } = await import('../../src/agent/one-tap.ts');
    await dispatchPollVote(pollUpdateMsg);
    expect(resolveAndDispatch).not.toHaveBeenCalled();
    expect(audit.mock.calls.some((c) => c[0].acao === 'one_tap_no_pending_anchor')).toBe(true);
  });

  it('decryption throws → audit one_tap_dispatch_error', async () => {
    findByWhatsappId.mockResolvedValueOnce({
      id: 'out-1', conversa_id: 'c1',
      metadata: {
        pending_question_id: 'pq-1',
        poll_options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }, { key: 'c', label: 'C' }],
        poll_message_secret: Buffer.from('secret').toString('base64'),
      },
    });
    decryptPollVote.mockImplementationOnce(() => { throw new Error('decrypt failed'); });
    const { dispatchPollVote } = await import('../../src/agent/one-tap.ts');
    await dispatchPollVote(pollUpdateMsg);
    expect(resolveAndDispatch).not.toHaveBeenCalled();
    expect(audit.mock.calls.some((c) => c[0].acao === 'one_tap_dispatch_error')).toBe(true);
  });

  it('hash matches no label → audit one_tap_dispatch_error', async () => {
    findByWhatsappId.mockResolvedValueOnce({
      id: 'out-1', conversa_id: 'c1',
      metadata: {
        pending_question_id: 'pq-1',
        poll_options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }, { key: 'c', label: 'C' }],
        poll_message_secret: Buffer.from('secret').toString('base64'),
      },
    });
    decryptPollVote.mockReturnValueOnce({ selectedOptions: [Buffer.from('garbage')] });
    const { dispatchPollVote } = await import('../../src/agent/one-tap.ts');
    await dispatchPollVote(pollUpdateMsg);
    expect(resolveAndDispatch).not.toHaveBeenCalled();
    expect(audit.mock.calls.some((c) => c[0].acao === 'one_tap_dispatch_error')).toBe(true);
  });
});
```

- [ ] **Step 2: Implement**

Append to `src/agent/one-tap.ts`:

```typescript
import { createHash } from 'node:crypto';
import { decryptPollVote } from '@whiskeysockets/baileys';

export async function dispatchPollVote(msg: proto.IWebMessageInfo): Promise<void> {
  const pollUpdate = msg.message?.pollUpdateMessage;
  if (!pollUpdate?.pollCreationMessageKey?.id) return;
  const parent_wid = pollUpdate.pollCreationMessageKey.id;

  const parent = await mensagensRepo.findByWhatsappId(parent_wid);
  if (!parent) return;
  const meta = (parent.metadata ?? {}) as Record<string, unknown>;
  const pending_id = meta.pending_question_id;
  if (typeof pending_id !== 'string') {
    await audit({ acao: 'one_tap_no_pending_anchor', metadata: { source: 'poll_vote', parent_wid } });
    return;
  }
  const opts = meta.poll_options as Array<{ key: string; label: string }> | undefined;
  const secretB64 = meta.poll_message_secret as string | undefined;
  if (!opts || !secretB64) {
    await audit({
      acao: 'one_tap_dispatch_error',
      metadata: { source: 'poll_vote', reason: 'missing_poll_metadata', parent_wid },
    });
    return;
  }

  let chosenKey: string | null = null;
  try {
    // Baileys v6.x decryptPollVote signature (verified against
    // node_modules/@whiskeysockets/baileys/lib/Utils/messages-media.d.ts):
    //   decryptPollVote({ encPayload, encIv },
    //                   { pollCreatorJid, pollMsgId, pollEncKey, voterJid })
    // pollEncKey is the parent poll's messageSecret. voterJid is the voter
    // (the participant of the update if it's a group; otherwise remoteJid).
    const secret = Buffer.from(secretB64, 'base64');
    const decoded = decryptPollVote(
      {
        encPayload: pollUpdate.vote!.encPayload!,
        encIv: pollUpdate.vote!.encIv!,
      },
      {
        pollCreatorJid: msg.key.remoteJid ?? '',
        pollMsgId: parent_wid,
        pollEncKey: secret,
        voterJid: msg.key.participant ?? msg.key.remoteJid ?? '',
      },
    );
    const selected = (decoded as { selectedOptions?: Uint8Array[] }).selectedOptions ?? [];
    if (selected.length === 0) return; // empty vote (user cleared selection)
    const target = Buffer.from(selected[0]!).toString('hex');
    for (const o of opts) {
      const labelHash = createHash('sha256').update(o.label).digest('hex');
      if (labelHash === target) {
        chosenKey = o.key;
        break;
      }
    }
  } catch (err) {
    await audit({
      acao: 'one_tap_dispatch_error',
      metadata: { source: 'poll_vote', reason: 'decrypt_failed', err: (err as Error).message },
    });
    return;
  }

  if (!chosenKey) {
    await audit({
      acao: 'one_tap_dispatch_error',
      metadata: { source: 'poll_vote', reason: 'no_label_match', pending_question_id: pending_id },
    });
    return;
  }

  if (!parent.conversa_id) return;
  const conversa = await conversasRepo.byId(parent.conversa_id);
  if (!conversa) return;
  const pessoa = await pessoasRepo.findById(conversa.pessoa_id);
  if (!pessoa) return;

  await resolveAndDispatch({
    pessoa,
    conversa,
    mensagem_id: parent.id,
    expected_pending_id: pending_id,
    option_chosen: chosenKey,
    confidence: 1,
    source: 'poll_vote',
  }).catch(async (err) => {
    await audit({
      acao: 'one_tap_dispatch_error',
      metadata: { source: 'poll_vote', err: (err as Error).message },
    });
  });
}
```

(Verified against Baileys v6.7.0 `lib/Utils/messages-media.d.ts`. If the dependency is bumped, re-verify the signature; the unit test pins our adapter shape so a regression surfaces at test time.)

- [ ] **Step 3: Verify + commit**

```bash
npx vitest run tests/unit/one-tap-poll.spec.ts tests/unit/one-tap-reaction.spec.ts
npx tsc --noEmit
git add src/agent/one-tap.ts tests/unit/one-tap-poll.spec.ts
git commit -m "feat(b1): dispatchPollVote with decryptPollVote + hash-match"
```

---

## Task 12: Wire dispatchers into `baileys.handleIncoming`

**Files:** `src/gateway/baileys.ts`

- [ ] **Step 1: Add import**

```typescript
import { dispatchReactionAsAnswer, dispatchPollVote } from '@/agent/one-tap.js';
```

- [ ] **Step 2: Inspect the current `pollUpdateMessage` behaviour**

Before adding the new branch, confirm what current `handleIncoming` does with a `pollUpdateMessage`. Read `src/gateway/baileys.ts`:

- If it falls through `extractContent` and ends as `tipo='sistema'` (a sistema row in `mensagens`), then today's behaviour is "persist as system row, no agent processing". Adding an early-return WITH the flag off changes behaviour.
- Solution: **gate the early-return on `FEATURE_ONE_TAP`** so flag-off behaviour is identical to today. When the flag is on we re-route + drop; when off we let the existing path persist.

- [ ] **Step 3: Add prefix branches**

In `handleIncoming`, find the existing reaction-stub early return:

```typescript
if (isReactionStub(msg)) return;
```

Replace with (note both branches gated on `FEATURE_ONE_TAP` for the new dispatch; existing reaction-stub return stays unconditional because it was already in main):

```typescript
// B1: poll vote arrives as a pollUpdateMessage. When FEATURE_ONE_TAP is on,
// route to the one-tap dispatcher and drop. When off, fall through to the
// existing pipeline (preserves pre-B1 behaviour).
if (msg.message?.pollUpdateMessage) {
  if (config.FEATURE_ONE_TAP) {
    await dispatchPollVote(msg).catch((err) =>
      logger.warn({ err: (err as Error).message }, 'one_tap.poll_dispatch_failed'),
    );
    return;
  }
  // flag off → fall through; existing extractContent classifies as 'sistema'
}

if (isReactionStub(msg)) {
  // existing behaviour: never persist reactions; absorb as one-tap when on.
  if (config.FEATURE_ONE_TAP) {
    await dispatchReactionAsAnswer(msg).catch((err) =>
      logger.warn({ err: (err as Error).message }, 'one_tap.reaction_dispatch_failed'),
    );
  }
  return;
}
```

- [ ] **Step 4:** Typecheck + commit
```bash
npx tsc --noEmit
git add src/gateway/baileys.ts
git commit -m "feat(b1): wire pollUpdateMessage + reaction dispatchers in handleIncoming"
```

---

## Task 13: Final gate + push + open PR

- [ ] **Step 1:** Full unit suite

```
npx vitest run tests/unit
```

Expected: all new tests green; pre-existing module-load failures unchanged.

- [ ] **Step 2:** Typecheck

```
npx tsc --noEmit
```

Expected: only the 3 pre-existing errors (`db/client.ts:24`, `gateway/queue.ts:31`, `lib/alerts.ts:32`).

- [ ] **Step 3:** Push & open PR

```bash
git push -u origin feat/whatsapp-b1-one-tap
gh pr create --base main --title "feat(b1): one-tap pending resolution (polls + reactions)" --body "Implements docs/superpowers/specs/2026-04-29-whatsapp-b1-one-tap-design.md. Builds on B0 (PR #12). Gated behind FEATURE_ONE_TAP=false."
```

---

## Acceptance verification (mirrors spec §12)

- [ ] **Refactor**: `resolveAndDispatch` exists; gate calls it; gate's resolved result no longer carries action; core.ts no longer dispatches gate path. (Tasks 4-6)
- [ ] **B0 tests updated**: `tests/unit/pending-gate.spec.ts` mocks `resolveAndDispatch`. (Task 5)
- [ ] **`conversasRepo.byId` added**. (Task 3)
- [ ] **Send poll**: 3-12 opcoes → outbound is a poll. (Task 9)
- [ ] **Send binary**: 2 opcoes → plain text. (Task 9)
- [ ] **Receive reaction**: ✅ on binary parent resolves. (Task 10)
- [ ] **Receive poll vote**: tap resolves with hash-matched key. (Task 11)
- [ ] **Unmapped emoji**: ignored with audit. (Task 10)
- [ ] **No anchor**: parent without pending_question_id → audit. (Tasks 10, 11)
- [ ] **Race**: helper handles via `pending_race_lost`. (Task 4)
- [ ] **Stale message**: `pending_race_lost` (not `no_pending_anchor`). (Task 4)
- [ ] **`FEATURE_ONE_TAP=false`**: no send-side polls; no receive-side dispatch. (Tasks 1, 8, 12)
- [ ] **No new mensagens rows for poll/reaction**: existing reaction-stub early-return + new pollUpdate early-return. (Task 12)
