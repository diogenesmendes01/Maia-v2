# WhatsApp B0 — Pending-Question Lifecycle Wiring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the existing `pending_questions` table into the agent loop. Add a `ask_pending_question` tool that creates rows, a pre-LLM `pending-gate` that resolves user replies via Haiku-classified `IntentResolution` inside a transaction (LLM call **outside** the lock), and persist `pending_question_id` on outbound `mensagens` rows so sub-project B1 can reverse-look-up.

**Architecture:** Single Postgres source-of-truth (the existing table). Snapshot-read → classify with Haiku → write-tx with `SELECT FOR UPDATE` re-check. Lightweight metadata helpers stay alive but `@deprecated`. Feature-flagged behind `FEATURE_PENDING_GATE`.

**Tech Stack:** TypeScript, Drizzle ORM (`db.transaction`-style via `withTx` helper at `src/db/client.ts:19`), `@anthropic-ai/sdk`, vitest.

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `src/config/env.ts` | Modify | Add `FEATURE_PENDING_GATE` (default `false`) |
| `src/governance/audit-actions.ts` | Modify | Append 6 new actions |
| `migrations/004_pending_one_active_per_conversa.sql` | Create | Partial unique index |
| `scripts/recover-pending-dupes.sql` | Create | Operator recovery script (referenced by migration) |
| `src/db/repositories.ts` | Modify | 5 new tx-aware methods on `pendingQuestionsRepo` |
| `src/workflows/pending-questions.ts` | Modify | `@deprecated` JSDoc on lightweight helpers |
| `src/tools/ask-pending-question.ts` | Create | New tool: persists pending row + substitution + affirmative-first guard |
| `src/tools/_registry.ts` | Modify | Register `ask_pending_question` |
| `src/agent/pending-gate.ts` | Create | Snapshot read → Haiku classify → tx with re-check |
| `src/agent/core.ts` | Modify | Insert gate before `buildPrompt`; track-and-forward `pending_question_id`; extend `sendOutbound` opts |
| `tests/unit/ask-pending-question.spec.ts` | Create | Schema, affirmative-first, substitution, no-double-audit |
| `tests/unit/pending-gate.spec.ts` | Create | Snapshot/classify/resolve/topic_change/low_confidence/race-loss |
| `tests/unit/pending-deprecation.spec.ts` | Create | Grep-based assertion: no `src/agent/**` callers of lightweight helpers |
| `tests/integration/pending-gate-concurrency.spec.ts` | Create | Two concurrent gates → action dispatched once; injected classifier |

No DB schema rewrites. No new tables.

---

## Task 1: Add `FEATURE_PENDING_GATE` config flag

**Files:** `src/config/env.ts`

- [ ] **Step 1: Add the env entry**

In `src/config/env.ts`, alongside `FEATURE_DASHBOARD`:

```typescript
FEATURE_PENDING_GATE: z
  .string()
  .default('false')
  .transform((s) => s === 'true' || s === '1'),
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: only the pre-existing errors (unrelated to this PR).

- [ ] **Step 3: Commit**

```bash
git add src/config/env.ts
git commit -m "feat(b0): FEATURE_PENDING_GATE env flag (default false)"
```

---

## Task 2: Append 6 audit actions

**Files:** `src/governance/audit-actions.ts`

- [ ] **Step 1: Append actions**

Add to the `AUDIT_ACTIONS` array (anywhere before the closing bracket):

```typescript
'pending_created',
'pending_resolved_by_gate',
'pending_unresolved_topic_change',
'pending_unresolved_low_confidence',
'pending_substituted',
'pending_action_dispatched',
'pending_race_lost',
```

(That's 7, including `pending_race_lost` from spec §6.)

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean (pre-existing errors aside).

- [ ] **Step 3: Commit**

```bash
git add src/governance/audit-actions.ts
git commit -m "feat(b0): audit actions for pending-gate lifecycle"
```

---

## Task 3: Migration 004 + recovery script

**Files:** `migrations/004_pending_one_active_per_conversa.sql`, `scripts/recover-pending-dupes.sql`

- [ ] **Step 1: Recovery script first** (referenced by migration's header)

Create `scripts/recover-pending-dupes.sql`:

```sql
-- =====================================================================
-- Maia — Recovery script for migration 004
-- Run BEFORE retrying migration 004 if it fails with duplicate-key.
-- Collapses each conversa's open-pending set to the single most-recent;
-- older opens become 'expirada'.
-- =====================================================================

UPDATE pending_questions p
   SET status = 'expirada'
 WHERE status = 'aberta'
   AND id NOT IN (
     SELECT DISTINCT ON (conversa_id) id
       FROM pending_questions
      WHERE status = 'aberta'
      ORDER BY conversa_id, created_at DESC
   );
```

- [ ] **Step 2: Create migration**

Create `migrations/004_pending_one_active_per_conversa.sql`:

```sql
-- =====================================================================
-- Maia — Migration 004 (B0: pending-question lifecycle wiring)
-- Enforces "one active pending per conversa" at the DB level, so the
-- pre-LLM gate (src/agent/pending-gate.ts) never sees ambiguous state.
--
-- Failure mode: if any conversa already has multiple 'aberta' rows when
-- this applies, index creation fails with a duplicate-key error. Run
-- scripts/recover-pending-dupes.sql once, then re-apply this migration.
-- =====================================================================

CREATE UNIQUE INDEX IF NOT EXISTS uniq_pending_questions_active_per_conversa
  ON pending_questions (conversa_id)
  WHERE status = 'aberta';
