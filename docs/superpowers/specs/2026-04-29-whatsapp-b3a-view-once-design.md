# WhatsApp B3a — View-Once for Sensitive Replies — Design

**Date:** 2026-04-29
**Status:** Approved (in brainstorm), pending spec review and user review.
**Scope:** Sub-project B3a. B3b (PDF/chart export) is a separate, larger spec.
**Depends on:** sub-A (presence — `sendOutboundText` opts), B0 (tool registry shape used by `Tool.sensitive` field).

---

## 1. Purpose

When the agent's text response carries financial values (saldos, comparativos), wrap the WhatsApp send in `viewOnceMessageV2` so the reply disappears from the recipient's chat history after a single view. Reduces leak surface when the user passes the phone around or hands it to a third party who scrolls back.

This is **best-effort privacy enhancement**, not a security control:
- Android WhatsApp honours view-once for text (message disappears after viewing).
- iOS support is partial (some builds preserve).
- WhatsApp Web does not honour — text remains visible.
- Server-side, the message is delivered as a normal protobuf with the `viewOnce` flag; nothing prevents an actively malicious client from logging it.

We document this clearly so the user understands the constraint.

## 2. Goals

- A single declarative knob (`Tool.sensitive: true`) that flips the next outbound for that turn into view-once.
- Owner-level preference (`pessoa.preferencias.balance_view_once`) overrides per-pessoa.
- Feature-flagged: `FEATURE_VIEW_ONCE_SENSITIVE=false` by default.
- Audit every view-once outbound so usage is visible.
- No regression: with the flag off, every outbound is a normal text send.

## 3. Non-goals

