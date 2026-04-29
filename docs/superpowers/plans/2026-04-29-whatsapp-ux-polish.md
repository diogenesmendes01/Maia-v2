# WhatsApp UX Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four selective WhatsApp-native polish signals (read receipt, typing indicator, reactions on side-effect tools, quoted replies on corrections) gated behind `FEATURE_PRESENCE`. The bot should feel live and lightweight without changing what it does.

**Architecture:** A single new module `src/gateway/presence.ts` exposes idempotent fire-and-forget primitives. The agent loop and gateway call into it. Failures never block the textual reply. Implementation follows the spec at [docs/superpowers/specs/2026-04-29-whatsapp-ux-polish-design.md](../specs/2026-04-29-whatsapp-ux-polish-design.md).

**Tech Stack:** TypeScript, `@whiskeysockets/baileys`, vitest, ioredis (already in deps).

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `src/config/env.ts` | Modify | Add `FEATURE_PRESENCE` boolean env (default `false`) |
| `src/gateway/baileys.ts` | Modify | (a) `REACTION` early-return in `handleIncoming`; (b) extend `sendOutboundText` with `{ quoted? }` opts; (c) export `getSocket()` accessor for `presence.ts` |
| `src/gateway/presence.ts` | Create | The four primitives + handle map + sweep |
| `src/agent/core.ts` | Modify | (a) try/finally with `startTyping`; (b) `sendReaction` after each side-effect `dispatchTool`; (c) `quotedReplyContext` on `sendOutbound` for correction/pending |
| `tests/unit/presence.spec.ts` | Create | Unit tests for all four primitives |
| `tests/unit/baileys-handle-incoming.spec.ts` | Create | Test `REACTION` early-return |

No new env beyond `FEATURE_PRESENCE`. No DB schema changes. No new tables.

---

## Task 1: Add `FEATURE_PRESENCE` config flag

**Files:**
- Modify: `src/config/env.ts` (add to schema near other `FEATURE_*` flags)

- [ ] **Step 1: Add the env entry**

In `src/config/env.ts`, alongside the other `FEATURE_*` entries (search for `FEATURE_DASHBOARD`):

```typescript
FEATURE_PRESENCE: z
  .string()
  .default('false')
  .transform((s) => s === 'true' || s === '1'),
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean (the only existing errors are `dashboard_sessions` and `governance/lockdown.ts:26` — pre-existing, not caused by this change)

- [ ] **Step 3: Commit**

```bash
git add src/config/env.ts
git commit -m "feat(presence): FEATURE_PRESENCE env flag (default false)"
```

---

## Task 2: Skeleton `src/gateway/presence.ts` with no-op stubs

**Files:**
- Create: `src/gateway/presence.ts`

- [ ] **Step 1: Write the file with no-op stubs**

```typescript
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';

export interface TypingHandle {
  stop(): void;
}

const NOOP_HANDLE: TypingHandle = { stop: () => undefined };

export function markRead(_remote_jid: string, _whatsapp_id: string): void {
  if (!config.FEATURE_PRESENCE) return;
  // implemented in Task 4
}

export function startTyping(_remote_jid: string, _mensagem_id: string): TypingHandle {
  if (!config.FEATURE_PRESENCE) return NOOP_HANDLE;
  return NOOP_HANDLE; // implemented in Task 5
}

export function sendReaction(
  _remote_jid: string,
  _whatsapp_id: string,
  _emoji: '✅' | '❌',
): void {
  if (!config.FEATURE_PRESENCE) return;
  // implemented in Task 7
}

export type WAQuotedContext = {
  key: { remoteJid: string; id: string; fromMe: boolean };
  message: { conversation: string };
};

export function quotedReplyContext(
  _inbound_metadata: Record<string, unknown> | null,
  _inbound_conteudo: string | null,
): WAQuotedContext | undefined {
  return undefined; // implemented in Task 8
}

