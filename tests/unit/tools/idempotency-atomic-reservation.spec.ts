/**
 * Issue #298 — atomic reservation closes the check-then-act race in
 * src/tools/_dispatcher.ts.
 *
 * Pre-fix flow (broken):
 *   lookup → miss → handler() → store
 * Two concurrent workers can both miss `lookup`, both execute `handler()`
 * (DUPLICATE SIDE EFFECTS), then one stores and the other silently
 * `onConflictDoNothing`s.
 *
 * Post-fix flow:
 *   tryReserve → was_inserted ? handler+markCompleted : (cached | wait)
 * Exactly one caller wins the reservation; losers wait for the winner's
 * completion and return the same result.
 *
 * Test strategy
 * -------------
 * This file is a UNIT test: it mocks `idempotencyRepo` at the consumer-
 * level (the dispatcher) and asserts the dispatcher's new control flow.
 * Specifically:
 *   1. winner path: tryReserve→handler→markCompleted
 *   2. cache-hit path: tryReserve→return cached resultado
 *   3. wait-and-hit path: tryReserve→waitForCompletion→return waited
 *      resultado (NEVER call handler — exact-once contract)
 *   4. wait-and-timeout path: surface `idempotency_wait_timeout` error
 *   5. wait-and-released path: surface `idempotency_owner_failed` error
 *   6. handler-throws path: release reservation + execution_failed
 *   7. cross-tenant: tenant context flows into tryReserve's input
 *
 * The exact-once invariant under TWO concurrent dispatcher calls + real
 * Postgres ON CONFLICT semantics is covered separately by the integration
 * test `tests/integration/issue-298-idempotency-race.spec.ts` — which
 * skips unless TEST_DB_URL is set (matches the pattern from issue-184).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory recorder for the dispatcher's idempotencyRepo calls. The
// recorder lets each test configure the next tryReserve/waitForCompletion
// outcome without touching real DB code.
const { recorder } = vi.hoisted(() => ({
  recorder: {
    tryReserveCalls: [] as Array<unknown>,
    tryReserveResult: { was_inserted: true, state: 'in_progress', resultado: undefined } as {
      was_inserted: boolean;
      state: 'in_progress' | 'completed';
      resultado: unknown;
    },
    waitForCompletionCalls: [] as Array<unknown>,
    waitForCompletionResult: { status: 'completed', resultado: { ok: true } } as
      | { status: 'completed'; resultado: unknown }
      | { status: 'timeout' }
      | { status: 'released' },
    markCompletedCalls: [] as Array<{ key: string; resultado: unknown }>,
    releaseReservationCalls: [] as Array<string>,
    handlerCalls: 0,
    handlerImpl: (async () => ({ ok: true })) as (
      args: unknown,
      ctx: unknown,
    ) => Promise<unknown>,
  },
}));

vi.mock('@/db/repositories.js', () => ({
  idempotencyRepo: {
    tryReserve: vi.fn(async (input: unknown) => {
      recorder.tryReserveCalls.push(input);
      return recorder.tryReserveResult;
    }),
    waitForCompletion: vi.fn(async (key: string, timeout: number) => {
      recorder.waitForCompletionCalls.push({ key, timeout });
      return recorder.waitForCompletionResult;
    }),
    markCompleted: vi.fn(async (input: { key: string; resultado: unknown }) => {
      recorder.markCompletedCalls.push(input);
    }),
    releaseReservation: vi.fn(async (key: string) => {
      recorder.releaseReservationCalls.push(key);
    }),
    // Legacy paths kept for backward compat; dispatcher should NOT touch
    // them in the post-#298 flow.
    lookup: vi.fn(async () => null),
    store: vi.fn(async () => undefined),
    cleanup: vi.fn(async () => 0),
  },
}));

// Stub the dispatcher's collateral deps so the test focuses on the
// reservation flow.
vi.mock('@/governance/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/redis.js', () => ({ isRedisConnected: vi.fn(() => true) }));
vi.mock('@/lib/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('@/governance/idempotency.js', () => ({
  computeIdempotencyKey: vi.fn(() => 'computed-key-1'),
}));
vi.mock('@/governance/permissions.js', async () => {
  const actual = await vi.importActual<typeof import('@/governance/permissions.js')>(
    '@/governance/permissions.js',
  );
  return {
    ...actual,
    canAct: vi.fn(() => ({ allowed: true })),
  };
});
vi.mock('@/governance/rules.js', () => ({
  constitutionalCheck: vi.fn(() => null),
}));

// Mock the registry: one tool that records each invocation and returns
// the configured result. We avoid importing a real tool to keep the
// dispatcher test self-contained.
//
// `vi.hoisted` is required because vi.mock factories run BEFORE module-
// top-level code, so a bare `const fakeTool = ...` would not exist yet
// when the factory closes over it. Hoisting moves the binding above the
// mock factory so the registry can reference it.
const { fakeTool, registryMockState } = vi.hoisted(() => {
  const handler = (async (args: unknown, ctx: unknown) => undefined) as (
    args: unknown,
    ctx: unknown,
  ) => Promise<unknown>;
  const state = {
    outputSafeParse: ((v: unknown) => ({ success: true as const, data: v })) as (
      v: unknown,
    ) => { success: true; data: unknown } | { success: false; error: { issues: unknown[] } },
  };
  const tool = {
    name: 'fake_tool',
    operation_type: 'create',
    required_actions: [],
    audit_action: 'fake_action',
    input_schema: {
      safeParse: (v: unknown) => ({ success: true as const, data: v }),
    },
    output_schema: {
      safeParse: (v: unknown) => state.outputSafeParse(v),
    },
    feature_flag: undefined,
    redis_required: false,
    handler,
  };
  return { fakeTool: tool, registryMockState: state };
});

vi.mock('@/tools/_registry.js', () => ({
  REGISTRY: { fake_tool: fakeTool },
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
  recorder.tryReserveCalls = [];
  recorder.waitForCompletionCalls = [];
  recorder.markCompletedCalls = [];
  recorder.releaseReservationCalls = [];
  recorder.handlerCalls = 0;
  recorder.tryReserveResult = {
    was_inserted: true,
    state: 'in_progress',
    resultado: undefined,
  };
  recorder.waitForCompletionResult = {
    status: 'completed',
    resultado: { ok: true },
  };
  recorder.handlerImpl = async () => ({ ok: true, from: 'handler' });
  // Re-wire handler to call into the configurable recorder.
  fakeTool.handler = async (args: unknown, ctx: unknown) => {
    recorder.handlerCalls += 1;
    return recorder.handlerImpl(args, ctx);
  };
  registryMockState.outputSafeParse = (v: unknown) => ({ success: true, data: v });
});

describe('dispatcher — winner path: tryReserve → handler → markCompleted', () => {
  it('executes handler and marks completed when was_inserted=true', async () => {
    recorder.tryReserveResult = {
      was_inserted: true,
      state: 'in_progress',
      resultado: undefined,
    };
    const result = await dispatchTool({
      tool: 'fake_tool',
      args: {},
      ctx: fakeCtx,
    });
    expect(recorder.handlerCalls).toBe(1);
    expect(recorder.markCompletedCalls).toHaveLength(1);
    expect(recorder.markCompletedCalls[0]).toEqual({
      key: 'computed-key-1',
      resultado: { ok: true, from: 'handler' },
    });
    expect(result).toEqual({ ok: true, from: 'handler' });
  });

  it('passes ttl_seconds when calling tryReserve', async () => {
    await dispatchTool({ tool: 'fake_tool', args: {}, ctx: fakeCtx });
    expect(recorder.tryReserveCalls).toHaveLength(1);
    const first = recorder.tryReserveCalls[0] as { ttl_seconds?: number };
    expect(first.ttl_seconds).toBeGreaterThan(0);
  });
});

describe('dispatcher — cache-hit path: tryReserve returns completed', () => {
  it('returns cached resultado and skips handler entirely', async () => {
    recorder.tryReserveResult = {
      was_inserted: false,
      state: 'completed',
      resultado: { cached: 'from_a_prior_dispatch' },
    };
    const result = await dispatchTool({
      tool: 'fake_tool',
      args: {},
      ctx: fakeCtx,
    });
    expect(recorder.handlerCalls).toBe(0);
    expect(recorder.markCompletedCalls).toHaveLength(0);
    expect(result).toEqual({ cached: 'from_a_prior_dispatch' });
  });
});

describe('dispatcher — wait path: tryReserve says someone else owns it', () => {
  it('waits for the owner and returns their result (NEVER calls handler)', async () => {
    // The crux of #298: the LOSER of a concurrent race MUST NOT execute
    // the handler. It must wait for the winner and return the winner's
    // result. Otherwise side effects double-fire.
    recorder.tryReserveResult = {
      was_inserted: false,
      state: 'in_progress',
      resultado: undefined,
    };
    recorder.waitForCompletionResult = {
      status: 'completed',
      resultado: { ok: true, from: 'owner' },
    };
    const result = await dispatchTool({
      tool: 'fake_tool',
      args: {},
      ctx: fakeCtx,
    });
    expect(recorder.handlerCalls).toBe(0); // CRITICAL invariant
    expect(recorder.waitForCompletionCalls).toHaveLength(1);
    expect(result).toEqual({ ok: true, from: 'owner' });
  });

  it('returns idempotency_wait_timeout when poll deadline expires', async () => {
    recorder.tryReserveResult = {
      was_inserted: false,
      state: 'in_progress',
      resultado: undefined,
    };
    recorder.waitForCompletionResult = { status: 'timeout' };
    const result = (await dispatchTool({
      tool: 'fake_tool',
      args: {},
      ctx: fakeCtx,
    })) as { error?: string };
    expect(recorder.handlerCalls).toBe(0);
    expect(result.error).toBe('idempotency_wait_timeout');
  });

  it('returns idempotency_owner_failed when owner released its reservation', async () => {
    // Owner's handler threw → released the row. The waiter sees
    // status='released' and must surface a typed error rather than
    // re-execute (a higher-level retry policy will re-dispatch).
    recorder.tryReserveResult = {
      was_inserted: false,
      state: 'in_progress',
      resultado: undefined,
    };
    recorder.waitForCompletionResult = { status: 'released' };
    const result = (await dispatchTool({
      tool: 'fake_tool',
      args: {},
      ctx: fakeCtx,
    })) as { error?: string };
    expect(recorder.handlerCalls).toBe(0);
    expect(result.error).toBe('idempotency_owner_failed');
  });
});

describe('dispatcher — handler-throws path: release reservation', () => {
  it('releases reservation when handler throws (next caller can retry)', async () => {
    recorder.tryReserveResult = {
      was_inserted: true,
      state: 'in_progress',
      resultado: undefined,
    };
    recorder.handlerImpl = async () => {
      throw new Error('simulated handler failure');
    };
    const result = (await dispatchTool({
      tool: 'fake_tool',
      args: {},
      ctx: fakeCtx,
    })) as { error?: string };
    expect(recorder.handlerCalls).toBe(1);
    expect(recorder.releaseReservationCalls).toEqual(['computed-key-1']);
    expect(recorder.markCompletedCalls).toHaveLength(0);
    expect(result.error).toBe('execution_failed');
  });

  it('releases reservation on output schema violation', async () => {
    recorder.tryReserveResult = {
      was_inserted: true,
      state: 'in_progress',
      resultado: undefined,
    };
    // Force the output schema to reject.
    registryMockState.outputSafeParse = () => ({
      success: false,
      error: { issues: [{ path: ['x'], message: 'bad' }] },
    });
    const result = (await dispatchTool({
      tool: 'fake_tool',
      args: {},
      ctx: fakeCtx,
    })) as { error?: string; details?: { cause?: string } };
    expect(recorder.releaseReservationCalls).toEqual(['computed-key-1']);
    expect(result.error).toBe('execution_failed');
    expect(result.details?.cause).toBe('output_schema_violation');
  });
});

describe('dispatcher — tryReserve input shape', () => {
  it('passes pessoa_id + entity_id + idempotency_key to the reservation', async () => {
    await dispatchTool({
      tool: 'fake_tool',
      args: {},
      ctx: fakeCtx,
    });
    expect(recorder.tryReserveCalls).toHaveLength(1);
    const call = recorder.tryReserveCalls[0] as {
      key: string;
      pessoa_id: string;
      entity_id: string;
      tool_name: string;
      operation_type: string;
    };
    expect(call.key).toBe('computed-key-1');
    expect(call.pessoa_id).toBe('p1');
    expect(call.entity_id).toBe('e-1');
    expect(call.tool_name).toBe('fake_tool');
    expect(call.operation_type).toBe('create');
  });
});
