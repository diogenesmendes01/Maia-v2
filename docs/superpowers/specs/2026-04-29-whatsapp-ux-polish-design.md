# WhatsApp UX Polish — Design

**Date:** 2026-04-29
**Status:** Approved (in brainstorm), pending spec review and user review.
**Scope:** Sub-project A of three (A: UX polish; B: capabilities; C: anti-ban / robustness).
**Depends on:** spec 04 (gateway), spec 06 (agent loop), the existing `src/gateway/baileys.ts`.

---

## 1. Purpose

Maia today only uses two WhatsApp signals: send text and receive text. Users see no acknowledgement until the full reply lands — which can be 5–15 s when the LLM is slow. This sub-project adds **selective** WhatsApp-native polish so the bot feels live and lightweight without changing what it does.

Selective (not universal): only fire signals where they add information the user does not already get from the text reply. Universal polish increases ban risk on Baileys (unofficial library) and adds noise to the conversation.

## 2. Goals

- Reduce perceived latency by signalling activity in the WhatsApp UI.
- Make side-effect outcomes (transaction registered, request blocked) visible at a glance through reactions, without extra lines of text.
- Preserve context across multi-turn corrections via threaded replies.
- Stay no-op-safe: a Baileys hiccup must never block the main flow.

## 3. Non-goals

- Polls, list messages, buttons (deferred to sub-project B — capabilities).
- Outbound throttling and ban-risk hardening (sub-project C).
- Voice notes / transcription pipeline polish (sub-project B).
- Multi-device pairing UX, view-once for sensitive replies (sub-project B/C).

## 4. Architecture

A new module `src/gateway/presence.ts` centralises the four signals behind small, idempotent functions. The agent loop and the gateway call into it; nothing else changes shape.

```
src/gateway/baileys.ts        — adds markRead() in handleIncoming
                                exports primitives used by presence.ts
src/gateway/presence.ts (new) — markRead, startTyping, sendReaction,
                                quotedReplyContext
src/agent/core.ts             — wires startTyping at turn start,
                                sendReaction after dispatchTool, quoted
                                reply when appropriate
```

### 4.1 Public API

```typescript
// All functions are fire-and-forget unless noted. Failures log warn and return.
export function markRead(remote_jid: string, key: WAMessageKey): void;

export function startTyping(remote_jid: string, request_id: string): TypingHandle;
export interface TypingHandle { stop(): void; }

export function sendReaction(remote_jid: string, key: WAMessageKey, emoji: '✅' | '❌'): void;

// Pure: builds a quoted-reply context object for sendMessage().
export function quotedReplyContext(inbound_metadata: Record<string, unknown>): WAQuotedContext | undefined;
```

Internally, `presence.ts` checks `isBaileysConnected()` before each call. Disconnected → no-op. The Baileys socket reference is read from `baileys.ts` via a small accessor (no global passing of the socket object).

### 4.2 Data flow per turn

```
inbound msg arrives
  └─ baileys.handleIncoming
       ├─ dedup / bot-detect / persist (existing)
       ├─ markRead(remote_jid, msg.key)            [NEW]
       └─ enqueueAgent

agent worker picks up
  └─ core.runAgentForMensagem
       ├─ resolveIdentity (existing)
       ├─ rate-limit (existing)
       ├─ const typing = startTyping(jid, request_id) after 1.5s
       ├─ ReAct loop:
       │    └─ for each tool_use:
       │         ├─ dispatchTool
       │         └─ sendReaction(jid, inbound.key, ok ? '✅' : '❌')   [NEW: side-effect tools only]
       ├─ sendOutbound — uses quotedReplyContext if correction or pending_question
       └─ try/finally: typing.stop()
```

## 5. Detailed behaviour

### 5.1 Read receipt

Fires once per inbound, immediately after `handleIncoming` validates (not group, not duplicate, not bot-blocked). Cost is one Baileys call. Skip when bot-blocked or when the pessoa is in `bloqueada` status (no acknowledgement to abusive numbers).

### 5.2 Typing indicator

`socket.sendPresenceUpdate('composing', remote_jid)` expires server-side ~10 s. We refresh every 8 s with a `setInterval` stored on the handle. `stop()` clears the interval and emits `'paused'`.

Debounce: only fire if the agent loop has been active 1.5 s. This avoids the "type then untype immediately" flicker on quick replies, and reduces the average outbound rate to look more human.

Concurrency: `startTyping` keyed by `request_id`. If called twice for the same id, returns the existing handle. The handle's `stop()` is idempotent.

### 5.3 Reactions on tool dispatch

After each `dispatchTool`, if `tool.side_effect ∈ {'write', 'communication'}`:

- success result (no `error` key) → `sendReaction(jid, inbound.key, '✅')`
- `error: 'forbidden'` or `error: 'requires_dual_approval'` → `sendReaction(jid, inbound.key, '❌')`
- any other error → no reaction (the user gets a textual explanation; double-signalling adds noise)