void logger; // suppress unused until used
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/gateway/presence.ts
git commit -m "feat(presence): module skeleton with no-op stubs"
```

---

## Task 3: Expose `getSocket()` accessor on `baileys.ts`

We need `presence.ts` to read the live `WASocket` reference without taking a circular dep on `baileys.ts` internals. The accessor pattern keeps presence isolated and lets us mock it in tests via `vi.mock`.

**Files:**
- Modify: `src/gateway/baileys.ts`

- [ ] **Step 1: Add the accessor**

After the existing `isBaileysConnected()` export, add:

```typescript
export function getSocket(): WASocket | null {
  return socket;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/gateway/baileys.ts
git commit -m "feat(presence): expose getSocket() accessor for presence module"
```

---

## Task 4: TDD — `markRead`

**Files:**
- Modify: `src/gateway/presence.ts`
- Create: `tests/unit/presence.spec.ts`

- [ ] **Step 1: Write the failing test**

In `tests/unit/presence.spec.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const readMessages = vi.fn();
const sendPresenceUpdate = vi.fn();
const sendMessage = vi.fn();

vi.mock('../../src/gateway/baileys.js', () => ({
  isBaileysConnected: () => true,
  getSocket: () => ({ readMessages, sendPresenceUpdate, sendMessage }),
}));

vi.mock('../../src/config/env.js', () => ({
  config: { FEATURE_PRESENCE: true },
}));

beforeEach(() => {
  readMessages.mockReset();
  sendPresenceUpdate.mockReset();
  sendMessage.mockReset();
});

describe('presence — markRead', () => {
  it('calls socket.readMessages with the constructed key', async () => {
    const { markRead } = await import('../../src/gateway/presence.js');
    markRead('5511999@s.whatsapp.net', 'WAID-123');
    // markRead is fire-and-forget; give the microtask queue a tick.
    await new Promise((r) => setImmediate(r));
    expect(readMessages).toHaveBeenCalledWith([
      { remoteJid: '5511999@s.whatsapp.net', id: 'WAID-123', fromMe: false },
    ]);
  });

  it('is a no-op when FEATURE_PRESENCE is false', async () => {
    vi.resetModules();
    vi.doMock('../../src/config/env.js', () => ({ config: { FEATURE_PRESENCE: false } }));
    vi.doMock('../../src/gateway/baileys.js', () => ({
      isBaileysConnected: () => true,
      getSocket: () => ({ readMessages, sendPresenceUpdate, sendMessage }),
    }));
    const { markRead } = await import('../../src/gateway/presence.js');
    markRead('jid', 'id');
    await new Promise((r) => setImmediate(r));
    expect(readMessages).not.toHaveBeenCalled();
  });

  it('is a no-op when Baileys is disconnected', async () => {
    vi.resetModules();
    vi.doMock('../../src/config/env.js', () => ({ config: { FEATURE_PRESENCE: true } }));
    vi.doMock('../../src/gateway/baileys.js', () => ({
      isBaileysConnected: () => false,
      getSocket: () => null,
    }));
    const { markRead } = await import('../../src/gateway/presence.js');
    markRead('jid', 'id');
    await new Promise((r) => setImmediate(r));
    expect(readMessages).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test — confirm it fails**

Run: `npx vitest run tests/unit/presence.spec.ts`
Expected: 3 fails (markRead is currently a stub).

- [ ] **Step 3: Implement `markRead`**

In `src/gateway/presence.ts`:

```typescript
import { isBaileysConnected, getSocket } from './baileys.js';

export function markRead(remote_jid: string, whatsapp_id: string): void {
  if (!config.FEATURE_PRESENCE) return;
  if (!isBaileysConnected()) return;
  const sock = getSocket();
  if (!sock) return;
  sock
    .readMessages([{ remoteJid: remote_jid, id: whatsapp_id, fromMe: false }])
    .catch((err: Error) => logger.warn({ err: err.message }, 'presence.mark_read_failed'));
}
```

- [ ] **Step 4: Run the test — confirm it passes**

Run: `npx vitest run tests/unit/presence.spec.ts`
Expected: 3 passes.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/presence.ts tests/unit/presence.spec.ts
git commit -m "feat(presence): markRead + tests"
```

---

## Task 5: TDD — `startTyping` with handle map (idempotency, refresh, stop)

**Files:**
- Modify: `src/gateway/presence.ts`
- Modify: `tests/unit/presence.spec.ts`

- [ ] **Step 1: Add tests**

Append to `tests/unit/presence.spec.ts`:

```typescript
describe('presence — startTyping', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('../../src/config/env.js', () => ({ config: { FEATURE_PRESENCE: true } }));
    vi.doMock('../../src/gateway/baileys.js', () => ({
      isBaileysConnected: () => true,
      getSocket: () => ({ readMessages, sendPresenceUpdate, sendMessage }),
    }));
  });

  it('emits "composing" once on start and "paused" on stop', async () => {
    const { startTyping } = await import('../../src/gateway/presence.js');
    const handle = startTyping('jid-1', 'inbound-1');
    await new Promise((r) => setImmediate(r));
    expect(sendPresenceUpdate).toHaveBeenCalledWith('composing', 'jid-1');
    handle.stop();
    await new Promise((r) => setImmediate(r));
    expect(sendPresenceUpdate).toHaveBeenCalledWith('paused', 'jid-1');
  });

  it('returns the same handle for the same mensagem_id', async () => {
    const { startTyping } = await import('../../src/gateway/presence.js');
    const a = startTyping('jid', 'inbound-X');
    const b = startTyping('jid', 'inbound-X');
    expect(a).toBe(b);
    a.stop();
  });

  it('handle.stop() is idempotent', async () => {
    const { startTyping } = await import('../../src/gateway/presence.js');
    const handle = startTyping('jid', 'inbound-Y');
    handle.stop();
    handle.stop(); // must not throw, must not double-emit
    await new Promise((r) => setImmediate(r));
    const pausedCalls = sendPresenceUpdate.mock.calls.filter((c) => c[0] === 'paused');
    expect(pausedCalls).toHaveLength(1);
  });

  it('returns no-op handle when FEATURE_PRESENCE is false', async () => {
    vi.resetModules();
    vi.doMock('../../src/config/env.js', () => ({ config: { FEATURE_PRESENCE: false } }));
    vi.doMock('../../src/gateway/baileys.js', () => ({
      isBaileysConnected: () => true,
      getSocket: () => ({ readMessages, sendPresenceUpdate, sendMessage }),
    }));
    const { startTyping } = await import('../../src/gateway/presence.js');
    const handle = startTyping('jid', 'm1');
    handle.stop();
    expect(sendPresenceUpdate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — confirm fails**

Run: `npx vitest run tests/unit/presence.spec.ts`
Expected: 4 fails on the new describe block.

- [ ] **Step 3: Implement `startTyping`**

Replace the stub in `src/gateway/presence.ts` with:

```typescript
const REFRESH_MS = 8_000;

type Entry = {
  handle: TypingHandle;
  jid: string;
  timer: NodeJS.Timeout;
  started_at: number;
};

const handles = new Map<string, Entry>();

export function startTyping(remote_jid: string, mensagem_id: string): TypingHandle {
  if (!config.FEATURE_PRESENCE) return NOOP_HANDLE;
  if (!isBaileysConnected()) return NOOP_HANDLE;
  const existing = handles.get(mensagem_id);
  if (existing) return existing.handle;

  const sock = getSocket();
  if (!sock) return NOOP_HANDLE;

  const send = () =>
    sock
      .sendPresenceUpdate('composing', remote_jid)
      .catch((err: Error) => logger.warn({ err: err.message }, 'presence.typing_failed'));
  void send();
  const timer = setInterval(send, REFRESH_MS);

  let stopped = false;
  const handle: TypingHandle = {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      handles.delete(mensagem_id);
      sock
        .sendPresenceUpdate('paused', remote_jid)
        .catch((err: Error) => logger.warn({ err: err.message }, 'presence.typing_paused_failed'));
    },
  };
  handles.set(mensagem_id, { handle, jid: remote_jid, timer, started_at: Date.now() });
  return handle;
}
```

- [ ] **Step 4: Run — confirm passes**

Run: `npx vitest run tests/unit/presence.spec.ts`
Expected: all green (markRead tests + 4 typing tests).

- [ ] **Step 5: Commit**

```bash
git add src/gateway/presence.ts tests/unit/presence.spec.ts
git commit -m "feat(presence): startTyping with idempotent Map-keyed handle + refresh"
```

---

## Task 6: Leak safety — `beforeExit` drain + stale sweep

**Files:**
- Modify: `src/gateway/presence.ts`
- Modify: `tests/unit/presence.spec.ts`

- [ ] **Step 1: Add tests**

Append to `tests/unit/presence.spec.ts`:

```typescript
describe('presence — leak safety', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.doMock('../../src/config/env.js', () => ({ config: { FEATURE_PRESENCE: true } }));
    vi.doMock('../../src/gateway/baileys.js', () => ({
      isBaileysConnected: () => true,
      getSocket: () => ({ readMessages, sendPresenceUpdate, sendMessage }),
    }));
  });
  afterEach(() => vi.useRealTimers());

  it('sweep stops handles older than 5 min', async () => {
    const { startTyping, _internal } = await import('../../src/gateway/presence.js');
    const handle = startTyping('jid', 'old-msg');
    // jump 6 minutes forward
    vi.advanceTimersByTime(6 * 60 * 1000);
    _internal.runStaleSweep(); // exposed for tests
    // After sweep, handle is stopped — second stop() is a no-op.
    handle.stop();
    const pausedCalls = sendPresenceUpdate.mock.calls.filter((c) => c[0] === 'paused');
    expect(pausedCalls.length).toBe(1); // only the sweep's stop counted
  });
});
```

(Note: needs `import { afterEach } from 'vitest'` at the top of the file if not already there.)

- [ ] **Step 2: Run — fails**

Run: `npx vitest run tests/unit/presence.spec.ts`
Expected: 1 fail (`_internal.runStaleSweep` undefined).

- [ ] **Step 3: Implement sweep + drain**

Append to `src/gateway/presence.ts`:

```typescript
const STALE_MS = 5 * 60 * 1000;
const SWEEP_MS = 60 * 1000;

function runStaleSweep(): void {
  const cutoff = Date.now() - STALE_MS;
  for (const [id, entry] of handles) {
    if (entry.started_at < cutoff) {
      entry.handle.stop();
      logger.warn({ mensagem_id: id, age_ms: Date.now() - entry.started_at }, 'presence.typing_stale_swept');
    }
  }
}

const sweepTimer = setInterval(runStaleSweep, SWEEP_MS);
// Don't keep the event loop alive just for the sweep.
sweepTimer.unref?.();

function drainAll(): void {
  for (const entry of handles.values()) entry.handle.stop();
}

process.once('beforeExit', drainAll);

export const _internal = { runStaleSweep, drainAll, handles };
```

- [ ] **Step 4: Run — passes**

Run: `npx vitest run tests/unit/presence.spec.ts`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/presence.ts tests/unit/presence.spec.ts
git commit -m "feat(presence): typing-handle stale sweep + beforeExit drain"
```

---

## Task 7: TDD — `sendReaction`

**Files:**
- Modify: `src/gateway/presence.ts`
- Modify: `tests/unit/presence.spec.ts`

- [ ] **Step 1: Add tests**

```typescript
describe('presence — sendReaction', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('../../src/config/env.js', () => ({ config: { FEATURE_PRESENCE: true } }));
    vi.doMock('../../src/gateway/baileys.js', () => ({
      isBaileysConnected: () => true,
      getSocket: () => ({ readMessages, sendPresenceUpdate, sendMessage }),
    }));
  });

  it('sends a react payload anchored to (remote_jid, whatsapp_id)', async () => {
    const { sendReaction } = await import('../../src/gateway/presence.js');
    sendReaction('jid', 'WAID-9', '✅');
    await new Promise((r) => setImmediate(r));
    expect(sendMessage).toHaveBeenCalledWith('jid', {
      react: { text: '✅', key: { remoteJid: 'jid', id: 'WAID-9', fromMe: false } },
    });
  });

  it('no-op when disconnected', async () => {
    vi.resetModules();
    vi.doMock('../../src/config/env.js', () => ({ config: { FEATURE_PRESENCE: true } }));
    vi.doMock('../../src/gateway/baileys.js', () => ({
      isBaileysConnected: () => false,
      getSocket: () => null,
    }));
    const { sendReaction } = await import('../../src/gateway/presence.js');
    sendReaction('jid', 'id', '✅');
    await new Promise((r) => setImmediate(r));
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — fails**

Run: `npx vitest run tests/unit/presence.spec.ts`
Expected: 2 fails on the new block.

- [ ] **Step 3: Implement `sendReaction`**

Replace the stub:

```typescript
export function sendReaction(
  remote_jid: string,
  whatsapp_id: string,
  emoji: '✅' | '❌',
): void {
  if (!config.FEATURE_PRESENCE) return;
  if (!isBaileysConnected()) return;
  const sock = getSocket();
  if (!sock) return;
  sock
    .sendMessage(remote_jid, {
      react: { text: emoji, key: { remoteJid: remote_jid, id: whatsapp_id, fromMe: false } },
    })
    .catch((err: Error) => logger.warn({ err: err.message }, 'presence.reaction_failed'));
}
```

- [ ] **Step 4: Run — passes**

Run: `npx vitest run tests/unit/presence.spec.ts`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/presence.ts tests/unit/presence.spec.ts
git commit -m "feat(presence): sendReaction"
```

---

## Task 8: TDD — `quotedReplyContext` (pure function)

**Files:**
- Modify: `src/gateway/presence.ts`
- Modify: `tests/unit/presence.spec.ts`

- [ ] **Step 1: Add tests**

```typescript
describe('presence — quotedReplyContext', () => {
  it('builds a context from inbound metadata + truncates to 200 chars', async () => {
    const { quotedReplyContext } = await import('../../src/gateway/presence.js');
    const meta = { whatsapp_id: 'W1', remote_jid: 'J1' };
    const long = 'x'.repeat(500);
    const ctx = quotedReplyContext(meta, long);
    expect(ctx).toEqual({
      key: { remoteJid: 'J1', id: 'W1', fromMe: false },
      message: { conversation: 'x'.repeat(200) },
    });
  });

  it('returns undefined when metadata lacks whatsapp_id', async () => {
    const { quotedReplyContext } = await import('../../src/gateway/presence.js');
    expect(quotedReplyContext({ remote_jid: 'J1' }, 'x')).toBeUndefined();
  });

  it('returns undefined when metadata lacks remote_jid', async () => {
    const { quotedReplyContext } = await import('../../src/gateway/presence.js');
    expect(quotedReplyContext({ whatsapp_id: 'W1' }, 'x')).toBeUndefined();
  });

  it('returns undefined for null metadata', async () => {
    const { quotedReplyContext } = await import('../../src/gateway/presence.js');
    expect(quotedReplyContext(null, 'x')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — fails**

Run: `npx vitest run tests/unit/presence.spec.ts`
Expected: 4 fails.

- [ ] **Step 3: Implement**

Replace the stub:

```typescript
const QUOTED_TRUNCATE = 200;

export function quotedReplyContext(
  inbound_metadata: Record<string, unknown> | null,
  inbound_conteudo: string | null,
): WAQuotedContext | undefined {
  if (!inbound_metadata) return undefined;
  const whatsapp_id = inbound_metadata.whatsapp_id;
  const remote_jid = inbound_metadata.remote_jid;
  if (typeof whatsapp_id !== 'string' || typeof remote_jid !== 'string') return undefined;
  return {
    key: { remoteJid: remote_jid, id: whatsapp_id, fromMe: false },
    message: { conversation: (inbound_conteudo ?? '').slice(0, QUOTED_TRUNCATE) },
  };
}
```

- [ ] **Step 4: Run — passes**

Run: `npx vitest run tests/unit/presence.spec.ts`
Expected: all green across all four `describe` blocks.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/presence.ts tests/unit/presence.spec.ts
git commit -m "feat(presence): quotedReplyContext (pure)"
```

---

## Task 9: Extend `sendOutboundText` with optional quoted

**Files:**
- Modify: `src/gateway/baileys.ts`

- [ ] **Step 1: Update signature**

Locate `export async function sendOutboundText(jid: string, text: string)` (around line 180) and replace with:

```typescript
export async function sendOutboundText(
  jid: string,
  text: string,
  opts?: { quoted?: import('./presence.js').WAQuotedContext },
): Promise<string | null> {
  if (!socket || !connected) {
    logger.warn('baileys.not_connected — cannot send');
    return null;
  }
  const payload: Record<string, unknown> = { text };
  if (opts?.quoted) {
    // Baileys' sendMessage accepts `quoted` as a second-arg option, not in payload.
    const result = await socket.sendMessage(jid, { text }, { quoted: opts.quoted as never });
    return result?.key.id ?? null;
  }
  void payload;
  const result = await socket.sendMessage(jid, { text });
  return result?.key.id ?? null;
}
```

(The conditional split keeps the `quoted: undefined` case identical to the current code path — zero behavior change for callers that don't pass opts.)

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean (only the pre-existing two errors unrelated to this change).

- [ ] **Step 3: Commit**

```bash
git add src/gateway/baileys.ts
git commit -m "feat(presence): sendOutboundText accepts optional { quoted }"
```

---

## Task 10: TDD — `REACTION` early-return in `handleIncoming`

**Files:**
- Modify: `src/gateway/baileys.ts`
- Create: `tests/unit/baileys-handle-incoming.spec.ts`

This task is small and surgical: stop persisting `mensagens` rows for inbound reaction stubs.

- [ ] **Step 1: Inspect the current early returns**

Read `src/gateway/baileys.ts` around the `handleIncoming` function. The early returns are:
- `if (msg.key.fromMe) return;`
- group check
- duplicate check

We add a new one **first** so reactions never even reach dedup/persist.

- [ ] **Step 2: Refactor `handleIncoming` to expose a pure decision helper**

Add a tiny pure helper (testable without a Baileys socket):

```typescript
type StubLike = { messageStubType?: number | null | undefined };

export function isReactionStub(msg: StubLike): boolean {
  // proto.WebMessageInfo.StubType.REACTION === 67 (per Baileys proto).
  // We compare numerically to avoid pulling the proto enum at runtime.
  return msg.messageStubType === 67;
}
```

Then in `handleIncoming`, near the top after the `fromMe` check:

```typescript
if (isReactionStub(msg)) {
  return; // reactions decorate; we never persist them
}
```

- [ ] **Step 3: Write the test**

Create `tests/unit/baileys-handle-incoming.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { isReactionStub } from '../../src/gateway/baileys.js';

describe('baileys — isReactionStub', () => {
  it('returns true for messageStubType=67 (REACTION)', () => {
    expect(isReactionStub({ messageStubType: 67 })).toBe(true);
  });
  it('returns false for ordinary messages', () => {
    expect(isReactionStub({})).toBe(false);
    expect(isReactionStub({ messageStubType: null })).toBe(false);
    expect(isReactionStub({ messageStubType: undefined })).toBe(false);
    expect(isReactionStub({ messageStubType: 1 })).toBe(false);
  });
});
```

- [ ] **Step 4: Run**

Run: `npx vitest run tests/unit/baileys-handle-incoming.spec.ts`
Expected: 2 passes.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/baileys.ts tests/unit/baileys-handle-incoming.spec.ts
git commit -m "feat(presence): drop REACTION stubs in handleIncoming (no mensagens row)"
```

---

## Task 11: Wire `markRead` into `handleIncoming`

**Files:**
- Modify: `src/gateway/baileys.ts`

- [ ] **Step 1: Locate the `markSeen` call**

In `handleIncoming`, after `await markSeen(whatsapp_id);` (the dedup mark), add:

```typescript
// Spec 04 §4.2 / presence design §5.1: surface a read receipt as soon as
// we've validated the message is real.
markRead(remote_jid, whatsapp_id);
```

And add at the top of the file:

```typescript
import { markRead } from './presence.js';
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/gateway/baileys.ts
git commit -m "feat(presence): wire markRead into handleIncoming"
```

---

## Task 12: Wire `startTyping` + `sendReaction` into agent core

**Files:**
- Modify: `src/agent/core.ts`

- [ ] **Step 1: Add imports**

At the top of `src/agent/core.ts`:

```typescript
import { startTyping, sendReaction, quotedReplyContext } from '@/gateway/presence.js';
import { REGISTRY } from '@/tools/_registry.js';
```

- [ ] **Step 2: Wrap the ReAct loop in try/finally with typing handle**

Locate the ReAct loop (`for (let i = 0; i < MAX_REACT_ITERATIONS; i++)`). Just before it, derive the JID and start typing **inside** a try block:

```typescript
const jid = pessoa.telefone_whatsapp.replace('+', '') + '@s.whatsapp.net';
let typing: ReturnType<typeof startTyping> | null = null;
try {
  // 1.5s debounce: only show "typing" if the turn is genuinely slow.
  const debounceTimer = setTimeout(() => {
    typing = startTyping(jid, inbound.id);
  }, 1500);

  // ... existing ReAct loop ...

  clearTimeout(debounceTimer);
} finally {
  typing?.stop();
}
```

Apply this surgically: indent the existing loop into the `try` block; the `clearTimeout` and `finally` close it. **Do not change any other agent logic.**

- [ ] **Step 3: React on side-effect dispatch outcomes**

Inside the loop, after the existing `dispatchTool` call (search for `await dispatchTool(`), use the result:

```typescript
const out = await dispatchTool({ /* existing args */ });
const isError = typeof out === 'object' && out !== null && 'error' in out;
const tool = REGISTRY[tu.tool];
const isSideEffect = tool && (tool.side_effect === 'write' || tool.side_effect === 'communication');
if (isSideEffect) {
  const wid = (inbound.metadata as Record<string, unknown> | null)?.['whatsapp_id'] as string | undefined;
  const errKind = isError ? ((out as { error: string }).error) : null;
  if (!isError) {
    if (wid) sendReaction(jid, wid, '✅');
  } else if (errKind === 'forbidden' || errKind === 'requires_dual_approval') {
    if (wid) sendReaction(jid, wid, '❌');
  }
}
// ... existing results.push and audit ...
```

The existing `isError` computation may already exist (`'error' in out`) — reuse if so.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/agent/core.ts
git commit -m "feat(presence): typing + reaction wiring in agent core"
```

---

## Task 13: Wire `quotedReplyContext` into `sendOutbound`

**Files:**
- Modify: `src/agent/core.ts`

- [ ] **Step 1: Detect correction or active pending**

In the ReAct loop, before calling `sendOutbound(...)`, derive whether we should quote:

```typescript
const shouldQuote =
  (inbound.conteudo && detectCorrection(inbound.conteudo)) || getActivePending(c) !== null;
```

`getActivePending` lives in `@/workflows/pending-questions.js` — add the import:

```typescript
import { getActivePending } from '@/workflows/pending-questions.js';
```

- [ ] **Step 2: Pass quoted to sendOutbound**

Update the `sendOutbound` helper (already in `core.ts`) to accept an optional `quoted`:

```typescript
async function sendOutbound(
  pessoa_id: string,
  conversa_id: string,
  text: string,
  in_reply_to: string,
  opts?: { quoted?: import('@/gateway/presence.js').WAQuotedContext },
): Promise<void> {
  const pessoa = await pessoasRepo.findById(pessoa_id);
  if (!pessoa) return;
  const jid = pessoa.telefone_whatsapp.replace('+', '') + '@s.whatsapp.net';
  const wid = await sendOutboundText(jid, text, opts);
  // ... existing mensagensRepo.create ...
}
```

And at the call site:

```typescript
await sendOutbound(pessoa.id, c.id, text, inbound.id, {
  quoted: shouldQuote
    ? quotedReplyContext(inbound.metadata as Record<string, unknown> | null, inbound.conteudo)
    : undefined,
});
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/agent/core.ts
git commit -m "feat(presence): quoted-reply on correction / active pending"
```

---

## Task 14: End-to-end manual test checklist + push branch

**Files:** none modified — this is the human-driven validation gate.

- [ ] **Step 1: Run the full unit suite**

Run: `npx vitest run tests/unit`
Expected: all green.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: only the two pre-existing errors (`dashboard_sessions` may now resolve depending on which other PRs are merged; `governance/lockdown.ts:26` is unrelated).

- [ ] **Step 3: Local manual smoke (optional, requires Baileys setup)**

With `FEATURE_PRESENCE=true` in `.env`, run `npm run dev`, scan QR. From a non-owner number:
- Send a message → see "lida" tick on your phone within ~1s.
- Send "lança 50 mercado" → see "Maia digitando…" if response > 1.5s; ✅ reaction lands when transaction registered.
- Send "não, era restaurante" → assistant reply is threaded under your correction.
- Try a forbidden action (e.g., send_proactive without dual_approval) → ❌ reaction.

- [ ] **Step 4: Push & open PR**

```bash
git push -u origin feat/whatsapp-ux-polish
gh pr create --base main --title "feat(presence): selective WhatsApp UX polish (read/typing/reactions/quoted)" --body "Implements docs/superpowers/specs/2026-04-29-whatsapp-ux-polish-design.md (sub-project A of three). Gated behind FEATURE_PRESENCE=false by default; flip to true after a 7-day soak per design §9."
```

---

## Acceptance verification (mirrors spec §11)

- [ ] `sendOutboundText` accepts an optional `{ quoted?: WAQuotedContext }` argument; calls without it behave exactly as today (Task 9).
- [ ] `handleIncoming` early-returns on `messageStubType === REACTION` (Task 10).
- [ ] `FEATURE_PRESENCE=true` produces the four signals (Task 14 §3).
- [ ] `FEATURE_PRESENCE=false` produces zero Baileys-side polish calls (Tasks 4, 5, 7 — explicit no-op tests).
- [ ] A Baileys-side failure does not affect the textual reply or audit trail (Tasks 4, 5, 7 catch promises).
- [ ] Typing handle map drains on `beforeExit`; stale > 5 min auto-stops (Task 6).
- [ ] Unit suite covers handle reuse, disconnected-no-op, `quotedReplyContext` missing-field branches, 200-char truncation (Tasks 4-8).
