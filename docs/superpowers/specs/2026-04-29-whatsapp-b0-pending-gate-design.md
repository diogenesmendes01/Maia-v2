# WhatsApp B0 — Pending-Question Lifecycle Wiring — Design

**Date:** 2026-04-29
**Status:** Approved (in brainstorm), pending spec review and user review.
**Scope:** Hard prerequisite for sub-project B1 (one-tap resolution). Without B0, the agent has no pending lifecycle to attach polls or reactions to.
**Depends on:** spec 06 (agent loop), spec 09 (governance, audit taxonomy), `pending_questions` table (already in `migrations/001_initial.sql`), `applyResolution` and `getActivePending` (already in `src/workflows/pending-questions.ts`).

---

## 1. Purpose

The agent today never persists a pending question. `pending_questions` is a populated table only by the dual-approval and quarantine flows (PR #2 quarantine). The lightweight-metadata variant in `setLightweightPending` is dead code at the agent layer. As a result:

- Maia can't ask "Qual categoria?" and resume the answer two turns later.
- A user reply that *would* resolve a pending is parsed by the full LLM as if it were a new turn — losing context, sometimes triggering wrong tools.
- Sub-project B1 (poll/reaction → pending resolution) has no pending lifecycle to hook into.

B0 fixes this gap minimally: one tool that creates pendings, one pre-LLM gate that resolves them, and a transactional `applyResolution` that survives concurrent attempts.

## 2. Goals

- Single source of truth for pending-question state: the `pending_questions` table.
- Atomic resolve: two concurrent attempts on the same pending never both fire `acao_proposta`.
- Pre-LLM gate: a user reply that resolves a pending bypasses the full ReAct loop.
- Outbound `mensagens` rows authored during a pending-creating turn carry `metadata.pending_question_id` so B1 can reverse-look-up.
- Feature-flagged: `FEATURE_PENDING_GATE=false` keeps current behaviour.

## 3. Non-goals

- Reactions / polls — sub-project B1.
- Multiple **simultaneous** pendings per conversa. We support one active at a time (the spec/§4.1 enforces this with a partial unique index). The table model can hold many, but the gate only consumes the most recent active one.
- Migration of existing pending rows — there are effectively none at runtime today.
- Replacing `dual-approval` workflow's own pending-state. That flow lives in `src/workflows/dual-approval.ts` and remains independent.
- Reopening a resolved pending after a user "changes their mind" mid-flight. A new turn = a new question if the user wants.

## 4. Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│  src/agent/core.ts                                                        │
│    runAgentForMensagem                                                    │
│      ├─ resolveIdentity            (existing)                             │
│      ├─ rate-limit                 (existing)                             │
│      ├─ checkPendingFirst (NEW)    ┐                                     │
│      │     no_pending  → continue  │                                     │
│      │     resolved    → dispatch action, mark processed, return          │
│      │     unresolved  → continue with normal LLM flow                    │
│      ├─ buildPrompt + ReAct loop   (existing, with one new tool exposed)  │
│      └─ sendOutbound (extended to persist pending_question_id when set)   │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│  src/agent/pending-gate.ts (NEW)                                          │
│    checkPendingFirst({ pessoa, conversa, inbound })                       │
│      ├─ load active pending (FOR UPDATE inside a tx)                      │
│      ├─ classify inbound via Haiku → IntentResolution                     │
│      ├─ applyResolution (table-aware, transactional)                      │
│      └─ return { kind, action? }                                          │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│  src/tools/ask-pending-question.ts (NEW)                                  │
│    name: 'ask_pending_question'                                           │
│    side_effect: 'communication'                                           │
│    handler: validate → INSERT pending_questions row → return { id }       │
└──────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Schema additions (constraint, no new tables)

`pending_questions` already exists. Add **one partial unique index** to enforce "one active pending per conversa" at the DB level:

```sql
-- migrations/004_pending_one_active_per_conversa.sql
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pending_questions_active_per_conversa
  ON pending_questions (conversa_id)
  WHERE status = 'aberta';
```

The tool handler tolerates a duplicate-violation by closing the prior active pending first (within the same tx) and inserting the new one. This guarantees the gate never sees ambiguous state.

### 4.2 New tool: `ask_pending_question`

```typescript
// src/tools/ask-pending-question.ts
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

const outputSchema = z.object({
  pending_question_id: z.string().uuid(),
});
```

Handler steps (transactional):

1. Validate `opcoes_validas.length ∈ [2,12]`.
2. **Affirmative-first guard for binary**: when `length === 2`, the **first** key MUST match `/^(sim|s[ií]m?|aprova|aprovo|confirma|confirmo|libera|ok|pode|positivo)$/i` and the **second** `/^(n[ãa]o|cancela|cancelo|bloqueia|bloqueio|nega|recusa|recuso|negativo)$/i`. If not, reject with `error: 'binary_options_must_be_affirmative_first'`. The contract is documented for B1 generators: imperative ("Confirma"), 1ps ("Confirmo"), and short-form ("OK", "Sim") all match. The same regex is reused as a sanity check at gate-classify time so divergence surfaces.
3. Close any other `aberta` pending on the same `conversa_id`. Status enum in migration 002 §117 is `('aberta','respondida','expirada','cancelada')` — we reuse `'cancelada'` and stamp `metadata.cancel_reason='substituted'` rather than introducing a new enum value. Concretely: `UPDATE pending_questions SET status='cancelada', metadata = metadata || '{"cancel_reason":"substituted"}'::jsonb WHERE conversa_id=$1 AND status='aberta'`. Audit `pending_substituted` carries the prior id.
4. Insert new row with `expira_em = now() + (ttl_minutes ?? config.PENDING_QUESTION_TTL_MINUTES) * interval '1 min'`.
5. Audit `pending_created`.
6. Return `pending_question_id`.

The tool does NOT send any text to the user. The LLM still has to phrase the question in its next text response — Maia's outbound message during the same turn is what the user actually sees. The agent loop links the two by stamping `metadata.pending_question_id` onto the outbound `mensagens` row when the previous tool dispatch in the turn was `ask_pending_question` (see §4.5).

### 4.3 New module: `src/agent/pending-gate.ts`

```typescript
export async function checkPendingFirst(input: {
  pessoa: Pessoa;
  conversa: Conversa;
  inbound: Mensagem;
}): Promise<
  | { kind: 'no_pending' }
  | { kind: 'resolved'; action?: { tool: string; args: Record<string, unknown> } }
  | { kind: 'unresolved'; reason: 'low_confidence' | 'topic_change' }
>;
```

Sequence — **the LLM call runs OUTSIDE the row lock** so we never hold a Postgres lock across a 1-5s network call (anti-pattern):

1. **Read-only snapshot** (no transaction): `SELECT * FROM pending_questions WHERE conversa_id=$1 AND status='aberta' AND expira_em > now() ORDER BY created_at DESC LIMIT 1`. If none, return `{ kind: 'no_pending' }`.
2. Call Haiku with a **focused** prompt: the snapshot's `pergunta`, `opcoes_validas`, and the user's inbound text. Force JSON output matching `IntentResolutionSchema` (already in `pending-questions.ts`). Confidence threshold: `0.7`.
3. **Write transaction** with re-check: `BEGIN; SELECT ... FOR UPDATE` the same `pq.id`. If the row's `status` is no longer `'aberta'` OR `expira_em <= now()`, `ROLLBACK` and return `{ kind: 'no_pending' }` (someone else won, or it expired during our LLM call).
4. Within the same tx, branch on the resolution:
   - `is_topic_change` / `is_cancellation` → `UPDATE ... SET status='cancelada' WHERE id=$1`. `COMMIT`. Return `{ kind: 'unresolved', reason: 'topic_change' }`. Audit `pending_unresolved_topic_change`.
   - `resolves_pending && confidence >= 0.7 && option_chosen ∈ opcoes_validas.key` → `UPDATE ... SET status='respondida', resolvida_em=now(), resposta=$2 WHERE id=$1`. `COMMIT`. Audit `pending_resolved_by_gate`. Return `{ kind: 'resolved', action: pq.acao_proposta }`.
   - Otherwise → `ROLLBACK` (no state change). Return `{ kind: 'unresolved', reason: 'low_confidence' }`. Audit `pending_unresolved_low_confidence`.

**Concurrency analysis**:
- The lock is held only for the duration of one `SELECT ... FOR UPDATE` plus a single `UPDATE` — milliseconds, no LLM in scope.
- Two concurrent gate calls each pay one Haiku call (intentional cost — sub-second redundancy on a same-pending race). Whichever commits the resolve first wins; the other sees `status != 'aberta'` on re-check and returns `'no_pending'`. The losing call's audit row writes `pending_unresolved_low_confidence` with `metadata.lost_race=true` so the wasted spend is observable in cost monitoring.
- `expira_em` is re-checked at SELECT-FOR-UPDATE time. If TTL elapsed during the LLM call, treat as `'no_pending'` (no resolution, no cancellation — the existing `pending_expirer` worker will eventually flip the row to `'expirada'`).

### 4.4 Agent loop change

In `src/agent/core.ts`, between rate-limit and `buildPrompt`:

```typescript
const gate = await checkPendingFirst({ pessoa, conversa: c, inbound });
if (gate.kind === 'resolved') {
  if (gate.action) {
    // Existing applyResolution contract injects _pending_choice into args
    // (src/workflows/pending-questions.ts:93). Preserve it here so
    // downstream tools that key off the chosen option keep working.
    const args = { ...gate.action.args, _pending_choice: gate.option_chosen };
    await dispatchTool({
      tool: gate.action.tool,
      args,
      ctx: { pessoa, scope, conversa: c, mensagem_id: inbound.id, request_id: uuid() },
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

The `gate` shape for `'resolved'` therefore extends to:

```typescript
| { kind: 'resolved'; action?: { tool: string; args: Record<string, unknown> }; option_chosen: string; pending_question_id: string }
```

Gated by `config.FEATURE_PENDING_GATE` — when `false`, `checkPendingFirst` short-circuits and returns `{ kind: 'no_pending' }` without touching the DB or calling Haiku.

### 4.5 Outbound mensagens persistence

`sendOutbound` in `core.ts` gains an optional argument:

```typescript
async function sendOutbound(
  pessoa_id: string,
  conversa_id: string,
  text: string,
  in_reply_to: string,
  opts?: {
    quoted?: WAQuotedContext; // from sub-project A
    pending_question_id?: string; // NEW (B0)
  },
): Promise<void>;
```

When the previous tool dispatched in the same turn was `ask_pending_question` and returned a `pending_question_id`, the agent loop captures that id and passes it on the next `sendOutbound`. The mensagens row now carries `metadata.pending_question_id`, satisfying the reverse-lookup precondition for sub-project B1.

The agent loop tracks "the most recent pending_question_id created this turn" with a single local variable; if `ask_pending_question` is called multiple times in a turn (rare), the last one wins. The B1 design assumes at most one outbound message per turn (already true today; spec A §5.4 also documents this invariant).

### 4.6 Repository extension (transactional helpers)

`pendingQuestionsRepo` today (`src/db/repositories.ts:480`) uses the global `db` and exposes only non-transactional methods. The gate needs three new methods that accept a `pg.PoolClient` (or the Drizzle-equivalent transactional client):

```typescript
// Adds to src/db/repositories.ts
export const pendingQuestionsRepo = {
  // ...existing methods...

  /** Snapshot read (no lock) — used by checkPendingFirst step 1. */
  async findActiveSnapshot(conversa_id: string): Promise<PendingQuestion | null>,

  /** Locked read inside a tx — used by checkPendingFirst step 3 re-check. */
  async findActiveForUpdate(client: PoolClient, conversa_id: string): Promise<PendingQuestion | null>,

  /** Tx-scoped resolve. Updates status='respondida', resolvida_em, resposta. */
  async resolveTx(client: PoolClient, id: string, resposta: unknown): Promise<void>,

  /** Tx-scoped cancel. Updates status='cancelada', stamps cancel_reason. */
  async cancelTx(client: PoolClient, id: string, reason: string): Promise<void>,

  /** Used by ask_pending_question's "close prior open" step — non-tx variant for the tool handler's own tx. */
  async cancelOpenForConversaTx(client: PoolClient, conversa_id: string, reason: string): Promise<{ cancelled_ids: string[] }>,
};
```

Existing methods (`create`, `findOpen`, `resolve`, `expireDue`) are left intact — the dual-approval pathway and quarantine flow continue to use them unchanged.

### 4.7 Lightweight-helper deprecation

`setLightweightPending`, `getActivePending`, and `clearLightweightPending` in `src/workflows/pending-questions.ts` are marked `@deprecated` in JSDoc with a one-line "use pendingQuestionsRepo + pending-gate instead" pointer. **No callers remove or rewrite their behaviour** — they coexist. A grep-based unit test (no custom lint rule needed) asserts:

```
- src/agent/** has zero references to setLightweightPending / getActivePending / clearLightweightPending.
- src/workflows/dual-approval.ts may continue to reference them (its flow is not migrated in B0).
```

The legacy path dies naturally as nothing new references it.

## 5. Audit-action additions

Append to `src/governance/audit-actions.ts`:

```typescript
'pending_created',
'pending_resolved_by_gate',           // distinct from existing 'pending_resolved' which today is unused
'pending_unresolved_topic_change',
'pending_unresolved_low_confidence',
'pending_substituted',                // when a new ask replaces an open one
'pending_action_dispatched',
```

## 6. Concurrency

- `checkPendingFirst` runs in a single Postgres transaction; `SELECT ... FOR UPDATE` serialises concurrent attempts.
- `ask_pending_question` handler runs in a single transaction (close-prior + insert-new). The partial unique index `uniq_pending_questions_active_per_conversa` is the safety net if a non-transactional caller ever forgets.
- Idempotency for the action dispatch: when the gate calls `dispatchTool` with the resolved action, the existing dispatcher idempotency layer (`computeIdempotencyKey` per spec 09) deduplicates side-effect tools. A retry caused by transient gate failure will not double-spend.

## 7. Error handling

- DB unavailable in `checkPendingFirst`: log warn + return `{ kind: 'no_pending' }`. The user message goes through the normal LLM flow. Pending-resolve-by-text is delayed but functional once DB recovers.
- Haiku unavailable: fallback to Sonnet via existing `callLLM` retry; if both fail, return `{ kind: 'unresolved', reason: 'low_confidence' }` and let the main LLM try.
- `ask_pending_question` handler failure: the tool returns `{ error: 'execution_failed' }` per existing dispatcher contract. The LLM sees the error and can apologise / retry.

## 8. Configuration

New env: `FEATURE_PENDING_GATE` (default `false`).

When `false`:
- `ask_pending_question` is registered but the gate never reads pending rows. Maia behaves like today (the LLM has to remember the pending it asked about itself).

When `true`:
- Full gate active.

Validation criteria for default-on flip:
- 30+ pendings created across at least two pessoas during the trial week.
- ≥ 80% of trial pendings resolved within TTL by either gate-text-match or gate-topic-change.
- Zero `pending_action_dispatched` audits where the same `acao_proposta` was dispatched twice for the same pending row.

## 9. Schema migration

Single migration `migrations/004_pending_one_active_per_conversa.sql`:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pending_questions_active_per_conversa
  ON pending_questions (conversa_id)
  WHERE status = 'aberta';
```

The status CHECK constraint already permits `'cancelada'`, which is what the substitution path uses (with `metadata.cancel_reason='substituted'` for traceability). No CHECK extension required — keeps the migration footprint to a single index.

**Failure recovery**: if any conversa already has multiple `aberta` rows when the migration applies (unlikely — none in production today, the lifecycle is unwired), the index creation fails with a duplicate-key error. Recovery is operator-facing, not automatic:

```sql
-- one-shot helper (run before re-applying migration 004)
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

This script collapses each conversa's open-pending set to the single most-recent. The script lives in `scripts/recover-pending-dupes.sql` and is referenced from the migration's header comment so an operator who hits the failure has an immediate path forward.

## 10. Testing

### Unit
- `tools/ask-pending-question.spec.ts`: schema validation, affirmative-first enforcement on binary, ttl default.
- `agent/pending-gate.spec.ts`: classify resolve / topic change / low confidence; mock Haiku; mock pg client; verify `applyResolutionTx` calls.
- `governance/audit-actions.spec.ts`: closed-taxonomy still includes the new actions.

### Integration (TEST_DB_URL)
- **Concurrency proof**: spawn two `checkPendingFirst` against the same conversa; assert exactly one returns `kind: 'resolved'`, the other `'no_pending'`. The action is dispatched at most once. Both Haiku calls happen (intentional — see §6); the loser's audit row carries `metadata.lost_race=true`.
- **TTL-mid-call**: stub Haiku to delay 200ms; manually flip `expira_em` to a past timestamp during the delay; assert the gate's re-check observes expiration and returns `'no_pending'` without flipping status.
- **Substitution**: call `ask_pending_question` twice in a row; assert the first row is `status='cancelada'` with `metadata.cancel_reason='substituted'`, the second is `'aberta'`.
- Migration: applies cleanly to a seeded DB; rejects a synthetic duplicate `aberta` row.
- Tool happy path: handler inserts row; gate finds it; resolution updates row.
- **Colloquial replies**: feed the gate inputs like `'uhum'`, `'blz'`, `'opa'` against a binary pending — assert `low_confidence` path triggers and the row stays `'aberta'`.

## 11. Out of scope (future sub-projects)

| Item | Sub-project |
|---|---|
| Polls / reactions resolving pendings | B1 |
| Quoting outbound for `messages.update` lookup | B2 |
| View-once on sensitive replies | B3a |
| PDF / chart export | B3b |
| Voice-note polish | B4 |
| Multi-active pendings per conversa | post-B |
| Reopen-resolved pending | post-B |

## 12. Acceptance criteria

- [ ] Migration `004_pending_one_active_per_conversa.sql` applies cleanly.
- [ ] `ask_pending_question` tool registered; rejects binary opcoes that violate affirmative-first (test with concrete inputs).
- [ ] `FEATURE_PENDING_GATE=true`: a pending created in turn N is resolvable by a text answer in turn N+1; the proposed action dispatches; audit `pending_action_dispatched` written.
- [ ] `FEATURE_PENDING_GATE=true`: an off-topic answer (e.g. "lança 50 mercado" while pending asked "qual cor da empresa?") yields `pending_unresolved_topic_change` and the LLM gets the fresh turn.
- [ ] `FEATURE_PENDING_GATE=false`: gate returns `no_pending` immediately; current behaviour preserved.
- [ ] Concurrency integration test: two parallel resolves dispatch the action exactly once.
- [ ] `setLightweightPending`, `getActivePending`, `clearLightweightPending` are JSDoc-deprecated; no agent-side callers (lint check).
- [ ] Outbound rows authored during an `ask_pending_question` turn persist `metadata.pending_question_id`.

## 13. References

- Spec 06 — agent loop
- Spec 09 — pending lifecycle, audit taxonomy
- Sub-project A design — `docs/superpowers/specs/2026-04-29-whatsapp-ux-polish-design.md`
- B1 paused design — `docs/superpowers/specs/2026-04-29-whatsapp-b1-one-tap-design.md` (resumes after B0 lands)
- `src/workflows/pending-questions.ts` — `applyResolution`, `IntentResolution`
- `src/db/schema.ts` — `pending_questions` table
- `migrations/001_initial.sql` — original `pending_questions` schema
