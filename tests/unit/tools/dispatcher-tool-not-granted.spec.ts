/**
 * Issue #408 — the dispatcher `tool_not_granted` guard (the HARD server-side
 * defense, invariant #5 fail-closed).
 *
 * Proves, by driving the REAL dispatcher with mocked collateral deps:
 *   1. a tool NOT in the agent's effective grant is REFUSED (`tool_not_granted`)
 *      BEFORE the handler runs — even if the LLM "leaked" it past the filter.
 *   2. a `denied_tools` entry is REFUSED even when it is ALSO in a granted pack
 *      (deny is HARD).
 *   3. a GRANTED tool passes the guard and the handler runs.
 *   4. a baseline tool is dispatchable even with an EMPTY persisted grant
 *      (no grant row → fail-closed to the baseline floor, never to zero).
 *   5. the refusal emits a `tool_not_granted` audit row (provenance).
 *
 * The guard runs BEFORE the permission/`canAct` guard — so this is the agent
 * grant axis, distinct from the human-permission `unauthorized_access_attempt`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { auditMock } = vi.hoisted(() => ({ auditMock: vi.fn(async () => undefined) }));

// Configurable grant the mocked repo returns per test.
const { grantState } = vi.hoisted(() => ({
  grantState: {
    grant: { granted_packs: [] as string[], granted_tools: [] as string[], denied_tools: [] as string[] },
  },
}));

vi.mock('@/db/repositories.js', () => ({
  idempotencyRepo: {
    tryReserve: vi.fn(async () => ({
      was_inserted: true,
      state: 'in_progress',
      resultado: undefined,
      reservation_token: 'token-1',
    })),
    waitForCompletion: vi.fn(),
    markCompleted: vi.fn(async () => true),
    releaseReservation: vi.fn(async () => true),
    lookup: vi.fn(async () => null),
    store: vi.fn(async () => undefined),
    cleanup: vi.fn(async () => 0),
  },
  idempotencyOutboxRepo: { markCompletedWithEffect: vi.fn(async () => true) },
  agentToolGrantsRepo: {
    findForCurrentAgent: vi.fn(async () => grantState.grant),
  },
}));

vi.mock('@/governance/audit.js', () => ({ audit: auditMock }));
vi.mock('@/lib/redis.js', () => ({ isRedisConnected: vi.fn(() => true) }));
vi.mock('@/lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/governance/idempotency.js', () => ({
  computeIdempotencyKey: vi.fn(() => 'computed-key-1'),
  computePayloadHash: vi.fn(() => 'payload-hash-1'),
}));
// canAct always allows so we isolate the GRANT guard (the human-permission
// axis is a separate guard; here we prove the AGENT axis).
vi.mock('@/governance/permissions.js', async () => {
  const actual = await vi.importActual<typeof import('@/governance/permissions.js')>(
    '@/governance/permissions.js',
  );
  return { ...actual, canAct: vi.fn(() => ({ allowed: true })) };
});
vi.mock('@/governance/rules.js', () => ({ constitutionalCheck: vi.fn(() => null) }));

// A handler spy so we can assert the handler NEVER runs on a refusal.
const { handlerSpy } = vi.hoisted(() => ({ handlerSpy: vi.fn(async () => ({ ok: true })) }));

function fakeTool(name: string) {
  return {
    name,
    operation_type: 'read',
    required_actions: [],
    audit_action: 'balance_queried',
    input_schema: { safeParse: (v: unknown) => ({ success: true as const, data: v }) },
    output_schema: { safeParse: (v: unknown) => ({ success: true as const, data: v }) },
    feature_flag: undefined,
    redis_required: false,
    handler: handlerSpy,
  };
}

// REGISTRY contains a baseline tool, a finance tool, and an ungranted tool — all
// EXIST (so the guard, not 'unknown_tool', is what refuses the ungranted one).
vi.mock('@/tools/_registry.js', () => ({
  REGISTRY: {
    audit_decision: fakeTool('audit_decision'), // baseline
    query_balance: fakeTool('query_balance'), // finance
    register_transaction: fakeTool('register_transaction'), // finance
    cancel_transaction: fakeTool('cancel_transaction'), // finance
  },
  isToolEnabled: () => true,
}));

import { dispatchTool } from '@/tools/_dispatcher.js';
import type { Pessoa, Conversa } from '@/db/schema.js';

const fakeCtx = {
  pessoa: { id: 'p1' } as unknown as Pessoa,
  scope: { entidades: ['e-1'], byEntity: new Map() },
  conversa: { id: 'c1' } as unknown as Conversa,
  mensagem_id: 'm1',
  request_id: 'r1',
};

beforeEach(() => {
  vi.clearAllMocks();
  grantState.grant = { granted_packs: [], granted_tools: [], denied_tools: [] };
});

describe('dispatcher — tool_not_granted guard (#408, HARD fail-closed)', () => {
  it('(1) refuses a tool NOT in the agent grant BEFORE the handler runs', async () => {
    // Agent has only baseline.core → query_balance (finance) is not granted.
    grantState.grant = { granted_packs: ['baseline.core'], granted_tools: [], denied_tools: [] };
    const out = await dispatchTool({ tool: 'query_balance', args: {}, ctx: fakeCtx });
    expect(out).toEqual({ error: 'tool_not_granted', details: { tool: 'query_balance' } });
    expect(handlerSpy).not.toHaveBeenCalled();
  });

  it('(2) refuses a DENIED tool even when its pack is granted (deny is HARD)', async () => {
    grantState.grant = {
      granted_packs: ['baseline.core', 'domain.finance'],
      granted_tools: [],
      denied_tools: ['cancel_transaction'],
    };
    const out = await dispatchTool({ tool: 'cancel_transaction', args: {}, ctx: fakeCtx });
    expect(out).toEqual({ error: 'tool_not_granted', details: { tool: 'cancel_transaction' } });
    expect(handlerSpy).not.toHaveBeenCalled();
    // A non-denied finance tool from the same pack still dispatches.
    const ok = await dispatchTool({ tool: 'register_transaction', args: {}, ctx: fakeCtx });
    expect(ok).toEqual({ ok: true });
    expect(handlerSpy).toHaveBeenCalledTimes(1);
  });

  it('(3) a GRANTED tool passes the guard and the handler runs', async () => {
    grantState.grant = {
      granted_packs: ['baseline.core', 'domain.finance'],
      granted_tools: [],
      denied_tools: [],
    };
    const out = await dispatchTool({ tool: 'query_balance', args: {}, ctx: fakeCtx });
    expect(out).toEqual({ ok: true });
    expect(handlerSpy).toHaveBeenCalledTimes(1);
  });

  it('(4) a baseline tool dispatches even with an EMPTY persisted grant (fail-closed to baseline)', async () => {
    grantState.grant = { granted_packs: [], granted_tools: [], denied_tools: [] };
    const out = await dispatchTool({ tool: 'audit_decision', args: {}, ctx: fakeCtx });
    expect(out).toEqual({ ok: true });
    expect(handlerSpy).toHaveBeenCalledTimes(1);
  });

  it('(5) the refusal emits a tool_not_granted audit row with provenance', async () => {
    grantState.grant = { granted_packs: ['baseline.core'], granted_tools: [], denied_tools: ['x'] };
    await dispatchTool({ tool: 'register_transaction', args: {}, ctx: fakeCtx });
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0]![0]).toMatchObject({
      acao: 'tool_not_granted',
      pessoa_id: 'p1',
      conversa_id: 'c1',
      mensagem_id: 'm1',
      metadata: { tool: 'register_transaction', granted_packs: ['baseline.core'] },
    });
  });
});
