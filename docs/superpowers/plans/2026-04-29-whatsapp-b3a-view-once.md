# WhatsApp B3a — View-Once for Sensitive Replies — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the agent's text reply carries financial values (saldos, comparativos), wrap the WhatsApp send in `viewOnceMessage` (V1 envelope) so the message disappears from the recipient's chat history after one view. Owner-side preference (`pessoa.preferencias.balance_view_once`) overrides per-pessoa. Feature-flagged behind `FEATURE_VIEW_ONCE_SENSITIVE`.

**Architecture:** A new `Tool.sensitive?: boolean` field marks tools that produce sensitive output (`query_balance`, `compare_entities`). The agent's ReAct loop tracks a turn-local `turnHasSensitive` flag (OR-logic across all tools dispatched in the turn). At the no-tool-uses branch, the loop computes `view_once = turnHasSensitive && pessoa.preferencias.balance_view_once !== false`, and threads the flag through `sendOutbound` → `sendOutboundText` → Baileys' `socket.sendMessage({ text, viewOnce: true })`. Polls do NOT use view-once (incompatible at the WhatsApp protocol level); the prompt-builder is updated with a content-rule one-liner that tells the LLM to avoid embedding monetary figures in poll-question text on sensitive turns. Audit emits `outbound_sent_view_once` after a successful view-once send (guarded by non-null WAID) and `outbound_view_once_skipped_by_preference` when the preference disables it.

**Tech Stack:** TypeScript, vitest, `@whiskeysockets/baileys` 6.7.0 (envelope verified at `node_modules/@whiskeysockets/baileys/lib/Utils/messages.js:440-442`).

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `src/config/env.ts` | Modify | Add `FEATURE_VIEW_ONCE_SENSITIVE` (insert at line 104, before the closing `})` at line 105) |
| `.env.example` | Modify | Document the new feature flag |
| `src/governance/audit-actions.ts` | Modify | Append 2 new actions |
| `src/tools/_registry.ts` | Modify | Add `sensitive?: boolean` to `Tool` type |
| `src/tools/query-balance.ts` | Modify | Set `sensitive: true` |
| `src/tools/compare-entities.ts` | Modify | Set `sensitive: true` |
| `src/gateway/baileys.ts` | Modify | `sendOutboundText` accepts `view_once?: boolean`; gated by `FEATURE_VIEW_ONCE_SENSITIVE` |
| `src/agent/core.ts` | Modify | Extend `sendOutbound` opts; track `turnHasSensitive`; compute `view_once`; emit audits |
| `src/agent/prompt-builder.ts` | Modify | One-line content-rule addition to `LLM_BOUNDARIES` |
| `tests/unit/baileys-view-once.spec.ts` | Create | Contract test: `viewOnce: true` is forwarded to Baileys' `socket.sendMessage` |
| `tests/unit/view-once.spec.ts` | Create | Six §10 branches + null-WAID guard + prompt-builder rule |

No DB migrations (uses existing `pessoas.preferencias` JSONB). No schema rewrites.

**`pessoa.preferencias` nullability note (iter-2 review item 1):** verified at `src/db/schema.ts:128` — the column is `jsonb('preferencias').notNull().default(sql\`'{}'::jsonb\`)`. It is NOT nullable; defaults to `{}`. Tests should use `preferencias: {}` (or omit the key inside an object), not `preferencias: null`. The spec's `as { ... } | null` cast in §4.5 is over-defensive but harmless — keep it as documented to match the spec verbatim.

---

## Task 1: Add `FEATURE_VIEW_ONCE_SENSITIVE` config flag

**Files:**
- Modify: `src/config/env.ts` (insert at line 104, before the closing `})` of the schema object at line 105)
- Modify: `.env.example` (append a documented section)

- [ ] **Step 1: Add the env entry to the schema**

In `src/config/env.ts`, locate the `FEATURE_ONE_TAP` block (lines 101-104) — currently the last entry in the `.object({ ... })` call. Add the new flag right after it, **before** the closing `})` on line 105:

```typescript
    FEATURE_ONE_TAP: z
      .string()
      .default('false')
      .transform((s) => s === 'true' || s === '1'),
    FEATURE_VIEW_ONCE_SENSITIVE: z
      .string()
      .default('false')
      .transform((s) => s === 'true' || s === '1'),
  })
```

- [ ] **Step 2: Document in `.env.example`**