- Forcing view-once on `list_transactions` or other verbose tools — UX is poor (user can't scroll back to read).
- Forcing view-once on PDFs / images — out of scope here (B3b owns PDF export and decides separately whether to use view-once for media).
- Detecting whether the WhatsApp client honoured view-once. WhatsApp does not surface this signal; we'd be guessing.
- Owner command "Maia, deixa saldo no histórico" to flip the preference at runtime — out of scope. Preference is read; mutating it via WhatsApp is a follow-up if owners ask.
- Multi-recipient view-once policies. WhatsApp delivers to one JID per `sendMessage` call; each conversation is independent.

## 4. Architecture

### 4.1 New `Tool.sensitive` field

In `src/tools/_registry.ts`, the `Tool` type gains an optional boolean:

```typescript
export type Tool<I extends z.ZodTypeAny, O extends z.ZodTypeAny> = {
  // ...existing fields...
  sensitive?: boolean;
};
```

Tools that produce sensitive output set `sensitive: true`. Initial set:
- `query_balance` → sensitive: true
- `compare_entities` → sensitive: true

`list_transactions`, `list_pending`, etc. stay `false` (default).

### 4.2 Agent loop tracks `turnHasSensitive`

Inside `runAgentForMensagem`'s ReAct loop, after each `dispatchTool`, the agent inspects the tool registry and sets a turn-local flag:

```typescript
let turnHasSensitive = false;
// inside the for-tu loop, after dispatchTool returns:
const tool = REGISTRY[tu.tool];
if (tool?.sensitive) turnHasSensitive = true;
```

The flag is **OR-logic**: any sensitive tool in the turn flips the outbound to view-once. A turn that runs both `query_balance` (sensitive) and `list_transactions` (non-sensitive) still sends view-once — the principle is "if the user asked anything sensitive, the visible reply belongs in view-once."

### 4.3 Pessoa preference

`pessoas.preferencias` is already `jsonb` (B0 era and earlier). New optional key: `balance_view_once: boolean`. Default behaviour when the key is absent: **view-once enabled** (i.e. `true`). When the owner sets `false`, view-once is disabled for that pessoa even when `turnHasSensitive` is true.

The preference is read at send time. No new repo method needed — the agent loop already has the `pessoa` row in scope.

### 4.4 `sendOutbound` extension

`src/agent/core.ts` `sendOutbound` gains a fourth opt:

```typescript
opts?: {
  pending_question_id?: string | null;
  quoted?: import('@/gateway/presence.js').WAQuotedContext;
  view_once?: boolean;   // NEW
};
```

Passed through to `sendOutboundText` in `src/gateway/baileys.ts`, which already accepts a single `opts` object today (sub-A added `quoted`):

```typescript
export async function sendOutboundText(
  jid: string,
  text: string,
  opts?: { quoted?: WAQuotedContext; view_once?: boolean },
): Promise<string | null>;
```

In `sendOutboundText`, when `opts?.view_once && config.FEATURE_VIEW_ONCE_SENSITIVE`, the Baileys call uses the `viewOnce` flag:

```typescript
if (opts?.view_once && config.FEATURE_VIEW_ONCE_SENSITIVE) {
  const result = await socket.sendMessage(
    jid,
    { text, viewOnce: true },
    opts.quoted ? { quoted: opts.quoted } : undefined,
  );
  return result?.key.id ?? null;
}
```

Otherwise the existing branches run unchanged.

### 4.5 Decision at the call site

In `core.ts`, the no-tool-uses branch of the ReAct loop (where the final text reply is sent) computes the `view_once` flag:

```typescript
const view_once =
  turnHasSensitive &&
  (pessoa.preferencias as { balance_view_once?: boolean } | null)?.balance_view_once !== false;

await sendOutbound(pessoa.id, c.id, text, inbound.id, {
  pending_question_id: latestPending?.id ?? null,
  quoted: shouldQuote ? quotedReplyContext(...) : undefined,
  view_once,
});
```

For the poll branch (`sendOutboundPoll`), view-once does **not** apply — polls and view-once are incompatible at the WhatsApp protocol level. If a turn has both `turnHasSensitive` AND `latestPending` requiring a poll, the poll wins (sensitive data in poll-question text is acceptable: poll questions are short and the values aren't necessarily inside them).

### 4.6 Audit

Every view-once send emits `outbound_sent_view_once` audit:

```typescript
{
  acao: 'outbound_sent_view_once',
  pessoa_id: pessoa.id,
  conversa_id: c.id,
  mensagem_id: inbound.id,
  metadata: {
    sensitive_tools: <list of tool names that flipped the flag>,
    whatsapp_id: <wid of the outbound>,
  },
}
```

Audit fires only on actual view-once sends (not when the flag was on but the preference disabled). When the preference disables view-once on a sensitive turn, emit `outbound_view_once_skipped_by_preference` so the owner-side opt-out is observable.

## 5. Schema / migrations

None. `pessoa.preferencias` is already JSONB; new key added without DDL.

## 6. Configuration

`FEATURE_VIEW_ONCE_SENSITIVE` (default `false`).

When false:
- The view-once branch in `sendOutboundText` is never taken.
- `Tool.sensitive` flags are still readable but have no runtime effect (so existing tests don't need to mock the env).

When true:
- View-once flow active, gated by `pessoa.preferencias.balance_view_once`.

Validation criteria for default-on flip:
- 30+ sensitive turns observed in the trial week.
- Zero `outbound_view_once_skipped_by_preference` from owner who didn't intend to opt out.
- Owner reports the privacy gain "noticeable" (via a quick check-in).

## 7. Audit-action additions

In `src/governance/audit-actions.ts`:

```typescript
'outbound_sent_view_once',
'outbound_view_once_skipped_by_preference',
```

## 8. Concurrency

`turnHasSensitive` is a turn-local variable; no cross-turn or cross-process concurrency. The pessoa preference is read once per turn at send time — a stale read of an in-flight preference change is acceptable (next turn picks up the new value).

## 9. Error handling

- `sendOutboundText` failure on the view-once path: same behaviour as the regular text path (warn log + null return; existing DLQ handling via the queue catches retry-exhaustion).
- WhatsApp client doesn't honour view-once: invisible to the backend. We log the audit and move on.
- Pessoa preference is malformed (e.g., `balance_view_once: "yes"` instead of a boolean): treat any non-`false` value as default-on (i.e., view-once enabled). The `!== false` guard in §4.5 captures this.

## 10. Testing

### Unit (`tests/unit/view-once.spec.ts` — new)

- `Tool.sensitive: true` on `query_balance` → `turnHasSensitive` flag set during the turn.
- Mixed turn (sensitive + non-sensitive) → still flagged.
- `FEATURE_VIEW_ONCE_SENSITIVE=true` + sensitive turn + preference unset → `sendOutboundText` called with `view_once: true`; audit `outbound_sent_view_once` fired.
- `FEATURE_VIEW_ONCE_SENSITIVE=true` + sensitive turn + `pessoa.preferencias.balance_view_once = false` → `sendOutboundText` called WITHOUT `view_once`; audit `outbound_view_once_skipped_by_preference` fired.
- `FEATURE_VIEW_ONCE_SENSITIVE=false` → no view-once ever; no extra audit.
- Non-sensitive turn (no `Tool.sensitive: true` dispatched) → no view-once; no audit.

### Integration

Manual checklist on the PR (real WhatsApp Android receiver) — verify that `query_balance` reply appears with the view-once UI.

## 11. Out of scope

| Item | Defer to |
|---|---|
| View-once for media (PDF, image) | B3b (PDF) decides per-export type |
| Owner command to toggle preference at runtime | post-B (small) |
| Multi-language hint text on the view-once message | post-B |
| Detecting whether the client honoured view-once | impossible on WhatsApp protocol; not in roadmap |
| Forcing view-once on long verbose replies (`list_transactions`) | UX is bad; not pursued |

## 12. Acceptance criteria

- [ ] `Tool.sensitive: true` on `query_balance` and `compare_entities`; default `false` everywhere else.
- [ ] `turnHasSensitive` is set when ANY tool with `sensitive: true` is dispatched during the turn.
- [ ] `FEATURE_VIEW_ONCE_SENSITIVE=true` + sensitive turn + preference absent → `sendOutboundText` is called with `{ view_once: true }`; audit `outbound_sent_view_once` fires with the list of sensitive tool names in metadata.
- [ ] `pessoa.preferencias.balance_view_once = false` overrides — `view_once: true` is NOT passed; audit `outbound_view_once_skipped_by_preference` fires.
- [ ] Non-sensitive turn → `sendOutboundText` is called WITHOUT `view_once`; no view-once audit.
- [ ] `FEATURE_VIEW_ONCE_SENSITIVE=false` → `sendOutboundText`'s view-once branch is never taken (verified by counting Baileys mock calls in tests).
- [ ] Poll outbound (`sendOutboundPoll`) is unaffected — view-once does not apply to polls; the spec documents this trade-off.
- [ ] `quoted` opt is preserved — view-once + quoted reply works (quote is the third arg to Baileys `sendMessage` regardless of view-once).
- [ ] Unit tests cover all six branches of §10.

## 13. References

- Sub-A design — `docs/superpowers/specs/2026-04-29-whatsapp-ux-polish-design.md` (`sendOutboundText` opts pattern)
- B0 design — `docs/superpowers/specs/2026-04-29-whatsapp-b0-pending-gate-design.md` (`Tool` type at `_registry.ts`)
- Spec 09 — audit taxonomy
- Baileys docs: `viewOnce` flag on `sendMessage`, `viewOnceMessageV2` envelope
