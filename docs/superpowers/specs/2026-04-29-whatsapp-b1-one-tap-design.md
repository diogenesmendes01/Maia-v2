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

B0's `applyTx` inside `pending-gate.ts` is private. It currently **resolves** the pending in a tx and returns a `kind: 'resolved'` shape — the **dispatch** of `acao_proposta` happens in `core.ts:128-145` for the gate path. v2 extracts the resolve+dispatch into one place so reactions/polls reuse both halves without duplicating the orchestration:

```typescript
// src/agent/pending-resolver.ts (new)
export type ResolveSource = 'gate' | 'reaction' | 'poll_vote';

export async function resolveAndDispatch(input: {
  pessoa: Pessoa;                  // full row (passed to dispatcher ctx)
  conversa: Conversa;              // full row
  mensagem_id: string;             // the inbound that triggered the resolution
  expected_pending_id: string;     // from the inbound's source (gate snapshot, reaction parent, poll parent)
  option_chosen: string;
  confidence: number;              // 1.0 for one-tap; <1 for gate's Haiku
  source: ResolveSource;
}): Promise<{ resolved: boolean; action_tool?: string; race_lost?: boolean }>;
```

Body (one function, three branches):
1. `withTx` → `findActiveForUpdate` → if not the expected id, audit `pending_race_lost` and return `{ resolved: false, race_lost: true }`.
2. Inside the same tx: `resolveTx(...)`, audit `pending_resolved_by_<source>`. The action's `acao_proposta` is read from the locked row and **carried out of the tx**.
3. After commit (no longer holding any lock): `dispatchTool({ tool: action.tool, args: { ...action.args, _pending_choice: option_chosen }, ctx })`. Audit `pending_action_dispatched`.

`core.ts` is updated: when the gate returns `kind: 'resolved'`, the gate itself has already called `resolveAndDispatch` — `core.ts` no longer dispatches. The gate's `GateResult` for the resolved case becomes `{ kind: 'resolved' }` (no action payload — already dispatched).

This is the only refactor of B0 that B1 forces. Existing B0 unit tests must be updated to mock `resolveAndDispatch` instead of asserting on `dispatchTool` from core.ts (see §10).

### 5.2 Send-side: poll for 3–12 options

`presence.sendPoll` (new):

```typescript
export async function sendPoll(
  remote_jid: string,
  question: string,
  options: ReadonlyArray<{ key: string; label: string }>,
  // No `quoted` param yet — outbound-quoting of polls is a B2 concern;
  // including it here would require a Baileys helper that doesn't ergonomically
  // support both poll messages and quoted contexts in one call.
): Promise<{
  whatsapp_id: string | null;
  message_secret: string | null;     // base64; needed to decrypt votes
  option_label_to_key: Record<string, string>; // reverse map for receive-side
}>;
```

Uses `socket.sendMessage(jid, { poll: { name: question, values: labels, selectableCount: 1 } })`. Baileys returns the `proto.WebMessageInfo` whose `message.messageContextInfo.messageSecret` is the per-poll secret used to derive the vote-decryption key. **We must persist this secret** on the outbound `mensagens` row, otherwise `decryptPollVote` cannot recover the user's choice on the receive side.

Persisted metadata on the outbound row:

```typescript
metadata: {
  whatsapp_id, in_reply_to,
  pending_question_id,
  poll_options: [{ key, label }],            // ordered same as Baileys `values`
  poll_message_secret: '<base64>',           // NEW — required for decryption
}
```

When `FEATURE_ONE_TAP=false` OR Baileys is disconnected, `sendPoll` returns all-null — caller falls back to the existing text-list path.

### 5.3 Send-side: agent loop decision

`sendOutbound` stays text-only. We add **`sendOutboundPoll`** as a sibling helper in `core.ts` for the poll branch — the metadata shape and return contract are different enough (`poll_options`, `poll_message_secret`) that one function doing both gets confused.

The agent loop currently captures `latestPendingId: string | null` from the `ask_pending_question` tool result (`core.ts:226-243`). We **enrich** what's captured: instead of just the id, we pull the `opcoes_count` and `opcoes_validas` directly from the tool's result by extending the tool to return them (the row was already created — adding two fields to the JSON response is free; no extra DB round-trip).

```typescript
// ask_pending_question output schema becomes:
z.object({
  pending_question_id: z.string(),
  opcoes_count: z.number().int().min(2).max(12),
  opcoes_validas: z.array(z.object({ key: z.string(), label: z.string() })),
})
```

In the agent loop:

