# WhatsApp B1 — One-Tap Resolution of Pending Questions — Design (v2)

**Date:** 2026-04-29 (v2; supersedes the paused v1 of 2026-04-29)
**Status:** Approved (in brainstorm), pending spec review and user review.
**Scope:** Sub-project B1 of five WhatsApp brainstorm tracks. v1 was paused because the agent loop never persisted pendings. **B0 (PR #12) shipped the lifecycle**, so v2 is unblocked.
**Depends on:** sub-project A (presence module — PR #11), B0 (pending-gate — PR #12), spec 04 (gateway), spec 06 (agent loop), `pending_questions` table.

---

## 1. Purpose

Resolve a WhatsApp `pending_question` with a single tap — emoji reaction or poll vote — instead of typing. Text continues to work in parallel. Both new paths funnel through the **same** transactional resolve B0 introduced; no duplicate logic, no race surface.

## 2. What changed since v1

The original v1 review found 7 blockers. B0 closed all of them:

| v1 blocker | Resolved by |
|---|---|
| `pq.id` ambiguity (lightweight metadata vs. table) | B0 made `pending_questions` table the single source of truth at the agent layer |
| `applyResolution` non-transactional | B0's gate uses `pendingQuestionsRepo.resolveTx` inside `withTx` + `FOR UPDATE` |
| Stale-pending lookup | B0's gate re-validates inside the tx (`findActiveForUpdate`); same pattern reused here |
| Outbound persistence path missing | B0 stamps `metadata.pending_question_id` on outbound rows (B1 prereq satisfied) |
| Audit naming drift | B0's closed-taxonomy includes `pending_resolved_by_gate`, `pending_action_dispatched`, `pending_race_lost`. B1 adds two more for source attribution |
| Greenfield ("no callers") | B0's `ask_pending_question` tool is the canonical caller |
| Vote-flip semantics | B0 short-circuits on already-resolved pendings; later votes are dropped (audited) |

## 3. Goals

- Reactions (✅ / ❌) resolve **binary** pendings with affirmative-first opcoes (B0's guard already enforces this on the send side).
- Polls (WhatsApp's native UI) resolve pendings with **3–12** opcoes.
- Both paths reuse a single helper that the gate and the inbound handlers share, so resolution semantics (idempotency, race-loss, audit trail) are identical.
- Feature-flagged behind `FEATURE_ONE_TAP=false` until validated.
- Zero regression: when the flag is off, the gateway's reaction/poll-vote prefix branches are no-ops; outbound never sends polls.

## 4. Non-goals

- Multi-select polls.
- Polls with > 12 options.
- Reactions on outbound messages **without** a pending tied to them (those remain silent acks for tool side-effects per sub-project A).
- Polls initiated by the user.
- Persisting reactions / poll-vote events as new `mensagens` rows. The parent's `metadata` is the audit anchor.

## 5. Architecture

### 5.1 Shared helper (refactor of B0's gate-internal logic)

B0's `applyTx` inside `pending-gate.ts` is private. We extract a public helper that both the gate and the new B1 inbound handlers call:

```typescript
// src/agent/pending-resolver.ts (new)
export type ResolveSource = 'gate' | 'reaction' | 'poll_vote';

export async function resolveAndDispatch(input: {
  pessoa_id: string;
  conversa_id: string;
  mensagem_id: string;            // the inbound that triggered the resolution
  expected_pending_id: string;     // from the inbound's source (gate snapshot, reaction parent, poll parent)
  option_chosen: string;
  confidence: number;              // 1.0 for one-tap; <1 for gate's Haiku
  source: ResolveSource;
}): Promise<{ resolved: boolean; action?: { tool: string; args: Record<string, unknown> } }>;
```

The body is essentially what `applyTx` does today in B0's gate, parameterised on `source` and on `expected_pending_id`. The gate is refactored to call `resolveAndDispatch` after its Haiku classification produces `option_chosen`. B1's handlers call the same function with `confidence: 1.0` and the deterministic `option_chosen`.

Audit `acao` carries `source`, so the trail distinguishes `pending_resolved_by_gate` (Haiku) from `pending_resolved_by_reaction` and `pending_resolved_by_poll`.

### 5.2 Send-side: poll for 3–12 options

`presence.sendPoll` (new):

```typescript
export async function sendPoll(
  remote_jid: string,
  question: string,
  options: ReadonlyArray<{ key: string; label: string }>,
  opts?: { quoted?: WAQuotedContext },
): Promise<{ whatsapp_id: string | null; option_keys: string[] }>;
```

Uses `socket.sendMessage(jid, { poll: { name: question, values: labels, selectableCount: 1 } })`. Returns the WAID (so the agent loop can stamp `pending_question_id` and the key↔label mapping on the outbound `mensagens` row) plus the `option_keys` in the same order as the labels (so the receive-side can recover the key from the index of the user's pick).

When `FEATURE_ONE_TAP=false` OR Baileys is disconnected, `sendPoll` returns `{ whatsapp_id: null, option_keys: [] }` — caller falls back to the existing text-list path.

### 5.3 Send-side: agent loop decision

Currently the agent loop, after `ask_pending_question` is dispatched, sends the question as plain text via `sendOutbound`. We extend `sendOutbound` (or add a sibling) so when `latestPendingId` is set AND `FEATURE_ONE_TAP=true` AND the pending's `opcoes_validas.length ∈ [3,12]`, a poll is sent instead of plain text. The mensagens row metadata then carries:

```typescript
metadata: {
  whatsapp_id, in_reply_to,
  pending_question_id,            // already from B0
  poll_options: [{ key, label }], // NEW (poll branch only)
}
```

For binary pendings (length === 2), the existing text path is unchanged — the user can react ✅/❌ on the question message OR reply with text.

### 5.4 Receive-side: gateway prefix branches

`baileys.handleIncoming` today early-returns on `messageStubType === REACTION` (presence, sub-A). We extend that branch to dispatch one-tap when the flag is on:

```typescript
if (msg.message?.pollUpdateMessage) {
  if (config.FEATURE_ONE_TAP) {
    await dispatchPollVote(msg).catch((err) =>
      logger.warn({ err: (err as Error).message }, 'one_tap.poll_dispatch_failed'),
    );
  }
  return; // never persist
}

if (isReactionStub(msg)) {
  if (config.FEATURE_ONE_TAP) {
    await dispatchReactionAsAnswer(msg).catch((err) =>
      logger.warn({ err: (err as Error).message }, 'one_tap.reaction_dispatch_failed'),
    );
  }
  return; // existing behaviour: never persist
}
```

`dispatchPollVote` and `dispatchReactionAsAnswer` live in `src/agent/one-tap.ts` (new). They:

1. Look up the **outbound** `mensagens` row by `metadata.whatsapp_id` matching the parent of the reaction or poll vote.
2. Read `metadata.pending_question_id`. If absent, drop with audit `one_tap_no_pending_anchor`.
3. Build `option_chosen` (deterministic):
   - **Reaction**: ✅ / 👍 → `opcoes_validas[0].key` (affirmative-first per B0 guard); ❌ / 👎 → `opcoes_validas[1].key`. Other emoji → audit `reaction_ignored_unmapped_emoji` and return.
   - **Poll vote**: aggregate via `socket.getAggregateVotesInPollMessage(parent, ourPubKey)`, take `chosen_keys[0]`. Match against `metadata.poll_options[i].key`.
4. Call `resolveAndDispatch({ ..., expected_pending_id, option_chosen, confidence: 1.0, source })`.

### 5.5 Pessoa lookup at gateway layer

The gateway dispatch handlers need `pessoa_id` and `conversa_id` to call `resolveAndDispatch`. Both are recoverable from the **outbound** `mensagens` row found in step 1 — `mensagens.conversa_id` is set, and the conversa knows its pessoa. No new lookups required, but we add `mensagensRepo.findByWhatsappId` (already exists on B0) and `conversasRepo.byId` (need to verify; if absent, add a one-line method).

### 5.6 Audit additions

```typescript
'pending_resolved_by_reaction',
'pending_resolved_by_poll',
'reaction_ignored_unmapped_emoji',
'one_tap_no_pending_anchor',           // outbound parent has no pending_question_id
'one_tap_dispatch_error',              // catch-all for unexpected handler failures
```

Existing `pending_resolved_by_gate` (B0) and `pending_action_dispatched` (B0) continue to fire — `resolveAndDispatch` always emits both, plus the source-specific `_by_*` audit.

## 6. Concurrency

- `resolveAndDispatch` wraps the resolve in `withTx`, identical to B0's gate. Two parallel resolutions on the same pending serialise; the loser gets `findActiveForUpdate` returning a different id (or null) → audit `pending_race_lost` (already exists from B0) → no dispatch.
- A reaction edit (user changes vote 5min later): `resolveAndDispatch` short-circuits on already-resolved. The later flip is dropped + audited as race-lost. Trade-off documented; reopening would risk duplicate side-effects.
- Late poll vote arriving after pending TTL: same as above.

## 7. Error handling

- All three primitives (poll send, poll dispatch, reaction dispatch) are wrapped `Promise.catch(() => null)` with `logger.warn` at the gateway. Failures never block the inbound stream.
- `sendPoll` failure: caller falls back to the existing text path. **No user-visible failure.**
- `getAggregateVotesInPollMessage` failure: drop with audit, retry on next poll-update event (Baileys re-emits state).

## 8. Configuration

`FEATURE_ONE_TAP` (default `false`).

When `false`:
- `sendPoll` is a no-op (returns `null`); `sendOutbound` stays text-only.
- `dispatchPollVote` / `dispatchReactionAsAnswer` early-return without DB or LLM cost.

Validation criteria for default-on flip:
- 30+ pendings created in trial; ≥ 50% resolved by tap (vs. text).
- Zero `one_tap_dispatch_error` audits during the trial week.
- Owner reports tap as "preferred over typing".

## 9. Schema / migrations

None. `metadata.pending_question_id` was added by B0; `metadata.poll_options` is just another JSONB key.

## 10. Refactor: extract `resolveAndDispatch` from B0's gate

B0's `pending-gate.ts` currently inlines the resolve+dispatch in its private `applyTx`. v2 moves that logic into `src/agent/pending-resolver.ts` with the signature in §5.1. The gate becomes:

```typescript
// inside checkPendingFirst, after Haiku classify:
const result = await resolveAndDispatch({
  pessoa_id, conversa_id, mensagem_id,
  expected_pending_id: snapshot.id,
  option_chosen: resolution.option_chosen!,
  confidence: resolution.confidence,
  source: 'gate',
});
```

This refactor is part of B1 — without it, B1's handlers would duplicate B0's transactional logic. B0 was deliberately scoped to ship lifecycle without this shared module; v2 lifts the duplication risk before introducing the second caller.

## 11. Out of scope

| Item | Defer to |
|---|---|
| Multi-select polls | post-B |
| Polls with > 12 options | post-B (pagination UX) |
| Reactions to non-pending outbound | sub-A (already done — silent ack) |
| Polls initiated by the user | post-B |
| `messages.update` (edit/delete inbound) | B2 |
| Quoting outbound messages | B2 |
| View-once for sensitive replies | B3a |
| PDF / chart export | B3b |
| Voice-note polish | B4 |

## 12. Acceptance criteria

- [ ] **Refactor**: `resolveAndDispatch` exists in `src/agent/pending-resolver.ts`; B0's gate calls it; existing B0 tests still green.
- [ ] **Send (poll)**: `FEATURE_ONE_TAP=true` + a pending with 3–12 opcoes → outbound is a WhatsApp poll; `mensagens.metadata.poll_options` is populated.
- [ ] **Send (binary)**: `FEATURE_ONE_TAP=true` + a binary pending → outbound is plain text (poll path skipped); user can resolve by reaction.
- [ ] **Receive (reaction)**: a ✅ reaction on the outbound parent of a binary pending resolves it; action dispatches; audit `pending_resolved_by_reaction` fires.
- [ ] **Receive (poll vote)**: a vote on a poll outbound resolves the pending; action dispatches; audit `pending_resolved_by_poll` fires.
- [ ] **Unmapped emoji**: 🎉 reaction → no resolution; audit `reaction_ignored_unmapped_emoji`.
- [ ] **No anchor**: reaction on an outbound without `pending_question_id` → no resolution; audit `one_tap_no_pending_anchor`.
- [ ] **Race**: reaction + text answer racing → action dispatches exactly once; loser audited as `pending_race_lost`.
- [ ] **Stale message**: reaction on an old outbound (its pending was resolved long ago) → audit `one_tap_no_pending_anchor` because the active pending no longer matches the parent's `pending_question_id`.
- [ ] `FEATURE_ONE_TAP=false`: zero send-side polls; zero receive-side dispatch; baileys behaves identically to current code.
- [ ] No new `mensagens` rows for inbound poll updates or reactions.
- [ ] Unit tests cover: emoji mapping; poll-key resolution; expected-vs-active mismatch; multi-tap idempotency.

## 13. References

- B0 design: `docs/superpowers/specs/2026-04-29-whatsapp-b0-pending-gate-design.md`
- Sub-A design: `docs/superpowers/specs/2026-04-29-whatsapp-ux-polish-design.md`
- Spec 04 §6 — gateway pipeline
- Spec 06 — agent loop and reflection triggers
- Spec 09 — pending lifecycle, audit taxonomy
- `src/workflows/pending-questions.ts` — `IntentResolution` schema (still consumed by gate)
- `src/agent/pending-gate.ts` — to be partially refactored (extract `resolveAndDispatch`)
- Baileys docs: `pollUpdateMessage`, `getAggregateVotesInPollMessage`, `sendMessage({ poll })`