Read tools (`side_effect === 'read'`) never react — the data itself is the reply.

Reactions decorate the inbound message (no new mensagens row). They are stored in WhatsApp's reaction stream, not in `mensagens`. We do not persist outbound reactions in the DB — they are pure UX.

### 5.4 Quoted reply

Used in two narrow cases:

1. **Correction follow-up**: when `detectCorrection(inbound.conteudo)` is true, the assistant's reply is quoted-against the inbound, so the corrected lançamento is anchored.
2. **Pending question resolution**: when `getActivePending(conversa)` returns non-null, the reply quotes the question (clarifies which pending the user resolved).

Default reply path is unchanged (top-level reply).

To produce a quoted-reply context, we need the original `proto.IWebMessageInfo`. It's not persisted in full, but `mensagens.metadata.whatsapp_id` and `metadata.remote_jid` are. `quotedReplyContext` reconstructs the minimal `quoted` shape that Baileys accepts (`{ key: { remoteJid, id, fromMe: false }, message: { conversation: <truncated content> } }`). We truncate `conversation` to 200 chars.

## 6. Error handling

Every public function in `presence.ts` is wrapped:

```typescript
.catch((err) => logger.warn({ err: (err as Error).message }, 'presence.<op>_failed'))
```

The agent loop wraps `startTyping` in a `try/finally`:

```typescript
const typing = startTyping(jid, request_id);
try {
  // ... ReAct loop ...
} finally {
  typing.stop();
}
```

If Baileys is mid-reconnect, all four functions return immediately. The user still gets the textual reply when Baileys recovers (queued via the existing outbound path).

## 7. Testing

### Unit (`tests/unit/presence.spec.ts`)

- `startTyping` returns a handle whose `stop()` is idempotent.
- Calling `startTyping` twice with the same `request_id` returns the same handle (refcount or Map).
- `markRead`, `sendReaction` are no-ops when `isBaileysConnected()` is false.
- `quotedReplyContext` truncates conversation to 200 chars and uses the inbound `whatsapp_id` and `remote_jid` from metadata.
- `quotedReplyContext` returns `undefined` when metadata lacks `whatsapp_id`.

Mocks: `isBaileysConnected`, `socket.sendPresenceUpdate`, `socket.sendMessage` injected via the small accessor on `baileys.ts`.

### Integration (deferred)

Real Baileys socket exercise lives in a manual checklist on the PR (eyeball the WhatsApp UI). No automated browser/device fixture in scope.

## 8. Configuration

New env: **`FEATURE_PRESENCE`** (default `false`).

When false, `presence.ts` exports no-op stubs. When true, the real implementations run. This lets us land the code, test it on a single number for a week, then default to `true` after validation.

Validation criteria for default-on flip:
- 100+ turns observed across at least two pessoas.
- No Baileys reconnect storm (>3/h) attributable to presence calls.
- Owner reports the bot "feels live" qualitatively.

## 9. Migration / Rollout

1. Land code with `FEATURE_PRESENCE=false`. CI tests pass. Production unchanged.
2. Owner sets `FEATURE_PRESENCE=true` in `.env`. Runs the bot for ~7 days.
3. After validation, change the schema default to `true` in `src/config/env.ts`.
4. Remove the env after a release if no rollback is requested.

## 10. Out of scope (future sub-projects)

| Item | Sub-project |
|---|---|
| Polls for category disambiguation | B |
| Receive-side reactions (user reacts to confirm) | B |
| Send PDF / chart / receipt | B |
| Voice-note transcription polish | B |
| Outbound throttle, "human" send patterns | C |
| Block/unblock primitives wired to lockdown | C |
| `messages.update` (edit/delete) detection | B |
| View-once for sensitive replies (saldos) | B/C |

## 11. Acceptance criteria

- [ ] `FEATURE_PRESENCE=true` causes the WhatsApp UI to display:
  - Inbound messages flip to read once Maia ACKs them.
  - "Maia is typing…" appears 1.5 s after a slow turn starts and disappears when the reply lands.
  - A ✅ reaction lands on the inbound message after a successful `register_transaction` / `correct_transaction` / `start_workflow` / `send_proactive_message`.
  - A ❌ reaction lands on the inbound after a `forbidden` or `requires_dual_approval`.
  - Replies to a correction message are threaded under that message.
- [ ] `FEATURE_PRESENCE=false` produces zero Baileys-side polish calls (verified by mock spy in tests).
- [ ] A Baileys-side failure (mocked) in any of the four primitives does not affect the textual reply or audit trail.
- [ ] Unit suite covers idempotency (handle reuse) and disconnected-no-op for all four primitives.

## 12. References

- spec 04 §6 — gateway pipeline
- spec 06 — agent loop and reflection triggers
- spec 17 — observability and degraded-mode policy
- Baileys docs (`@whiskeysockets/baileys`): `sendPresenceUpdate`, `readMessages`, message reactions, quoted replies
- Conversation design references (Landbot, Verloop) — efficiency over naturalness; reactions as silent ack