```typescript
let latestPending: { id: string; opcoes_validas: ... } | null = null;
// ... after ask_pending_question dispatches and re-validates ...

// at the text-send site:
if (
  latestPending &&
  config.FEATURE_ONE_TAP &&
  latestPending.opcoes_validas.length >= 3 &&
  latestPending.opcoes_validas.length <= 12
) {
  await sendOutboundPoll(pessoa.id, c.id, text, inbound.id, {
    pending_question_id: latestPending.id,
    options: latestPending.opcoes_validas,
  });
} else {
  await sendOutbound(pessoa.id, c.id, text, inbound.id, {
    pending_question_id: latestPending?.id ?? null,
    quoted: shouldQuote ? quotedReplyContext(...) : undefined,
  });
}
```

Binary pendings (length === 2) take the text path — reactions work on plain text outbound messages.

When `sendOutboundPoll` fails (Baileys disconnect, send error), it falls back internally to `sendOutbound`-with-text rendering of the question + numbered list. The user can still resolve by typing.

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
   - **Poll vote**: WhatsApp poll updates carry SHA-256 hashes of the chosen option labels (not labels themselves, not indices). Decryption flow:
     1. Read `metadata.poll_message_secret` from the outbound row.
     2. Use Baileys' `decryptPollVote(msg.message.pollUpdateMessage, { messageSecret, ... })` to recover the chosen label hash.
     3. For each label in `metadata.poll_options`, compute the same hash and compare. The matching label gives the `key`.
     4. If decryption fails or no label matches → audit `one_tap_dispatch_error` with reason and return.
4. Call `resolveAndDispatch({ ..., expected_pending_id, option_chosen, confidence: 1.0, source })`.

### 5.5 Pessoa / conversa lookup at gateway layer

The gateway dispatch handlers need `pessoa` and `conversa` rows to pass into `resolveAndDispatch`. Both are recoverable from the outbound `mensagens` row found in step 1: `mensagens.conversa_id` → `conversa` row → `conversa.pessoa_id` → `pessoa` row.

**Repository additions** (acceptance criterion):
- `mensagensRepo.findByWhatsappId(whatsapp_id)` — **already exists** at `src/db/repositories.ts:215` (indexed via `uniq_mensagens_whatsapp_id`).
- `conversasRepo.byId(id)` — **does not exist**. Add a one-liner that returns `Conversa | null`.
- `pessoasRepo.findById(id)` — already exists.

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
- Decryption / hash-match failure (`decryptPollVote` throws, or no `poll_options[i].label` hash matches the revealed vote): drop with audit `one_tap_dispatch_error`. Baileys typically re-emits the poll-update on reconnect, giving us a second chance.

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
// inside checkPendingFirst, after Haiku classify (full pessoa + conversa
// rows are already in scope at this point — the gate is called from
// runAgentForMensagem which loaded both):
const result = await resolveAndDispatch({
  pessoa,
  conversa,
  mensagem_id: input.inbound.id,
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

- [ ] **Refactor**: `resolveAndDispatch` exists in `src/agent/pending-resolver.ts`; B0's gate calls it; the gate's `GateResult.resolved` no longer carries an action (already dispatched); core.ts no longer dispatches for the gate path.
- [ ] **B0 tests updated**: `tests/unit/pending-gate.spec.ts` now mocks `resolveAndDispatch` instead of asserting on `dispatchTool` from core.ts.
- [ ] `conversasRepo.byId` added.
- [ ] **Send (poll)**: `FEATURE_ONE_TAP=true` + a pending with 3–12 opcoes → outbound is a WhatsApp poll; `mensagens.metadata.poll_options` is populated.
- [ ] **Send (binary)**: `FEATURE_ONE_TAP=true` + a binary pending → outbound is plain text (poll path skipped); user can resolve by reaction.
- [ ] **Receive (reaction)**: a ✅ reaction on the outbound parent of a binary pending resolves it; action dispatches; audit `pending_resolved_by_reaction` fires.
- [ ] **Receive (poll vote)**: a vote on a poll outbound resolves the pending; action dispatches; audit `pending_resolved_by_poll` fires.
- [ ] **Unmapped emoji**: 🎉 reaction → no resolution; audit `reaction_ignored_unmapped_emoji`.
- [ ] **No anchor**: reaction on an outbound without `pending_question_id` → no resolution; audit `one_tap_no_pending_anchor`.
- [ ] **Race**: reaction + text answer racing → action dispatches exactly once; loser audited as `pending_race_lost`.
- [ ] **Stale message**: reaction on an old outbound whose pending was resolved long ago → `resolveAndDispatch` sees `expected_pending_id` not equal to `findActiveForUpdate`'s id and audits `pending_race_lost` (no resolution, no dispatch). The distinct `one_tap_no_pending_anchor` audit fires only when the parent outbound row has no `pending_question_id` at all (a non-pending message somebody reacted to).
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