```

- [ ] **Step 3: Commit**

```bash
git add migrations/004_pending_one_active_per_conversa.sql scripts/recover-pending-dupes.sql
git commit -m "feat(b0): migration 004 — partial unique index for one-active-pending-per-conversa"
```

---

## Task 4: `pendingQuestionsRepo` tx-aware methods

**Files:** `src/db/repositories.ts`

The 5 methods all wrap the Drizzle query builder, accepting either the global `db` or a `tx` returned by `withTx`. Drizzle's tx client has the same shape — typed as `typeof db`. We use Drizzle's native `.for('update')` instead of raw SQL so types and JSONB parsing carry through (no hand casts, no `tx.execute` shape mismatch).

- [ ] **Step 1: Add the 5 methods**

In `src/db/repositories.ts`, find `export const pendingQuestionsRepo = {` and add (keep existing `create`, `findOpen`, `resolve`, `expireDue` intact):

```typescript
  // === B0 tx-aware additions ===

  async findActiveSnapshot(conversa_id: string): Promise<PendingQuestion | null> {
    const rows = await db
      .select()
      .from(pending_questions)
      .where(
        and(
          eq(pending_questions.conversa_id, conversa_id),
          eq(pending_questions.status, 'aberta'),
          sql`expira_em > now()`,
        ),
      )
      .orderBy(desc(pending_questions.created_at))
      .limit(1);
    return rows[0] ?? null;
  },

  async findActiveForUpdate(
    tx: typeof db,
    conversa_id: string,
  ): Promise<PendingQuestion | null> {
    const rows = await tx
      .select()
      .from(pending_questions)
      .where(
        and(
          eq(pending_questions.conversa_id, conversa_id),
          eq(pending_questions.status, 'aberta'),
          sql`expira_em > now()`,
        ),
      )
      .orderBy(desc(pending_questions.created_at))
      .limit(1)
      .for('update');
    return rows[0] ?? null;
  },

  async resolveTx(tx: typeof db, id: string, resposta: unknown): Promise<void> {
    await tx
      .update(pending_questions)
      .set({
        status: 'respondida',
        resposta: resposta as object,
        resolvida_em: new Date(),
      })
      .where(eq(pending_questions.id, id));
  },

  async cancelTx(tx: typeof db, id: string, reason: string): Promise<void> {
    await tx.execute(sql`
      UPDATE pending_questions
         SET status = 'cancelada',
             metadata = metadata || ${JSON.stringify({ cancel_reason: reason })}::jsonb
       WHERE id = ${id}
    `);
  },

  async cancelOpenForConversaTx(
    tx: typeof db,
    conversa_id: string,
    reason: string,
  ): Promise<{ cancelled_ids: string[] }> {
    const result = await tx.execute<{ id: string }>(sql`
      UPDATE pending_questions
         SET status = 'cancelada',
             metadata = metadata || ${JSON.stringify({ cancel_reason: reason })}::jsonb
       WHERE conversa_id = ${conversa_id}
         AND status = 'aberta'
       RETURNING id::text
    `);
    return { cancelled_ids: result.rows.map((r) => (r as { id: string }).id) };
  },
```

(`findActiveSnapshot` and `findActiveForUpdate` use Drizzle's typed query builder so JSONB columns parse correctly. `cancelTx` / `cancelOpenForConversaTx` use raw SQL because they need `metadata || jsonb` concat which Drizzle doesn't expose ergonomically — the cast is bounded.)

The signature-existence ceremony test from the v1 plan was dropped — Task 8/9 unit tests exercise the methods through the gate, which is real coverage.

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/db/repositories.ts
git commit -m "feat(b0): pendingQuestionsRepo tx-aware methods (find/resolve/cancel) via Drizzle .for('update')"
```

---

## Task 5: JSDoc-deprecate the lightweight helpers + grep test

**Files:** `src/workflows/pending-questions.ts`, `tests/unit/pending-deprecation.spec.ts`

- [ ] **Step 1: Add `@deprecated` tags**

In `src/workflows/pending-questions.ts`, prepend each of the three helpers with:

```typescript
/**
 * @deprecated Use pendingQuestionsRepo + src/agent/pending-gate.ts instead.
 * Retained only for src/workflows/dual-approval.ts which has its own pending state.
 */
export async function setLightweightPending(...) { ... }

/** @deprecated See setLightweightPending. */
export function getActivePending(...) { ... }

/** @deprecated See setLightweightPending. */
export async function clearLightweightPending(...) { ... }
```

`applyResolution` is **not** deprecated — it remains the path used by lightweight callers (dual-approval). The gate uses `pendingQuestionsRepo.*Tx` directly.

- [ ] **Step 2: Write grep test**

Create `tests/unit/pending-deprecation.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';

describe('pending lifecycle — agent layer must use pendingQuestionsRepo, not lightweight helpers', () => {
  it('no callers of setLightweightPending/getActivePending/clearLightweightPending in src/agent/', () => {
    let output = '';
    try {
      // ripgrep returns non-zero when no matches, swallow that.
      output = execSync(
        'rg -l "setLightweightPending|getActivePending|clearLightweightPending" src/agent/ || true',
        { encoding: 'utf8' },
      );
    } catch {
      output = '';
    }
    expect(output.trim()).toBe('');
  });
});
```

(If `rg` is unavailable on the dev machine, swap for `grep -rl`. The test is environment-dependent but cheap.)

- [ ] **Step 3: Run + commit**

```bash
npx vitest run tests/unit/pending-deprecation.spec.ts
git add src/workflows/pending-questions.ts tests/unit/pending-deprecation.spec.ts
git commit -m "feat(b0): @deprecated lightweight pending helpers; grep test enforces agent boundary"
```

---

## Task 6: TDD — `ask_pending_question` tool

**Files:** `src/tools/ask-pending-question.ts`, `tests/unit/ask-pending-question.spec.ts`

The tool persists a row and stamps `pending_question_id` somewhere the agent loop can pick up. Since dispatchTool's return value is what the LLM sees (and the agent loop can also inspect it), we return `{ pending_question_id }` and the agent loop tracks it in a turn-local variable (Task 9).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/ask-pending-question.spec.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const insertedRow = { id: 'pq-uuid-1' };
const repoMock = {
  create: vi.fn().mockResolvedValue(insertedRow),
  cancelOpenForConversaTx: vi.fn().mockResolvedValue({ cancelled_ids: [] }),
};
const auditMock = vi.fn();
const withTxMock = vi.fn(async (fn) => fn({} as never));

vi.mock('../../src/db/repositories.js', () => ({
  pendingQuestionsRepo: repoMock,
}));
vi.mock('../../src/db/client.js', () => ({
  withTx: withTxMock,
  db: {} as never,
}));
vi.mock('../../src/governance/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/config/env.js', () => ({
  config: { PENDING_QUESTION_TTL_MINUTES: 120 },
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  repoMock.create.mockClear();
  repoMock.cancelOpenForConversaTx.mockClear();
  auditMock.mockClear();
  withTxMock.mockClear();
});

const ctx = {
  pessoa: { id: 'p1' },
  conversa: { id: 'c1' },
  scope: { entidades: ['e1'], byEntity: new Map() },
  mensagem_id: 'm1',
  request_id: 'r1',
  idempotency_key: 'ik1',
} as never;

describe('ask_pending_question — schema + affirmative-first', () => {
  it('rejects binary opcoes whose first key is not affirmative', async () => {
    const { askPendingQuestionTool } = await import('../../src/tools/ask-pending-question.js');
    const result = await askPendingQuestionTool.handler(
      {
        pergunta: 'Confirma?',
        opcoes_validas: [
          { key: 'cancela', label: 'Cancela' },
          { key: 'sim', label: 'Sim' },
        ],
      } as never,
      ctx,
    );
    expect((result as { error?: string }).error).toBe('binary_options_must_be_affirmative_first');
    expect(repoMock.create).not.toHaveBeenCalled();
  });

  it('accepts canonical "sim/nao" binary', async () => {
    const { askPendingQuestionTool } = await import('../../src/tools/ask-pending-question.js');
    const result = await askPendingQuestionTool.handler(
      {
        pergunta: 'Confirma?',
        opcoes_validas: [
          { key: 'sim', label: 'Sim' },
          { key: 'nao', label: 'Não' },
        ],
      } as never,
      ctx,
    );
    expect((result as { pending_question_id: string }).pending_question_id).toBe('pq-uuid-1');
    expect(repoMock.cancelOpenForConversaTx).toHaveBeenCalledWith(
      expect.anything(),
      'c1',
      'substituted',
    );
    expect(repoMock.create).toHaveBeenCalled();
  });

  it('substitutes prior open pending and audits pending_substituted with prior ids', async () => {
    repoMock.cancelOpenForConversaTx.mockResolvedValueOnce({ cancelled_ids: ['old-pq'] });
    const { askPendingQuestionTool } = await import('../../src/tools/ask-pending-question.js');
    await askPendingQuestionTool.handler(
      {
        pergunta: 'Qual categoria?',
        opcoes_validas: [
          { key: 'mercado', label: 'Mercado' },
          { key: 'restaurante', label: 'Restaurante' },
          { key: 'outro', label: 'Outro' },
        ],
      } as never,
      ctx,
    );
    const subs = auditMock.mock.calls.filter((c) => c[0]?.acao === 'pending_substituted');
    expect(subs.length).toBe(1);
    expect(subs[0][0].metadata.cancelled_ids).toEqual(['old-pq']);
  });

  it('does NOT audit pending_created from the handler (dispatcher does it)', async () => {
    const { askPendingQuestionTool } = await import('../../src/tools/ask-pending-question.js');
    await askPendingQuestionTool.handler(
      {
        pergunta: 'Confirma?',
        opcoes_validas: [
          { key: 'sim', label: 'Sim' },
          { key: 'nao', label: 'Não' },
        ],
      } as never,
      ctx,
    );
    const creates = auditMock.mock.calls.filter((c) => c[0]?.acao === 'pending_created');
    expect(creates.length).toBe(0); // dispatcher fires this audit, not the handler
  });
});
```

Run: must FAIL (tool not exported).

- [ ] **Step 2: Implement the tool**

Create `src/tools/ask-pending-question.ts`:

```typescript
import { z } from 'zod';
import type { Tool } from './_registry.js';
import { config } from '@/config/env.js';
import { withTx } from '@/db/client.js';
import { pendingQuestionsRepo } from '@/db/repositories.js';
import { audit } from '@/governance/audit.js';

const AFFIRMATIVE = /^(sim|s[ií]m?|aprova|aprovo|confirma|confirmo|libera|ok|pode|positivo)$/i;
const NEGATIVE = /^(n[ãa]o|cancela|cancelo|bloqueia|bloqueio|nega|recusa|recuso|negativo)$/i;

const inputSchema = z.object({
  entidade_id: z.string().uuid().optional(),
  pergunta: z.string().min(3).max(500),
  opcoes_validas: z
    .array(z.object({ key: z.string().min(1).max(40), label: z.string().min(1).max(80) }))
    .min(2)
    .max(12),
  acao_proposta: z
    .object({ tool: z.string(), args: z.record(z.unknown()) })
    .optional(),
  ttl_minutes: z.number().int().positive().max(1440).optional(),
});

const outputSchema = z.union([
  z.object({ pending_question_id: z.string() }),
  z.object({ error: z.string() }),
]);

export const askPendingQuestionTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'ask_pending_question',
  description:
    'Cria uma pergunta pendente persistida que será resolvida quando o usuário responder. Use quando precisa esperar uma escolha (sim/não, ou 3-12 opções) antes de continuar.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['schedule_reminder'],
  side_effect: 'communication',
  redis_required: false,
  operation_type: 'create',
  audit_action: 'pending_created',
  handler: async (args, ctx) => {
    if (args.opcoes_validas.length === 2) {
      const [first, second] = args.opcoes_validas;
      if (!AFFIRMATIVE.test(first!.key) || !NEGATIVE.test(second!.key)) {
        return { error: 'binary_options_must_be_affirmative_first' };
      }
    }
    const ttl = args.ttl_minutes ?? config.PENDING_QUESTION_TTL_MINUTES;
    const expira_em = new Date(Date.now() + ttl * 60_000);

    const created = await withTx(async (tx) => {
      const cancelled = await pendingQuestionsRepo.cancelOpenForConversaTx(
        tx,
        ctx.conversa.id,
        'substituted',
      );
      if (cancelled.cancelled_ids.length > 0) {
        await audit({
          acao: 'pending_substituted',
          pessoa_id: ctx.pessoa.id,
          conversa_id: ctx.conversa.id,
          mensagem_id: ctx.mensagem_id,
          metadata: { cancelled_ids: cancelled.cancelled_ids },
        });
      }
      const row = await pendingQuestionsRepo.create({
        conversa_id: ctx.conversa.id,
        pessoa_id: ctx.pessoa.id,
        tipo: 'gate',
        pergunta: args.pergunta,
        opcoes_validas: args.opcoes_validas,
        acao_proposta: (args.acao_proposta ?? {}) as object,
        expira_em,
        status: 'aberta',
      });
      return row;
    });

    // Note: do NOT call audit({ acao: 'pending_created' }) here — the dispatcher
    // emits this audit automatically based on the tool's `audit_action` field.
    // Doing both would double-write. The dispatcher's audit row carries
    // pessoa_id, conversa_id, mensagem_id, and `metadata: { tool }` already;
    // we lose alvo_id (the new pq id) and the expira_em metadata, but the
    // tool result `{ pending_question_id }` is captured by the dispatcher's
    // idempotency_keys.resultado JSONB which is queryable for those.

    return { pending_question_id: created.id };
  },
};
```

- [ ] **Step 3: Run + commit**

```bash
npx vitest run tests/unit/ask-pending-question.spec.ts
npx tsc --noEmit
git add src/tools/ask-pending-question.ts tests/unit/ask-pending-question.spec.ts
git commit -m "feat(b0): ask_pending_question tool with affirmative-first guard + substitution"
```

---

## Task 7: Register `ask_pending_question`

**Files:** `src/tools/_registry.ts`

- [ ] **Step 1: Import + register**

```typescript
// near other imports
import { askPendingQuestionTool } from './ask-pending-question.js';

// inside REGISTRY
ask_pending_question: askPendingQuestionTool as unknown as AnyTool,
```

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/tools/_registry.ts
git commit -m "feat(b0): register ask_pending_question in tool registry"
```

---

## Task 8: TDD — `pending-gate.ts` (snapshot + Haiku classify, no tx yet)

**Files:** `src/agent/pending-gate.ts`, `tests/unit/pending-gate.spec.ts`

We build the gate in two passes: this task does steps 1-2 from spec §4.3 (snapshot + classify), Task 9 adds the tx + branches.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/pending-gate.spec.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findActiveSnapshot = vi.fn();
const findActiveForUpdate = vi.fn();
const resolveTx = vi.fn();
const cancelTx = vi.fn();

vi.mock('../../src/db/repositories.js', () => ({
  pendingQuestionsRepo: {
    findActiveSnapshot,
    findActiveForUpdate,
    resolveTx,
    cancelTx,
  },
}));

const callLLM = vi.fn();
vi.mock('../../src/lib/claude.js', () => ({ callLLM }));

const withTx = vi.fn(async (fn) => fn({} as never));
vi.mock('../../src/db/client.js', () => ({ withTx, db: {} as never }));

const audit = vi.fn();
vi.mock('../../src/governance/audit.js', () => ({ audit }));

vi.mock('../../src/config/env.js', () => ({
  config: { FEATURE_PENDING_GATE: true },
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const pessoa = { id: 'p1' } as never;
const conversa = { id: 'c1' } as never;
const inbound = { id: 'm1', conteudo: 'sim' } as never;

beforeEach(() => {
  findActiveSnapshot.mockReset();
  findActiveForUpdate.mockReset();
  resolveTx.mockReset();
  cancelTx.mockReset();
  callLLM.mockReset();
  audit.mockReset();
});

describe('pending-gate — snapshot path', () => {
  it('returns no_pending when there is no active row', async () => {
    findActiveSnapshot.mockResolvedValueOnce(null);
    const { checkPendingFirst } = await import('../../src/agent/pending-gate.js');
    const out = await checkPendingFirst({ pessoa, conversa, inbound });
    expect(out).toEqual({ kind: 'no_pending' });
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('calls Haiku with pergunta + opcoes_validas + inbound conteudo', async () => {
    findActiveSnapshot.mockResolvedValueOnce({
      id: 'pq-1',
      pergunta: 'Confirma?',
      opcoes_validas: [{ key: 'sim', label: 'Sim' }, { key: 'nao', label: 'Não' }],
      acao_proposta: { tool: 'register_transaction', args: { valor: 50 } },
    });
    callLLM.mockResolvedValueOnce({
      content: '{"resolves_pending":false,"confidence":0.4}',
      usage: { input_tokens: 0, output_tokens: 0 },
      tool_uses: [],
      stop_reason: 'end_turn',
      model: 'haiku',
    });
    findActiveForUpdate.mockResolvedValueOnce(null); // simulate someone else won
    const { checkPendingFirst } = await import('../../src/agent/pending-gate.js');
    const out = await checkPendingFirst({ pessoa, conversa, inbound });
    expect(callLLM).toHaveBeenCalledTimes(1);
    const args = callLLM.mock.calls[0]![0];
    expect(args.messages[0].content).toContain('Confirma?');
    expect(args.messages[0].content).toContain('sim');
    expect(out.kind).toBe('no_pending'); // re-check failed → no_pending
  });
});
```

Run: must FAIL.

- [ ] **Step 2: Implement the snapshot + classify path**

Create `src/agent/pending-gate.ts`:

```typescript
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { callLLM } from '@/lib/claude.js';
import { pendingQuestionsRepo } from '@/db/repositories.js';
import { withTx } from '@/db/client.js';
import { audit } from '@/governance/audit.js';
import type { Pessoa, Conversa, Mensagem } from '@/db/schema.js';

export type GateResult =
  | { kind: 'no_pending' }
  | {
      kind: 'resolved';
      action?: { tool: string; args: Record<string, unknown> };
      option_chosen: string;
      pending_question_id: string;
    }
  | { kind: 'unresolved'; reason: 'low_confidence' | 'topic_change' };

const CONFIDENCE_THRESHOLD = 0.7;

/**
 * Optional classifier dependency-injection. Default is the Haiku-backed
 * implementation. Tests override this to assert deterministic resolutions
 * without an LLM round-trip and without needing ANTHROPIC_API_KEY.
 */
export type Classifier = (
  snapshot: { pergunta: string; opcoes_validas: unknown },
  inbound: Mensagem,
) => Promise<ClassifyOut | null>;

let _classifier: Classifier = haikuClassifier;
export function setClassifierForTesting(c: Classifier | null): void {
  _classifier = c ?? haikuClassifier;
}

export async function checkPendingFirst(input: {
  pessoa: Pessoa;
  conversa: Conversa;
  inbound: Mensagem;
}): Promise<GateResult> {
  if (!config.FEATURE_PENDING_GATE) return { kind: 'no_pending' };

  // Step 1: snapshot read (no lock, no tx)
  let snapshot;
  try {
    snapshot = await pendingQuestionsRepo.findActiveSnapshot(input.conversa.id);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'pending_gate.snapshot_failed');
    return { kind: 'no_pending' };
  }
  if (!snapshot) return { kind: 'no_pending' };

  // Step 2: classify (OUTSIDE the lock — Haiku by default, injectable for tests)
  const resolution = await _classifier(snapshot, input.inbound);
  if (!resolution) return { kind: 'unresolved', reason: 'low_confidence' };

  // Step 3 + 4: re-check + commit (Task 9 fills this in)
  return await applyTx(snapshot.id, snapshot, resolution, input);
}

type ClassifyOut = {
  resolves_pending: boolean;
  option_chosen?: string;
  confidence: number;
  is_topic_change?: boolean;
  is_cancellation?: boolean;
};

async function haikuClassifier(
  snapshot: { pergunta: string; opcoes_validas: unknown },
  inbound: Mensagem,
): Promise<ClassifyOut | null> {
  const opts = snapshot.opcoes_validas as Array<{ key: string; label: string }>;
  const system =
    'Você classifica uma resposta do usuário a uma pergunta pendente. ' +
    'Retorne APENAS JSON: {"resolves_pending":bool,"option_chosen":string|null,"confidence":number,' +
    '"is_topic_change":bool,"is_cancellation":bool}. ' +
    'option_chosen deve ser uma das KEYS abaixo (não a label).';
  const user =
    `Pergunta: ${snapshot.pergunta}\n` +
    `Opções: ${opts.map((o) => `${o.key} (${o.label})`).join(', ')}\n` +
    `Resposta do usuário: ${inbound.conteudo ?? ''}`;
  try {
    const res = await callLLM({
      system,
      messages: [{ role: 'user', content: user }],
      max_tokens: 200,
      temperature: 0,
    });
    const text = res.content?.trim() ?? '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return JSON.parse(m[0]) as ClassifyOut;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'pending_gate.classify_failed');
    return null;
  }
}

// Stub — Task 9 fills in
async function applyTx(
  snapshot_id: string,
  snapshot: { acao_proposta: unknown; opcoes_validas: unknown },
  resolution: ClassifyOut,
  input: { pessoa: Pessoa; conversa: Conversa; inbound: Mensagem },
): Promise<GateResult> {
  void snapshot_id;
  void snapshot;
  void resolution;
  void input;
  void withTx;
  void audit;
  return { kind: 'no_pending' };
}
```

- [ ] **Step 3: Run + commit**

```bash
npx vitest run tests/unit/pending-gate.spec.ts
npx tsc --noEmit
git add src/agent/pending-gate.ts tests/unit/pending-gate.spec.ts
git commit -m "feat(b0): pending-gate snapshot + Haiku classify (no tx yet)"
```

---

## Task 9: TDD — `pending-gate` tx with re-check (resolve/cancel/race-loss)

**Files:** `src/agent/pending-gate.ts`, `tests/unit/pending-gate.spec.ts`

- [ ] **Step 1: Append tests**

Add to `tests/unit/pending-gate.spec.ts`:

```typescript
describe('pending-gate — resolve path', () => {
  it('resolves and dispatches when classify succeeds and re-check finds the row', async () => {
    findActiveSnapshot.mockResolvedValueOnce({
      id: 'pq-1',
      pergunta: 'Confirma?',
      opcoes_validas: [{ key: 'sim', label: 'Sim' }, { key: 'nao', label: 'Não' }],
      acao_proposta: { tool: 'register_transaction', args: { valor: 50 } },
    });
    callLLM.mockResolvedValueOnce({
      content: '{"resolves_pending":true,"option_chosen":"sim","confidence":0.95}',
      usage: { input_tokens: 0, output_tokens: 0 },
      tool_uses: [],
      stop_reason: 'end_turn',
      model: 'haiku',
    });
    findActiveForUpdate.mockResolvedValueOnce({
      id: 'pq-1',
      acao_proposta: { tool: 'register_transaction', args: { valor: 50 } },
    });
    resolveTx.mockResolvedValueOnce(undefined);
    const { checkPendingFirst } = await import('../../src/agent/pending-gate.js');
    const out = await checkPendingFirst({ pessoa, conversa, inbound });
    expect(out.kind).toBe('resolved');
    if (out.kind === 'resolved') {
      expect(out.option_chosen).toBe('sim');
      expect(out.action).toEqual({ tool: 'register_transaction', args: { valor: 50 } });
    }
    expect(resolveTx).toHaveBeenCalled();
  });

  it('topic change cancels the row and returns unresolved', async () => {
    findActiveSnapshot.mockResolvedValueOnce({
      id: 'pq-2',
      pergunta: 'Confirma?',
      opcoes_validas: [{ key: 'sim', label: 'Sim' }, { key: 'nao', label: 'Não' }],
      acao_proposta: {},
    });
    callLLM.mockResolvedValueOnce({
      content: '{"resolves_pending":false,"is_topic_change":true,"confidence":0.9}',
      usage: { input_tokens: 0, output_tokens: 0 },
      tool_uses: [],
      stop_reason: 'end_turn',
      model: 'haiku',
    });
    findActiveForUpdate.mockResolvedValueOnce({ id: 'pq-2', acao_proposta: {} });
    cancelTx.mockResolvedValueOnce(undefined);
    const { checkPendingFirst } = await import('../../src/agent/pending-gate.js');
    const out = await checkPendingFirst({ pessoa, conversa, inbound });
    expect(out).toEqual({ kind: 'unresolved', reason: 'topic_change' });
    expect(cancelTx).toHaveBeenCalledWith(expect.anything(), 'pq-2', 'topic_change');
  });

  it('low confidence: no DB write, audits pending_unresolved_low_confidence', async () => {
    findActiveSnapshot.mockResolvedValueOnce({
      id: 'pq-3',
      pergunta: 'Confirma?',
      opcoes_validas: [{ key: 'sim', label: 'Sim' }, { key: 'nao', label: 'Não' }],
      acao_proposta: {},
    });
    callLLM.mockResolvedValueOnce({
      content: '{"resolves_pending":false,"confidence":0.4}',
      usage: { input_tokens: 0, output_tokens: 0 },
      tool_uses: [],
      stop_reason: 'end_turn',
      model: 'haiku',
    });
    findActiveForUpdate.mockResolvedValueOnce({ id: 'pq-3', acao_proposta: {} });
    const { checkPendingFirst } = await import('../../src/agent/pending-gate.js');
    const out = await checkPendingFirst({ pessoa, conversa, inbound });
    expect(out).toEqual({ kind: 'unresolved', reason: 'low_confidence' });
    expect(resolveTx).not.toHaveBeenCalled();
    expect(cancelTx).not.toHaveBeenCalled();
    const lc = audit.mock.calls.filter((c) => c[0].acao === 'pending_unresolved_low_confidence');
    expect(lc.length).toBe(1);
  });

  it('race-loss: re-check returns null → race_lost audit + no_pending', async () => {
    findActiveSnapshot.mockResolvedValueOnce({
      id: 'pq-4',
      pergunta: 'Confirma?',
      opcoes_validas: [{ key: 'sim', label: 'Sim' }, { key: 'nao', label: 'Não' }],
      acao_proposta: {},
    });
    callLLM.mockResolvedValueOnce({
      content: '{"resolves_pending":true,"option_chosen":"sim","confidence":0.95}',
      usage: { input_tokens: 0, output_tokens: 0 },
      tool_uses: [],
      stop_reason: 'end_turn',
      model: 'haiku',
    });
    findActiveForUpdate.mockResolvedValueOnce(null);
    const { checkPendingFirst } = await import('../../src/agent/pending-gate.js');
    const out = await checkPendingFirst({ pessoa, conversa, inbound });
    expect(out).toEqual({ kind: 'no_pending' });
    const lost = audit.mock.calls.filter((c) => c[0].acao === 'pending_race_lost');
    expect(lost.length).toBe(1);
    expect(lost[0][0].metadata.pending_question_id).toBe('pq-4');
  });
});
```

Run: must FAIL (applyTx is a stub).

- [ ] **Step 2: Implement `applyTx`**

Replace the stub in `src/agent/pending-gate.ts`:

```typescript
async function applyTx(
  snapshot_id: string,
  snapshot: { acao_proposta: unknown; opcoes_validas: unknown },
  resolution: ClassifyOut,
  input: { pessoa: Pessoa; conversa: Conversa; inbound: Mensagem },
): Promise<GateResult> {
  return await withTx(async (tx) => {
    const locked = await pendingQuestionsRepo.findActiveForUpdate(tx, input.conversa.id);
    if (!locked || locked.id !== snapshot_id) {
      // Race lost — someone else resolved or cancelled while Haiku was running.
      await audit({
        acao: 'pending_race_lost',
        pessoa_id: input.pessoa.id,
        conversa_id: input.conversa.id,
        mensagem_id: input.inbound.id,
        metadata: { pending_question_id: snapshot_id },
      });
      return { kind: 'no_pending' as const };
    }

    if (resolution.is_topic_change || resolution.is_cancellation) {
      await pendingQuestionsRepo.cancelTx(tx, snapshot_id, 'topic_change');
      await audit({
        acao: 'pending_unresolved_topic_change',
        pessoa_id: input.pessoa.id,
        conversa_id: input.conversa.id,
        mensagem_id: input.inbound.id,
        alvo_id: snapshot_id,
      });
      return { kind: 'unresolved' as const, reason: 'topic_change' as const };
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
      return { kind: 'unresolved' as const, reason: 'low_confidence' as const };
    }

    await pendingQuestionsRepo.resolveTx(tx, snapshot_id, {
      option_chosen: resolution.option_chosen,
      confidence: resolution.confidence,
    });
    await audit({
      acao: 'pending_resolved_by_gate',
      pessoa_id: input.pessoa.id,
      conversa_id: input.conversa.id,
      mensagem_id: input.inbound.id,
      alvo_id: snapshot_id,
      metadata: { option_chosen: resolution.option_chosen },
    });

    const action = (snapshot.acao_proposta ?? {}) as {
      tool?: string;
      args?: Record<string, unknown>;
    };
    return {
      kind: 'resolved' as const,
      action: action.tool ? { tool: action.tool, args: action.args ?? {} } : undefined,
      option_chosen: resolution.option_chosen!,
      pending_question_id: snapshot_id,
    };
  });
}
```

- [ ] **Step 3: Run + commit**

```bash
npx vitest run tests/unit/pending-gate.spec.ts
npx tsc --noEmit
git add src/agent/pending-gate.ts tests/unit/pending-gate.spec.ts
git commit -m "feat(b0): pending-gate tx with re-check (resolve/cancel/race-loss)"
```

---

## Task 10: Wire gate into `src/agent/core.ts`

**Files:** `src/agent/core.ts`

- [ ] **Step 1: Add imports**

```typescript
import { checkPendingFirst } from '@/agent/pending-gate.js';
import { dispatchTool } from '@/tools/_dispatcher.js'; // already imported; confirm
```

- [ ] **Step 2: Insert gate call**

After the `loadConversaWithPessoa` block (which yields `{ conversa: c, pessoa }`) and **before** the `buildPrompt(...)` call, insert:

```typescript
const gate = await checkPendingFirst({ pessoa, conversa: c, inbound });
if (gate.kind === 'resolved') {
  if (gate.action) {
    const args = { ...gate.action.args, _pending_choice: gate.option_chosen };
    await dispatchTool({
      tool: gate.action.tool,
      args,
      ctx: {
        pessoa,
        scope: await resolveScope(pessoa),
        conversa: c,
        mensagem_id: inbound.id,
        request_id: uuid(),
      },
    });
    await audit({
      acao: 'pending_action_dispatched',
      pessoa_id: pessoa.id,
      conversa_id: c.id,
      mensagem_id: inbound.id,
      metadata: { tool: gate.action.tool, pending_question_id: gate.pending_question_id },
    });
  }
  await mensagensRepo.markProcessed(inbound.id, 0);
  await conversasRepo.touch(c.id);
  return;
}
// 'unresolved' and 'no_pending' fall through to the existing ReAct flow.
```

- [ ] **Step 3: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/agent/core.ts
git commit -m "feat(b0): wire pending-gate into agent loop before LLM"
```

---

## Task 11: Persist `pending_question_id` on outbound rows

**Files:** `src/agent/core.ts`

The `sendOutbound` helper today writes a `mensagens` row with `metadata: { whatsapp_id, in_reply_to }`. We extend it with `pending_question_id` and track the most recently created pending in a turn-local variable.

**Idempotency-cache hazard**: the dispatcher caches tool results keyed by a 5-min bucket (`src/governance/idempotency.ts`). A retry within the same bucket returns the cached `{ pending_question_id }`. If that pending was meanwhile resolved or cancelled by another path, stamping the stale id onto a fresh outbound is wrong. We mitigate by re-validating the cached id is still active right before stamping — cheap, and safe at the cache miss case too.

- [ ] **Step 1: Declare `latestPendingId` ABOVE the outer `for (let i ...)` loop**

In `src/agent/core.ts`, find the line that reads:

```typescript
const conversation: LLMMessage[] = messages;
```

Immediately AFTER it (line ~71 in current main; line will shift slightly after Task 10), add:

```typescript
let latestPendingId: string | null = null;
```

This survives across ReAct iterations within the turn.

- [ ] **Step 2: Capture the id INSIDE the inner `for (const tu of res.tool_uses)` loop (with re-validation)**

After the existing `const out = await dispatchTool({ ... })` call (around line ~110 in current main; same line after Task 10), add:

```typescript
if (
  tu.tool === 'ask_pending_question' &&
  typeof out === 'object' &&
  out !== null &&
  'pending_question_id' in out &&
  typeof (out as { pending_question_id: string }).pending_question_id === 'string'
) {
  const candidate = (out as { pending_question_id: string }).pending_question_id;
  // Re-validate that the candidate is still 'aberta'. Defends against
  // dispatcher-cache returning a stale id from a prior retry within the
  // 5-min idempotency bucket.
  const stillActive = await pendingQuestionsRepo
    .findActiveSnapshot(c.id)
    .catch(() => null);
  if (stillActive && stillActive.id === candidate) {
    latestPendingId = candidate;
  } else {
    logger.warn(
      { tool: tu.tool, candidate, conversa_id: c.id },
      'agent.stale_pending_id_dropped',
    );
  }
}
```

Add the `pendingQuestionsRepo` import alongside the other repo imports at the top of `core.ts` if not already present.

- [ ] **Step 3: Extend `sendOutbound` signature**

```typescript
async function sendOutbound(
  pessoa_id: string,
  conversa_id: string,
  text: string,
  in_reply_to: string,
  opts?: { pending_question_id?: string | null },
): Promise<void> {
  const pessoa = await pessoasRepo.findById(pessoa_id);
  if (!pessoa) return;
  const jid = pessoa.telefone_whatsapp.replace('+', '') + '@s.whatsapp.net';
  const wid = await sendOutboundText(jid, text);
  const metadata: Record<string, unknown> = { whatsapp_id: wid, in_reply_to };
  if (opts?.pending_question_id) metadata.pending_question_id = opts.pending_question_id;
  await mensagensRepo.create({
    conversa_id,
    direcao: 'out',
    tipo: 'texto',
    conteudo: text,
    midia_url: null,
    metadata,
    processada_em: new Date(),
    ferramentas_chamadas: [],
    tokens_usados: null,
  });
}
```

- [ ] **Step 4: Pass it at the call site**

In the ReAct loop where `sendOutbound(pessoa.id, c.id, text, inbound.id)` is invoked, change to:

```typescript
await sendOutbound(pessoa.id, c.id, text, inbound.id, {
  pending_question_id: latestPendingId,
});
```

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/agent/core.ts
git commit -m "feat(b0): persist pending_question_id on outbound mensagens (B1 prereq)"
```

---

## Task 12: Integration test — concurrency proof

**Files:** `tests/integration/pending-gate-concurrency.spec.ts`

- [ ] **Step 1: Write the test**

```typescript
/**
 * B0 concurrency proof: two parallel checkPendingFirst against the same
 * pending must dispatch the action exactly once. Skipped without TEST_DB_URL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { mkEntidade } from '../factories/db.js';

const SHOULD_RUN = !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

let pool: pg.Pool;

d('pending-gate concurrency', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('dispatches action exactly once under parallel resolves', async () => {
    const c = await pool.connect();
    try {
      // Set up: one pessoa, one conversa, one open pending
      const pessoa = await c.query<{ id: string }>(
        `INSERT INTO pessoas(nome, telefone_whatsapp, tipo)
         VALUES ('test', '+5511900000001', 'funcionario') RETURNING id`,
      );
      const conv = await c.query<{ id: string }>(
        `INSERT INTO conversas(pessoa_id, escopo_entidades) VALUES ($1, '{}') RETURNING id`,
        [pessoa.rows[0]!.id],
      );
      const pq = await c.query<{ id: string }>(
        `INSERT INTO pending_questions(conversa_id, pessoa_id, tipo, pergunta, opcoes_validas, acao_proposta, expira_em, status)
         VALUES ($1, $2, 'gate', 'Confirma?', $3::jsonb, $4::jsonb, now() + interval '10 min', 'aberta')
         RETURNING id`,
        [
          conv.rows[0]!.id,
          pessoa.rows[0]!.id,
          JSON.stringify([{ key: 'sim', label: 'Sim' }, { key: 'nao', label: 'Não' }]),
          JSON.stringify({ tool: 'register_transaction', args: { valor: 50 } }),
        ],
      );
      void pq;

      // Two parallel resolves via checkPendingFirst. We inject a deterministic
      // classifier (no Haiku) so the test is self-contained and doesn't require
      // ANTHROPIC_API_KEY in CI.
      process.env.FEATURE_PENDING_GATE = 'true';
      const gateModule = await import('../../src/agent/pending-gate.js');
      const { checkPendingFirst, setClassifierForTesting } = gateModule;
      setClassifierForTesting(async () => ({
        resolves_pending: true,
        option_chosen: 'sim',
        confidence: 0.95,
      }));

      const inbound = { id: 'm-test', conteudo: 'sim' };
      const conversa = { id: conv.rows[0]!.id };
      const persona = { id: pessoa.rows[0]!.id };

      const [a, b] = await Promise.all([
        checkPendingFirst({ pessoa: persona as never, conversa: conversa as never, inbound: inbound as never }),
        checkPendingFirst({ pessoa: persona as never, conversa: conversa as never, inbound: inbound as never }),
      ]);

      // Exactly one resolved
      const resolvedCount = [a, b].filter((x) => x.kind === 'resolved').length;
      expect(resolvedCount).toBe(1);

      // The row is now 'respondida'
      const final = await c.query<{ status: string }>(
        `SELECT status FROM pending_questions WHERE conversa_id = $1`,
        [conv.rows[0]!.id],
      );
      expect(final.rows[0]!.status).toBe('respondida');

      // Cleanup
      await c.query('DELETE FROM pending_questions WHERE conversa_id = $1', [conv.rows[0]!.id]);
      await c.query('DELETE FROM conversas WHERE id = $1', [conv.rows[0]!.id]);
      await c.query('DELETE FROM pessoas WHERE id = $1', [pessoa.rows[0]!.id]);
      setClassifierForTesting(null); // restore default Haiku classifier
    } finally {
      c.release();
    }
  });
});
```

The test only needs `TEST_DB_URL`; `ANTHROPIC_API_KEY` is not required because we inject the classifier.

- [ ] **Step 2: Run if env is set, otherwise confirm skip**

```
npx vitest run tests/integration/pending-gate-concurrency.spec.ts
```

Expected: skipped without env, passes with env.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/pending-gate-concurrency.spec.ts
git commit -m "test(b0): concurrency proof — exactly-once dispatch under parallel resolves"
```

---

## Task 13: Final gate + push + open PR

**Files:** none modified.

- [ ] **Step 1: Run unit suite**

Run: `npx vitest run tests/unit`
Expected: all relevant new tests green; pre-existing module-load failures unchanged.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: only pre-existing errors.

- [ ] **Step 3: Push & open PR**

```bash
git push -u origin feat/whatsapp-b0-pending-gate
gh pr create --base main --title "feat(b0): pending-question lifecycle wiring" \
  --body "Implements docs/superpowers/specs/2026-04-29-whatsapp-b0-pending-gate-design.md. Hard prerequisite for B1 (one-tap resolution). Gated behind FEATURE_PENDING_GATE=false."
```

---

## Acceptance verification (mirrors spec §12)

- [ ] Migration 004 applies cleanly (Task 3).
- [ ] `ask_pending_question` rejects non-affirmative-first binary opcoes (Task 6 test).
- [ ] `FEATURE_PENDING_GATE=true` + text answer in TTL → action dispatches with `_pending_choice` (Tasks 9-10).
- [ ] Off-topic answer → `pending_unresolved_topic_change` audit; LLM gets fresh turn (Tasks 9-10).
- [ ] `FEATURE_PENDING_GATE=false` → `checkPendingFirst` returns `no_pending` immediately (Task 8).
- [ ] Concurrency: parallel resolves dispatch action exactly once (Task 12).
- [ ] Lightweight helpers `@deprecated` + grep test (Task 5).
- [ ] Outbound rows authored during `ask_pending_question` turn carry `metadata.pending_question_id` (Task 11).