Append to `.env.example` (the file currently has no `FEATURE_*` section — add a new one matching the file's existing `# ---- ... ----` header style):

```bash

# ---- Feature flags ----
# View-once for sensitive replies (saldos, comparativos). Default false.
# When true: outbound text replies for turns that ran a tool flagged
# `sensitive: true` (query_balance, compare_entities) are sent with the
# viewOnce flag, gated by pessoa.preferencias.balance_view_once.
# FEATURE_VIEW_ONCE_SENSITIVE=false
```

- [ ] **Step 3: Verify build passes**

Run: `npm run build`
Expected: zero TypeScript errors. The new boolean field appears on `Config`.

- [ ] **Step 4: Commit**

```bash
git add src/config/env.ts .env.example
git commit -m "feat(b3a): add FEATURE_VIEW_ONCE_SENSITIVE env flag (default false)"
```

---

## Task 2: Append two audit actions

**Files:**
- Modify: `src/governance/audit-actions.ts` (insert after line 76 `'one_tap_dispatch_error'`, before the closing `] as const;` on line 77)

- [ ] **Step 1: Add to `AUDIT_ACTIONS`**

Append two entries to the array (after `'one_tap_dispatch_error'`, before `] as const;`):

```typescript
  'one_tap_dispatch_error',
  'outbound_sent_view_once',
  'outbound_view_once_skipped_by_preference',
] as const;
```

- [ ] **Step 2: Verify build passes**

Run: `npm run build`
Expected: zero TypeScript errors. `AuditAction` union now includes the two new strings.

- [ ] **Step 3: Commit**

```bash
git add src/governance/audit-actions.ts
git commit -m "feat(b3a): add outbound_sent_view_once + skipped_by_preference audit actions"
```

---

## Task 3: Add `Tool.sensitive?: boolean` and flag two tools

**Files:**
- Modify: `src/tools/_registry.ts:32-43` (extend the `Tool` type)
- Modify: `src/tools/query-balance.ts:23-30` (add `sensitive: true`)
- Modify: `src/tools/compare-entities.ts:30-38` (add `sensitive: true`)

> **IMPORTANT — `vi.mock` consolidation rule for `tests/unit/view-once.spec.ts`:** vitest hoists `vi.mock(modulePath, factory)` to the top of the file at runtime. Calling `vi.mock` for the same module path more than once **silently overrides** earlier calls. Therefore the mocks for `'../../src/db/repositories.js'`, `'../../src/governance/audit.js'`, `'../../src/gateway/baileys.js'`, and `'../../src/config/env.js'` must each appear **exactly once** at the top of `view-once.spec.ts`. Tasks 5, 6, 7, and 8 in this plan show their own `vi.mock` blocks for clarity, but the implementer MUST merge them all into one shared block at the top of the file. Each task adds new fields/methods to the existing factory, not a new `vi.mock` call. (Pattern reference: see `tests/unit/pending-gate.spec.ts:7-32` for a similar "all mocks in one block at the top" structure.)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/view-once.spec.ts` with the first describe block. It just asserts the registry surface — no agent loop wiring yet:

```typescript
import { describe, it, expect } from 'vitest';

describe('Tool.sensitive registry surface', () => {
  it('query_balance and compare_entities are flagged sensitive; others are not', async () => {
    const { REGISTRY } = await import('../../src/tools/_registry.js');
    expect(REGISTRY.query_balance?.sensitive).toBe(true);
    expect(REGISTRY.compare_entities?.sensitive).toBe(true);
    // spot-check a few non-sensitive tools
    expect(REGISTRY.list_transactions?.sensitive).toBeFalsy();
    expect(REGISTRY.register_transaction?.sensitive).toBeFalsy();
    expect(REGISTRY.ask_pending_question?.sensitive).toBeFalsy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/view-once.spec.ts`
Expected: FAIL — `REGISTRY.query_balance.sensitive` is `undefined` (the field doesn't exist yet, so the `=== true` assertion fails).

- [ ] **Step 3: Add the field to the `Tool` type**

In `src/tools/_registry.ts`, append `sensitive` to the type literal (line 32-43):

```typescript
export type Tool<I extends z.ZodTypeAny, O extends z.ZodTypeAny> = {
  name: string;
  description: string;
  input_schema: I;
  output_schema: O;
  required_actions: ReadonlyArray<ActionKey>;
  side_effect: 'none' | 'read' | 'write' | 'communication';
  redis_required: boolean;
  operation_type: 'create' | 'correct' | 'cancel' | 'update_meta' | 'parse_only' | 'read' | 'communicate';
  audit_action: AuditAction;
  handler: (input: z.infer<I>, ctx: ToolHandlerCtx) => Promise<z.infer<O>>;
  /**
   * When true, any turn that dispatches this tool flips the outbound text
   * reply into view-once (B3a). OR-logic across all tools in the turn.
   */
  sensitive?: boolean;
};
```

- [ ] **Step 4: Flag `query_balance` as sensitive**

In `src/tools/query-balance.ts`, add the field right after `audit_action: 'balance_queried'`:

```typescript
  audit_action: 'balance_queried',
  sensitive: true,
  handler: async (args, ctx) => {
```

- [ ] **Step 5: Flag `compare_entities` as sensitive**

In `src/tools/compare-entities.ts`, add the field right after `audit_action: 'classification_suggested'`:

```typescript
  audit_action: 'classification_suggested',
  sensitive: true,
  handler: async (args, ctx) => {
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/unit/view-once.spec.ts`
Expected: PASS for the registry-surface block.

- [ ] **Step 7: Commit**

```bash
git add src/tools/_registry.ts src/tools/query-balance.ts src/tools/compare-entities.ts tests/unit/view-once.spec.ts
git commit -m "feat(b3a): Tool.sensitive flag — query_balance and compare_entities marked"
```

---

## Task 4: Extend `sendOutboundText` with `view_once` opt + Baileys envelope contract test

**Files:**
- Modify: `src/gateway/baileys.ts:230-246` (extend opts; add view-once branch)
- Create: `tests/unit/baileys-view-once.spec.ts`

This task verifies the Baileys envelope shape (V1 `viewOnceMessage`, NOT `viewOnceMessageV2`) by mocking `socket.sendMessage` and asserting it received `{ text, viewOnce: true }`. Baileys then internally wraps as `viewOnceMessage` per `node_modules/@whiskeysockets/baileys/lib/Utils/messages.js:440-442`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/baileys-view-once.spec.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendMessage = vi.fn();
const fakeSocket = { sendMessage };

vi.mock('@whiskeysockets/baileys', () => ({
  default: () => fakeSocket,
  DisconnectReason: {},
  useMultiFileAuthState: vi.fn(),
  downloadMediaMessage: vi.fn(),
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/db/repositories.js', () => ({
  mensagensRepo: { createInbound: vi.fn() },
}));

vi.mock('../../src/governance/audit.js', () => ({ audit: vi.fn() }));

// Default: feature flag ON for these tests; individual tests override.
let viewOnceFlag = true;
vi.mock('../../src/config/env.js', () => ({
  config: {
    BAILEYS_AUTH_DIR: './.baileys-auth-test',
    get FEATURE_VIEW_ONCE_SENSITIVE() {
      return viewOnceFlag;
    },
  },
}));

beforeEach(() => {
  sendMessage.mockReset();
  sendMessage.mockResolvedValue({ key: { id: 'WAID-OUT-1' } });
  viewOnceFlag = true;
});

// `sendOutboundText` reads the module-level `socket` and `connected`. To
// drive it from tests without booting the full WA pairing flow, we use a
// test-only `_internal._setSocketForTests` seam (added to baileys.ts in
// Step 3 of this task). This Step 1 test will fail because the seam doesn't
// exist yet — that's the TDD red.

describe('sendOutboundText — view_once envelope contract', () => {
  it('passes { text, viewOnce: true } when opts.view_once && FEATURE_VIEW_ONCE_SENSITIVE', async () => {
    const mod = await import('../../src/gateway/baileys.js');
    mod._internal._setSocketForTests(fakeSocket as never, true);
    await mod.sendOutboundText('5511999999999@s.whatsapp.net', 'Saldo R$ 1.234', { view_once: true });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      '5511999999999@s.whatsapp.net',
      { text: 'Saldo R$ 1.234', viewOnce: true },
      undefined,
    );
  });

  it('does NOT pass viewOnce when FEATURE_VIEW_ONCE_SENSITIVE is false', async () => {
    viewOnceFlag = false;
    const mod = await import('../../src/gateway/baileys.js');
    mod._internal._setSocketForTests(fakeSocket as never, true);
    await mod.sendOutboundText('jid', 'Saldo', { view_once: true });
    expect(sendMessage).toHaveBeenCalledWith('jid', { text: 'Saldo' }, undefined);
  });

  it('does NOT pass viewOnce when opts.view_once is false even with flag on', async () => {
    const mod = await import('../../src/gateway/baileys.js');
    mod._internal._setSocketForTests(fakeSocket as never, true);
    await mod.sendOutboundText('jid', 'Saldo', { view_once: false });
    expect(sendMessage).toHaveBeenCalledWith('jid', { text: 'Saldo' }, undefined);
  });

  it('view_once + quoted forwards both', async () => {
    const mod = await import('../../src/gateway/baileys.js');
    mod._internal._setSocketForTests(fakeSocket as never, true);
    const quoted = { key: { id: 'WAID-IN' } } as never;
    await mod.sendOutboundText('jid', 'R$ x', { view_once: true, quoted });
    expect(sendMessage).toHaveBeenCalledWith('jid', { text: 'R$ x', viewOnce: true }, { quoted });
  });

  it('returns null when not connected (existing behaviour preserved)', async () => {
    const mod = await import('../../src/gateway/baileys.js');
    mod._internal._setSocketForTests(null, false);
    const wid = await mod.sendOutboundText('jid', 'whatever', { view_once: true });
    expect(wid).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/baileys-view-once.spec.ts`
Expected: FAIL — `_setSocketForTests` doesn't exist; type error on `view_once` opt; `sendMessage` is not called with `viewOnce: true`.

- [ ] **Step 3: Add the test hook to `baileys.ts`**

Append to `src/gateway/baileys.ts` (after line 257, before `mediaPathFor`):

```typescript
// Test-only seam. Production code never calls this. Lets unit tests inject a
// mock socket without booting the full WA pairing flow.
export const _internal = {
  _setSocketForTests(s: WASocket | null, isConnected: boolean): void {
    socket = s;
    connected = isConnected;
  },
};
```

- [ ] **Step 4: Extend `sendOutboundText` with `view_once` opt**

Replace the function at `src/gateway/baileys.ts:230-246` with the version below. Note: we always invoke `socket.sendMessage` with a third `quoted` arg (passing `undefined` when no quote), so the call's arity is stable for `toHaveBeenCalledWith` matchers:

```typescript
export async function sendOutboundText(
  jid: string,
  text: string,
  opts?: { quoted?: WAQuotedContext; view_once?: boolean },
): Promise<string | null> {
  if (!socket || !connected) {
    logger.warn('baileys.not_connected — cannot send');
    return null;
  }
  const useViewOnce = !!opts?.view_once && config.FEATURE_VIEW_ONCE_SENSITIVE;
  const content = useViewOnce ? { text, viewOnce: true } : { text };
  // Baileys' sendMessage accepts `quoted` as third-arg MiscMessageGenerationOptions.
  // We always pass the third arg (undefined when no quote) so call arity is stable.
  const miscOpts = opts?.quoted ? { quoted: opts.quoted } : undefined;
  const result = await socket.sendMessage(jid, content, miscOpts);
  return result?.key.id ?? null;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/unit/baileys-view-once.spec.ts`
Expected: PASS — all five test cases.

- [ ] **Step 6: Run the full test suite to confirm no regressions**

Run: `npx vitest run`
Expected: PASS for all existing tests.

- [ ] **Step 7: Commit**

```bash
git add src/gateway/baileys.ts tests/unit/baileys-view-once.spec.ts
git commit -m "feat(b3a): sendOutboundText accepts view_once opt; gated by FEATURE_VIEW_ONCE_SENSITIVE"
```

---

## Task 5: Extend `sendOutbound` in `core.ts` to thread `view_once`

**Files:**
- Modify: `src/agent/core.ts:296-323` (extend `sendOutbound` signature + body)

This task is a pure refactor — the new opt is plumbed but not yet computed at the call site (Task 6 does that). Tested by extending `view-once.spec.ts`.

- [ ] **Step 1: Write the failing test**

This task introduces the agent-loop mocks. Add the shared mock block at the **top of the file** (above the registry-surface describe block from Task 3). Subsequent tasks (6, 7, 8) extend fields on these same mocks — they MUST NOT call `vi.mock` again for the same module path.

```typescript
// At the TOP of tests/unit/view-once.spec.ts — add this BEFORE the existing
// "Tool.sensitive registry surface" describe block.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendOutboundText = vi.fn();
const findById = vi.fn();
const audit = vi.fn();
const createMensagem = vi.fn();
const findMensagem = vi.fn();
const markProcessed = vi.fn();
const recentInConversation = vi.fn();

// Mutable feature-flag values for per-test override (Task 6 flag-off scenario).
const flagState = { FEATURE_VIEW_ONCE_SENSITIVE: true };

vi.mock('../../src/gateway/baileys.js', () => ({
  sendOutboundText,
  isBaileysConnected: () => true,
}));
vi.mock('../../src/db/repositories.js', () => ({
  pessoasRepo: { findById },
  mensagensRepo: {
    create: createMensagem,
    findById: findMensagem,
    markProcessed,
    recentInConversation,
    setConversaId: vi.fn(),
    createInbound: vi.fn(),
  },
  pendingQuestionsRepo: { findActiveSnapshot: vi.fn() },
  conversasRepo: { touch: vi.fn() },
  selfStateRepo: { getActive: vi.fn().mockResolvedValue(null) },
  factsRepo: { listForScopes: vi.fn().mockResolvedValue([]) },
  rulesRepo: { listActive: vi.fn().mockResolvedValue([]) },
  entityStatesRepo: { byId: vi.fn().mockResolvedValue(null) },
  entidadesRepo: { byIds: vi.fn().mockResolvedValue([]) },
}));
vi.mock('../../src/governance/audit.js', () => ({ audit }));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../src/config/env.js', () => ({
  config: new Proxy(
    {
      FEATURE_ONE_TAP: false,
      FEATURE_PENDING_GATE: false,
      OWNER_TELEFONE_WHATSAPP: '+5511999999999',
    } as Record<string, unknown>,
    {
      get(target, prop) {
        if (prop === 'FEATURE_VIEW_ONCE_SENSITIVE') return flagState.FEATURE_VIEW_ONCE_SENSITIVE;
        return target[prop as string];
      },
    },
  ),
}));

describe('sendOutbound — view_once threading', () => {
  beforeEach(() => {
    sendOutboundText.mockReset();
    findById.mockReset();
    audit.mockReset();
    createMensagem.mockReset();
    sendOutboundText.mockResolvedValue('WAID-1');
    findById.mockResolvedValue({ id: 'p1', telefone_whatsapp: '+5511888888888' });
  });

  it('forwards view_once to sendOutboundText when set', async () => {
    const core = await import('../../src/agent/core.js');
    // sendOutbound is module-private; expose via _internal hook
    await core._internal.sendOutbound('p1', 'c1', 'Saldo R$ 1k', 'in1', { view_once: true });
    expect(sendOutboundText).toHaveBeenCalledWith(
      '5511888888888@s.whatsapp.net',
      'Saldo R$ 1k',
      expect.objectContaining({ view_once: true }),
    );
  });

  it('omits view_once when not set', async () => {
    const core = await import('../../src/agent/core.js');
    await core._internal.sendOutbound('p1', 'c1', 'Lista', 'in1', {});
    const call = sendOutboundText.mock.calls[0]!;
    expect(call[2]?.view_once).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/view-once.spec.ts`
Expected: FAIL — `core._internal.sendOutbound` is `undefined`; signature doesn't accept `view_once`.

- [ ] **Step 3: Extend `sendOutbound` and expose via `_internal`**

In `src/agent/core.ts`, replace the `sendOutbound` opts type + body (lines 296-323) with:

```typescript
async function sendOutbound(
  pessoa_id: string,
  conversa_id: string,
  text: string,
  in_reply_to: string,
  opts?: {
    pending_question_id?: string | null;
    quoted?: import('@/gateway/presence.js').WAQuotedContext;
    view_once?: boolean;
  },
): Promise<string | null> {
  const pessoa = await pessoasRepo.findById(pessoa_id);
  if (!pessoa) return null;
  const jid = pessoa.telefone_whatsapp.replace('+', '') + '@s.whatsapp.net';
  const sendOpts: { quoted?: import('@/gateway/presence.js').WAQuotedContext; view_once?: boolean } = {};
  if (opts?.quoted) sendOpts.quoted = opts.quoted;
  if (opts?.view_once) sendOpts.view_once = true;
  const wid = await sendOutboundText(
    jid,
    text,
    Object.keys(sendOpts).length ? sendOpts : undefined,
  );
  const metadata: Record<string, unknown> = { whatsapp_id: wid, in_reply_to };
  if (opts?.pending_question_id) metadata.pending_question_id = opts.pending_question_id;
  if (opts?.view_once) metadata.view_once = true;
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
  return wid;
}
```

Note the return type changed from `Promise<void>` to `Promise<string | null>` so Task 6's audit logic can branch on the WAID. Existing callers ignore the return value, so this is backward-compatible.

- [ ] **Step 4: Add `sendOutbound` to the `_internal` export**

Update the existing `_internal` export in `core.ts:42`:

```typescript
export const _internal = { scheduleTypingDebounce, sendOutbound };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/unit/view-once.spec.ts`
Expected: PASS for the new describe block. The earlier registry-surface block also still passes.

- [ ] **Step 6: Commit**

```bash
git add src/agent/core.ts tests/unit/view-once.spec.ts
git commit -m "feat(b3a): sendOutbound accepts view_once opt and threads to sendOutboundText"
```

---

## Task 6: Track `turnHasSensitive` and emit `outbound_sent_view_once` audit (with null-WAID guard)

**Files:**
- Modify: `src/agent/core.ts:142-180` (declare `turnHasSensitive`; flip on dispatch; compute `view_once`; pass to `sendOutbound`; emit audit)
- Modify: `src/agent/core.ts:296-...` (extract sensitive_tools list; emit audit when wid && view_once)

This is the heart of the feature. Test cases cover four §10 scenarios + the iter-2 null-WAID guard:
1. Sensitive turn + flag on + preference unset → view-once send + `outbound_sent_view_once` audit
2. Mixed turn (sensitive + non-sensitive) → flag set; same outcome as (1)
3. Non-sensitive turn → no view-once; no audit
4. Flag off → no view-once; no audit (even on sensitive turn)
5. **Null-WAID guard**: sensitive turn + sendOutboundText returns null → no audit fires

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/view-once.spec.ts` — same file, new describe block. The agent-loop tests need additional `vi.mock` calls for modules that haven't been mocked yet. Per the consolidation rule, add these new `vi.mock` calls at the TOP of the file alongside the shared block (NOT inside the describe block):

```typescript
// Add at the TOP of the file, after the Task 5 vi.mock block.
const dispatchTool = vi.fn();
vi.mock('../../src/tools/_dispatcher.js', () => ({ dispatchTool }));

const callLLM = vi.fn();
vi.mock('../../src/lib/claude.js', () => ({ callLLM }));

const buildPrompt = vi.fn();
vi.mock('../../src/agent/prompt-builder.js', () => ({
  buildPrompt,
  PROMPT_TOKEN_BUDGET_INPUT: 11000,
  PROMPT_TOKEN_BUDGET_OUTPUT: 1024,
}));

vi.mock('../../src/agent/pending-gate.js', () => ({
  checkPendingFirst: vi.fn().mockResolvedValue({ kind: 'no_pending' }),
}));

vi.mock('../../src/identity/resolver.js', () => ({ resolveIdentity: vi.fn() }));
vi.mock('../../src/identity/quarantine.js', () => ({
  handleQuarantineFirstContact: vi.fn(),
  handleOwnerIdentityReply: vi.fn(),
}));
vi.mock('../../src/governance/permissions.js', () => ({
  resolveScope: vi.fn().mockResolvedValue({ entidades: [], byEntity: new Map() }),
}));
vi.mock('../../src/gateway/rate-limit.js', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ kind: 'allow' }),
  formatPoliteReply: vi.fn(),
}));
vi.mock('../../src/gateway/presence.js', () => ({
  startTyping: vi.fn(() => ({ stop: vi.fn() })),
  sendReaction: vi.fn(),
  quotedReplyContext: vi.fn(),
  sendPoll: vi.fn(),
}));
vi.mock('../../src/workflows/pending-questions.js', () => ({
  getActivePending: vi.fn().mockReturnValue(null),
}));
vi.mock('../../src/agent/reflection.js', () => ({
  detectCorrection: vi.fn().mockReturnValue(false),
  reflectOnCorrection: vi.fn(),
  findPreviousAssistantMessage: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  db: {} as never,
  withTx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
}));

// `loadConversaWithPessoa` in core.ts uses dynamic imports of db/client and
// db/schema. Since the agent loop test only exercises the no-tool-uses branch
// after a fake LLM response, we sidestep that helper by feeding the test via
// findMensagem returning an inbound that already has conversa_id set.

const PESSOA = {
  id: 'p1',
  telefone_whatsapp: '+5511888888888',
  nome: 'Test',
  tipo: 'owner',
  preferencias: {},
} as never;
const CONVERSA = { id: 'c1', pessoa_id: 'p1' } as never;
const INBOUND = {
  id: 'in1',
  conversa_id: 'c1',
  direcao: 'in' as const,
  tipo: 'texto' as const,
  conteudo: 'qual o saldo?',
  metadata: { whatsapp_id: 'WAID-IN' },
  processada_em: null,
};

describe('agent loop — view-once decision + audit', () => {
  beforeEach(() => {
    callLLM.mockReset();
    dispatchTool.mockReset();
    sendOutboundText.mockReset();
    audit.mockReset();
    createMensagem.mockReset();
    findById.mockReset();
    findMensagem.mockReset();
    markProcessed.mockReset();
    recentInConversation.mockReset().mockResolvedValue([]);
    buildPrompt.mockResolvedValue({ system: 's', messages: [] });
    findMensagem.mockResolvedValue({ ...INBOUND });
    findById.mockResolvedValue(PESSOA);
    sendOutboundText.mockResolvedValue('WAID-OUT');
    // tools: query_balance is sensitive, list_transactions is not
    // We patch the REGISTRY indirectly via the test seam from Task 3.
  });

  async function runWithToolUses(toolNames: string[]) {
    // First LLM call: tool uses
    callLLM.mockResolvedValueOnce({
      content: '',
      tool_uses: toolNames.map((t, i) => ({ id: `tu-${i}`, tool: t, args: {} })),
      usage: { input_tokens: 100, output_tokens: 10 },
    });
    // Second LLM call: final text
    callLLM.mockResolvedValueOnce({
      content: 'Saldo R$ 1.234,56',
      tool_uses: [],
      usage: { input_tokens: 50, output_tokens: 20 },
    });
    dispatchTool.mockResolvedValue({ ok: true });
    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');
  }

  it('sensitive turn (query_balance) + flag on + preference unset → view-once + audit', async () => {
    await runWithToolUses(['query_balance']);
    expect(sendOutboundText).toHaveBeenCalledWith(
      expect.stringMatching(/@s\.whatsapp\.net$/),
      'Saldo R$ 1.234,56',
      expect.objectContaining({ view_once: true }),
    );
    const auditCalls = audit.mock.calls.map((c) => c[0]);
    expect(auditCalls).toContainEqual(
      expect.objectContaining({
        acao: 'outbound_sent_view_once',
        metadata: expect.objectContaining({
          sensitive_tools: ['query_balance'],
          whatsapp_id: 'WAID-OUT',
        }),
      }),
    );
  });

  it('mixed turn (query_balance + list_transactions) → still view-once', async () => {
    await runWithToolUses(['list_transactions', 'query_balance']);
    expect(sendOutboundText).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ view_once: true }),
    );
  });

  it('non-sensitive turn → no view-once; no view-once audit', async () => {
    await runWithToolUses(['list_transactions']);
    const lastCall = sendOutboundText.mock.calls.at(-1)!;
    expect(lastCall[2]?.view_once).toBeUndefined();
    const acoes = audit.mock.calls.map((c) => c[0].acao);
    expect(acoes).not.toContain('outbound_sent_view_once');
    expect(acoes).not.toContain('outbound_view_once_skipped_by_preference');
  });

  it('null WAID (Baileys disconnected) → no outbound_sent_view_once audit', async () => {
    sendOutboundText.mockResolvedValueOnce(null); // disconnect simulated
    await runWithToolUses(['query_balance']);
    const acoes = audit.mock.calls.map((c) => c[0].acao);
    expect(acoes).not.toContain('outbound_sent_view_once');
  });

  it('FEATURE_VIEW_ONCE_SENSITIVE=false → no view-once, no audit (even on sensitive turn)', async () => {
    // The shared config mock uses a Proxy whose getter reads
    // `flagState.FEATURE_VIEW_ONCE_SENSITIVE`. Flip it for this test:
    flagState.FEATURE_VIEW_ONCE_SENSITIVE = false;
    try {
      await runWithToolUses(['query_balance']);
      const lastCall = sendOutboundText.mock.calls.at(-1)!;
      // Agent loop gates `view_once` on the flag (Task 6 Step 3), so view_once
      // is never set on the call when the flag is off — even on a sensitive turn.
      expect(lastCall[2]?.view_once).toBeUndefined();
      const acoes = audit.mock.calls.map((c) => c[0].acao);
      expect(acoes).not.toContain('outbound_sent_view_once');
      expect(acoes).not.toContain('outbound_view_once_skipped_by_preference');
    } finally {
      flagState.FEATURE_VIEW_ONCE_SENSITIVE = true;
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/view-once.spec.ts`
Expected: FAIL — `runAgentForMensagem` does not yet flip view-once based on `turnHasSensitive`; no audit emitted.

- [ ] **Step 3: Add `turnHasSensitive` tracking and computation in `core.ts`**

In `src/agent/core.ts`, the ReAct loop body (around lines 152-273) needs:

a) Declare `turnHasSensitive` once before the loop. After line 148 (`} | null = null;`), add:

```typescript
  let turnHasSensitive = false;
  const sensitiveTools: string[] = [];
```

b) Inside the for-loop, after each `dispatchTool`, set the flag. Find the block at lines 240-258 (after `dispatchTool` returns and the `tool` lookup happens, around `const tool = REGISTRY[tu.tool];`) and add:

```typescript
        const tool = REGISTRY[tu.tool];
        if (tool?.sensitive && !sensitiveTools.includes(tu.tool)) {
          turnHasSensitive = true;
          sensitiveTools.push(tu.tool);
        }
        const isSideEffect =
          tool && (tool.side_effect === 'write' || tool.side_effect === 'communication');
        // ...rest of existing block unchanged
```

**Why the `!sensitiveTools.includes(tu.tool)` dedup**: the LLM may dispatch the same tool more than once in a single turn (e.g., querying balance for two different `entidade_id`s as separate tool calls). The `sensitive_tools` list embedded in the audit metadata is meant as a deduplicated set of tool names that flipped the flag, not a count of calls. Don't simplify to `.push()` without the guard — you'll end up with `['query_balance', 'query_balance']` in the audit row and the audit becomes harder to query.

c) At the no-tool-uses branch (lines 157-180, the `if (res.tool_uses.length === 0)` block), compute `view_once` and pass it:

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
            // Per spec §6: when FEATURE_VIEW_ONCE_SENSITIVE is false, Tool.sensitive
            // flags have NO runtime effect. We gate view_once on the flag here so
            // the audit also doesn't fire when the feature is off (the alternative —
            // gating only inside baileys.ts — would cause the agent loop's audit to
            // fire even when no view-once envelope was actually used).
            const view_once =
              config.FEATURE_VIEW_ONCE_SENSITIVE &&
              turnHasSensitive &&
              (pessoa.preferencias as { balance_view_once?: boolean } | null)?.balance_view_once !== false;
            const wid = await sendOutbound(pessoa.id, c.id, text, inbound.id, {
              pending_question_id: latestPending?.id ?? null,
              quoted: shouldQuote
                ? quotedReplyContext(inbound.metadata as Record<string, unknown> | null, inbound.conteudo)
                : undefined,
              view_once,
            });
            if (wid && view_once) {
              await audit({
                acao: 'outbound_sent_view_once',
                pessoa_id: pessoa.id,
                conversa_id: c.id,
                mensagem_id: inbound.id,
                metadata: {
                  whatsapp_id: wid,
                  sensitive_tools: sensitiveTools,
                },
              });
            }
          }
        }
        break;
      }
```

Note: the audit fires only if `wid && view_once`. When `sendOutboundText` returns null (disconnected), the audit is silently skipped per spec §4.6 iter-2 fix. When `FEATURE_VIEW_ONCE_SENSITIVE` is off, `view_once` evaluates to `false` here, so neither the call's `view_once` opt nor the audit fires — matching spec §6's "no runtime effect" guarantee.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/view-once.spec.ts`
Expected: PASS for the four scenarios that don't depend on the flag-off override.

- [ ] **Step 5: Run the full test suite to confirm no regressions**

Run: `npx vitest run`
Expected: PASS for all existing tests. Particular ones to watch: `agent-typing-debounce.spec.ts`, `pending-gate.spec.ts`, `one-tap-poll.spec.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/agent/core.ts tests/unit/view-once.spec.ts
git commit -m "feat(b3a): turnHasSensitive tracking + view-once decision + audit (null-WAID guard)"
```

---

## Task 7: Pessoa preference override + `outbound_view_once_skipped_by_preference`

**Files:**
- Modify: `src/agent/core.ts` (the no-tool-uses branch — extend the audit logic to emit the skipped audit when preference is `false`)

The decision computation in Task 6 already handles the preference (via `!== false`). What's missing: when `turnHasSensitive` is true but the preference disables view-once, the spec §4.6 requires emitting `outbound_view_once_skipped_by_preference`. Per spec, this audit fires BEFORE the send (it's a decision-time event, independent of delivery success).

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/view-once.spec.ts`:

```typescript
describe('agent loop — preference override', () => {
  beforeEach(() => {
    // Same beforeEach setup as the prior describe block.
    // Re-mock pessoa with balance_view_once: false.
    findById.mockResolvedValue({
      ...PESSOA,
      preferencias: { balance_view_once: false },
    });
    sendOutboundText.mockResolvedValue('WAID-OUT');
  });

  it('preference=false on sensitive turn → no view-once; skipped audit fires', async () => {
    callLLM.mockResolvedValueOnce({
      content: '',
      tool_uses: [{ id: 't1', tool: 'query_balance', args: {} }],
      usage: { input_tokens: 100, output_tokens: 10 },
    });
    callLLM.mockResolvedValueOnce({
      content: 'Saldo R$ 1.234',
      tool_uses: [],
      usage: { input_tokens: 50, output_tokens: 20 },
    });
    dispatchTool.mockResolvedValue({ ok: true });
    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');

    // Outbound went out as plain text — no view_once
    const lastCall = sendOutboundText.mock.calls.at(-1)!;
    expect(lastCall[2]?.view_once).toBeUndefined();

    // Skipped audit fired
    const acoes = audit.mock.calls.map((c) => c[0].acao);
    expect(acoes).toContain('outbound_view_once_skipped_by_preference');
    // Success audit did NOT fire
    expect(acoes).not.toContain('outbound_sent_view_once');
  });

  it('preference=false + Baileys disconnected → skipped audit STILL fires (decision-time)', async () => {
    sendOutboundText.mockResolvedValueOnce(null);
    callLLM.mockResolvedValueOnce({
      content: '',
      tool_uses: [{ id: 't1', tool: 'query_balance', args: {} }],
      usage: { input_tokens: 100, output_tokens: 10 },
    });
    callLLM.mockResolvedValueOnce({
      content: 'Saldo',
      tool_uses: [],
      usage: { input_tokens: 50, output_tokens: 20 },
    });
    dispatchTool.mockResolvedValue({ ok: true });
    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');
    const acoes = audit.mock.calls.map((c) => c[0].acao);
    // Skipped audit was emitted before the send attempt
    expect(acoes).toContain('outbound_view_once_skipped_by_preference');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/view-once.spec.ts`
Expected: FAIL — `outbound_view_once_skipped_by_preference` is never emitted.

- [ ] **Step 3: Emit the skipped audit BEFORE the send**

In `src/agent/core.ts` no-tool-uses branch, modify the section right above the `sendOutbound` call. Replace the Task 6 Step 3 computation:

```typescript
            const view_once =
              config.FEATURE_VIEW_ONCE_SENSITIVE &&
              turnHasSensitive &&
              (pessoa.preferencias as { balance_view_once?: boolean } | null)?.balance_view_once !== false;
```

with:

```typescript
            const prefDisabled =
              (pessoa.preferencias as { balance_view_once?: boolean } | null)?.balance_view_once === false;
            const view_once =
              config.FEATURE_VIEW_ONCE_SENSITIVE && turnHasSensitive && !prefDisabled;
            // Decision-time audit: fires on sensitive turn when the preference suppresses view-once.
            // Independent of whether the resulting plain-text send succeeds (Baileys may be down).
            // Only emit when the feature is actually enabled — when the flag is off, the
            // Tool.sensitive flags have no runtime effect (spec §6) so a "skipped" audit
            // would be misleading.
            if (config.FEATURE_VIEW_ONCE_SENSITIVE && turnHasSensitive && prefDisabled) {
              await audit({
                acao: 'outbound_view_once_skipped_by_preference',
                pessoa_id: pessoa.id,
                conversa_id: c.id,
                mensagem_id: inbound.id,
                metadata: { sensitive_tools: sensitiveTools },
              });
            }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/view-once.spec.ts`
Expected: PASS for both new scenarios. All previously-green scenarios still pass.

- [ ] **Step 5: Run the full test suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent/core.ts tests/unit/view-once.spec.ts
git commit -m "feat(b3a): pessoa.balance_view_once=false override + skipped_by_preference audit"
```

---

## Task 8: Prompt-builder content rule (one-liner addition)

**Files:**
- Modify: `src/agent/prompt-builder.ts:15-30` (extend `LLM_BOUNDARIES` with the new rule)

Per spec §4.5 (iter-2 reviewer item), the prompt-builder gains a one-line content rule: during a sensitive turn, the LLM should not embed monetary figures in `ask_pending_question`'s `pergunta` text. We document the constraint in `LLM_BOUNDARIES` (the natural location: it already houses turn-shaping rules).

**Iter-2 reviewer recommendation 4 (advisory)**: name the exact location in `prompt-builder.ts` for the addition. Resolution: append to `LLM_BOUNDARIES` after the existing "list_pending" rule. The block is built once at module load, so a single string append suffices.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/view-once.spec.ts`:

```typescript
describe('prompt-builder content rule', () => {
  it('LLM_BOUNDARIES instructs the LLM to keep monetary figures out of poll question text', async () => {
    const mod = await import('../../src/agent/prompt-builder.js');
    const boundaries = mod._internal.LLM_BOUNDARIES;
    // Loose match — the exact wording can vary, but the rule must be present.
    expect(boundaries).toMatch(/ask_pending_question/);
    expect(boundaries).toMatch(/pergunta|poll/i);
    expect(boundaries).toMatch(/valor|monetár|R\$/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/view-once.spec.ts`
Expected: FAIL — `LLM_BOUNDARIES` does not yet mention the rule.

- [ ] **Step 3: Add the one-liner to `LLM_BOUNDARIES`**

In `src/agent/prompt-builder.ts`, extend the `LLM_BOUNDARIES` template literal (lines 15-30). After the existing `list_pending` paragraph, append:

```typescript
const LLM_BOUNDARIES = `
Você é uma camada de interpretação. Você NÃO PODE:
- Escolher entidade, conta ou pessoa que o usuário não mencionou explicitamente.
- Compor lista de ações além do profile_id do interlocutor.
- Burlar dual approval (4-eyes). O backend impõe independente do que você emitir.
- Inventar valores, datas ou nomes ausentes do contexto e dos resultados de tools.
Você emite INTENTS estruturados; o backend executa.

## Quando usar workflow vs ReAct simples
- ReAct turn-by-turn (default): pedidos resolvidos em ≤2 tool calls e na mesma conversa.
- start_workflow: tarefa precisa de múltiplos passos sequenciais com dependências, OU
  espera evento externo (cobrança, follow-up, fechamento mensal), OU envolve outra pessoa.
  Crie o workflow e responda ao usuário confirmando o plano; o cron continua a execução.
- list_pending: sempre que o usuário perguntar "o que tá pendente", "tem algo aberto?",
  "preciso aprovar algo?" — antes de responder, chame esta tool.

## Conteúdo sensível em poll de confirmação
- Quando o turno consultou saldo/comparativo (turno sensível) e você precisar emitir
  ask_pending_question, NÃO embute valores monetários no texto da \`pergunta\`. Use
  formulação indireta ("Confirma a transferência?" em vez de "Confirma transferir
  R$ 12.345,67?"). Os valores podem aparecer truncados em opções, se necessário.
`.trim();
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/view-once.spec.ts`
Expected: PASS for the prompt-builder block.

- [ ] **Step 5: Verify no other tests regressed**

Run: `npx vitest run`
Expected: PASS — no other test asserts on the exact length or content of `LLM_BOUNDARIES`.

- [ ] **Step 6: Commit**

```bash
git add src/agent/prompt-builder.ts tests/unit/view-once.spec.ts
git commit -m "feat(b3a): prompt-builder content rule — no monetary figures in sensitive poll text"
```

---

## Task 9: Final pass — typecheck, lint, manual integration checklist, branch handoff

**Files:**
- None modified. This task is verification + the PR description.

- [ ] **Step 1: Full typecheck**

Run: `npm run build`
Expected: zero errors.

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: all tests pass. New tests cover:
- `tests/unit/baileys-view-once.spec.ts` — 5 cases (envelope contract)
- `tests/unit/view-once.spec.ts` — registry surface + `sendOutbound` threading + 4 agent-loop scenarios + 2 preference scenarios + 1 prompt-builder rule = 9 cases minimum.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: zero errors. Common gotchas:
- The `pessoa.preferencias as { balance_view_once?: boolean } | null` cast is intentional per spec §4.5 — silence the lint with the existing project conventions if it complains about type assertions.

- [ ] **Step 4: Manual integration checklist (PR description)**

In the PR description, document the manual verification:

```markdown
## Manual verification (Android receiver)

1. Set `FEATURE_VIEW_ONCE_SENSITIVE=true` in `.env`, restart.
2. From the test pessoa's phone, ask: "qual o saldo?"
3. Maia should reply with the saldo wrapped in view-once (icon: 1).
4. Open the message, then close. The text should disappear.
5. Set `pessoa.preferencias = { "balance_view_once": false }` via SQL.
6. Repeat (2). Maia should reply as plain text.
7. Verify in `audit_log`: one `outbound_sent_view_once` row from step 3, one `outbound_view_once_skipped_by_preference` row from step 6.
```

- [ ] **Step 5: Push the branch and open the PR**

```bash
git push -u origin design/whatsapp-b3a-view-once
gh pr create --title "feat(whatsapp-b3a): view-once for sensitive replies" --body "$(cat <<'EOF'
## Summary

- New `Tool.sensitive` boolean (`query_balance`, `compare_entities` flagged).
- Agent ReAct loop tracks `turnHasSensitive` (OR-logic across the turn).
- `sendOutboundText` accepts `view_once?: boolean`, gated by `FEATURE_VIEW_ONCE_SENSITIVE`.
- Pessoa preference (`pessoa.preferencias.balance_view_once = false`) overrides per-pessoa.
- New audits: `outbound_sent_view_once` (after a successful send), `outbound_view_once_skipped_by_preference` (decision-time, when preference suppresses).
- Prompt-builder content rule: LLM is told not to embed monetary figures in poll-question text on sensitive turns.

## Spec

`docs/superpowers/specs/2026-04-29-whatsapp-b3a-view-once-design.md`

## Test plan

- [ ] `npx vitest run tests/unit/baileys-view-once.spec.ts tests/unit/view-once.spec.ts` — all green.
- [ ] Manual: set `FEATURE_VIEW_ONCE_SENSITIVE=true`, ask saldo from a real phone, confirm view-once UI on Android.
- [ ] Manual: set `preferencias.balance_view_once=false`, verify plain text reply + `outbound_view_once_skipped_by_preference` audit row.
- [ ] Manual: stop Baileys, send a sensitive turn, confirm NO `outbound_sent_view_once` row was written (null-WAID guard).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Verification matrix (maps to spec §12 acceptance criteria)

| AC bullet | Plan task | Test |
|---|---|---|
| `Tool.sensitive: true` on `query_balance`, `compare_entities` | 3 | `view-once.spec.ts` registry-surface block |
| `turnHasSensitive` OR-logic on dispatch | 6 | `view-once.spec.ts` "mixed turn" |
| Flag on + sensitive + preference unset → view-once + audit | 6 | `view-once.spec.ts` first scenario |
| `balance_view_once = false` override → no view-once + skipped audit | 7 | `view-once.spec.ts` preference block |
| Non-sensitive turn → no view-once, no audit | 6 | `view-once.spec.ts` non-sensitive scenario |
| Flag off → branch never taken | 6 | `view-once.spec.ts` flag-off scenario |
| Polls unaffected | spec docs only | n/a (no code change to `sendOutboundPoll`) |
| `quoted` opt preserved | 4 | `baileys-view-once.spec.ts` quoted+view_once |
| Unit coverage of all six branches of §10 | 6+7 | `view-once.spec.ts` |
| **Null-WAID guard** | 6 | `view-once.spec.ts` "null WAID → no audit" |
| **Prompt-builder content rule** | 8 | `view-once.spec.ts` prompt-builder block |

---

## Dependencies and prerequisites

- B0 (`Tool` type at `_registry.ts`) — **merged** (PR #12). The `Tool` type is the one we extend.
- Sub-A (`sendOutboundText` opts pattern) — **merged** (PR #11). The `quoted` opt is already there; we add `view_once` alongside it.
- B1 (one-tap polls/reactions) — **merged** (PR #15). `sendOutboundPoll` must remain unaffected; we explicitly do NOT call it from the view-once path.
- B2 (message updates + outbound quoting + reminders) — **in flight at PR #16**. B3a is independent of B2 (different code paths: outbound text opts vs. cancel-tool/edit handler). Plans can run in parallel.

If B2 lands first and changes `sendOutbound`'s signature beyond what's documented here (e.g., adds a fifth opt), this plan's Task 5 may need a small rebase: re-apply the `view_once` opt addition relative to the new field set.

---

## Out of scope (carry to follow-ups)

- B3b: PDF/chart export (separate spec; that work decides whether PDFs use view-once envelope).
- Owner WhatsApp command "Maia, deixa saldo no histórico" to flip `balance_view_once` at runtime.
- Programmatic regex guard against monetary figures in poll-question text. Spec §4.5 explicitly rejected this.
- Forcing view-once on `list_transactions` and other verbose tools. Spec §3 rejects.
