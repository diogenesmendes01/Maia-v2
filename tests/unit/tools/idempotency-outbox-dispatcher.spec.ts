/**
 * Issue #316 — dispatcher integration with the transactional effect outbox.
 *
 * Proves the dispatcher's winner path routes a tool with an external effect
 * (extractEffect returns non-null) through `idempotencyOutboxRepo
 * .markCompletedWithEffect` (atomic completion + enqueue) INSTEAD of plain
 * `idempotencyRepo.markCompleted`, and:
 *   1. winner: completes+enqueues, returns the result.
 *   2. fenced winner (markCompletedWithEffect returns false): surfaces
 *      `idempotency_completion_fenced` and NO result — same contract as the
 *      plain path (#298 B2), so a preempted owner that already fenced never
 *      enqueues an effect AND never returns a divergent result.
 *   3. a tool WITHOUT extractEffect (or whose result plans no effect) takes the
 *      plain markCompleted path — the outbox is not touched (no regression).
 *
 * The exactly-once-under-fence invariant on the WRITE side itself (rollback →
 * no enqueue) is proven in tests/unit/db/idempotency-outbox-repo.spec.ts; here
 * we prove the dispatcher WIRES that path for external-effect tools.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { recorder } = vi.hoisted(() => ({
  recorder: {
    markCompletedCalls: [] as Array<{ key: string; resultado: unknown; reservation_token: string }>,
    markCompletedWithEffectCalls: [] as Array<{
      key: string;
      resultado: unknown;
      reservation_token: string;
      effect: unknown;
    }>,
    markCompletedResult: true,
    markCompletedWithEffectResult: true,
    handlerResult: { mensagem_id: 'm1', whatsapp_id: null, jid: 'jid@x', texto: 'hi' } as unknown,
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
    waitForCompletion: vi.fn(async () => ({ status: 'completed', resultado: {} })),
    markCompleted: vi.fn(
      async (input: { key: string; resultado: unknown; reservation_token: string }) => {
        recorder.markCompletedCalls.push(input);
        return recorder.markCompletedResult;
      },
    ),
    releaseReservation: vi.fn(async () => true),
    lookup: vi.fn(async () => null),
    store: vi.fn(async () => undefined),
    cleanup: vi.fn(async () => 0),
  },
  idempotencyOutboxRepo: {
    markCompletedWithEffect: vi.fn(
      async (input: {
        key: string;
        resultado: unknown;
        reservation_token: string;
        effect: unknown;
      }) => {
        recorder.markCompletedWithEffectCalls.push(input);
        return recorder.markCompletedWithEffectResult;
      },
    ),
  },
  // Issue #408 — the dispatcher's `tool_not_granted` guard resolves the agent
  // grant. Grant the synthetic test tools so the guard passes and these tests
  // exercise the outbox-wiring flow they target.
  agentToolGrantsRepo: {
    findForCurrentAgent: vi.fn(async () => ({
      granted_packs: [],
      granted_tools: ['effect_tool', 'plain_tool'],
      denied_tools: [],
    })),
  },
}));

vi.mock('@/governance/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/redis.js', () => ({ isRedisConnected: vi.fn(() => true) }));
vi.mock('@/lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/governance/idempotency.js', () => ({
  computeIdempotencyKey: vi.fn(() => 'computed-key-1'),
  computePayloadHash: vi.fn(() => 'payload-hash-1'),
}));
vi.mock('@/governance/permissions.js', async () => {
  const actual = await vi.importActual<typeof import('@/governance/permissions.js')>(
    '@/governance/permissions.js',
  );
  return { ...actual, canAct: vi.fn(() => ({ allowed: true })) };
});
vi.mock('@/governance/rules.js', () => ({ constitutionalCheck: vi.fn(() => null) }));

const { effectTool, plainTool, toolState } = vi.hoisted(() => {
  const toolState = {
    effectReturn: {
      kind: 'whatsapp_text',
      jid: 'jid@x',
      text: 'hi',
      mensagem_id: 'm1',
    } as unknown,
  };
  const mkTool = (name: string, withEffect: boolean) => ({
    name,
    operation_type: withEffect ? 'communicate' : 'create',
    // #507 — o dispatcher consulta a classe de efeito para decidir o que dizer
    // sobre um cancelamento tardio. A tool sintética declara a sua como
    // qualquer tool real declara; o registro real recusa quem não declara.
    side_effect: withEffect ? 'communication' : 'write',
    effect_class: 'non_interruptible',
    required_actions: [],
    audit_action: 'fake_action',
    input_schema: { safeParse: (v: unknown) => ({ success: true as const, data: v }) },
    output_schema: { safeParse: (v: unknown) => ({ success: true as const, data: v }) },
    feature_flag: undefined,
    redis_required: false,
    handler: async () => recorder.handlerResult,
    ...(withEffect ? { extractEffect: () => toolState.effectReturn } : {}),
  });
  return {
    effectTool: mkTool('effect_tool', true),
    plainTool: mkTool('plain_tool', false),
    toolState,
  };
});

vi.mock('@/tools/_registry.js', () => ({
  REGISTRY: { effect_tool: effectTool, plain_tool: plainTool },
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
  recorder.markCompletedCalls = [];
  recorder.markCompletedWithEffectCalls = [];
  recorder.markCompletedResult = true;
  recorder.markCompletedWithEffectResult = true;
  recorder.handlerResult = { mensagem_id: 'm1', whatsapp_id: null, jid: 'jid@x', texto: 'hi' };
  toolState.effectReturn = { kind: 'whatsapp_text', jid: 'jid@x', text: 'hi', mensagem_id: 'm1' };
});

describe('dispatcher #316 — external-effect tool routes through markCompletedWithEffect', () => {
  it('winner: completes + enqueues the planned effect atomically, returns the result', async () => {
    const result = await dispatchTool({ tool: 'effect_tool', args: {}, ctx: fakeCtx });
    // Routed through the atomic outbox path, NOT plain markCompleted.
    expect(recorder.markCompletedWithEffectCalls).toHaveLength(1);
    expect(recorder.markCompletedCalls).toHaveLength(0);
    expect(recorder.markCompletedWithEffectCalls[0]).toMatchObject({
      key: 'computed-key-1',
      reservation_token: 'token-1',
      effect: { kind: 'whatsapp_text', jid: 'jid@x', text: 'hi', mensagem_id: 'm1' },
    });
    expect(result).toEqual({ mensagem_id: 'm1', whatsapp_id: null, jid: 'jid@x', texto: 'hi' });
  });

  it('fenced winner: markCompletedWithEffect returns false → idempotency_completion_fenced, no result', async () => {
    recorder.markCompletedWithEffectResult = false;
    const result = (await dispatchTool({ tool: 'effect_tool', args: {}, ctx: fakeCtx })) as {
      error?: string;
    };
    expect(recorder.markCompletedWithEffectCalls).toHaveLength(1);
    expect(result.error).toBe('idempotency_completion_fenced');
  });

  it('no-effect result: extractEffect returns null → plain markCompleted, outbox untouched', async () => {
    // Tool HAS extractEffect but the result plans no effect this time.
    toolState.effectReturn = null;
    const result = await dispatchTool({ tool: 'effect_tool', args: {}, ctx: fakeCtx });
    expect(recorder.markCompletedWithEffectCalls).toHaveLength(0);
    expect(recorder.markCompletedCalls).toHaveLength(1);
    expect(result).toEqual({ mensagem_id: 'm1', whatsapp_id: null, jid: 'jid@x', texto: 'hi' });
  });

  it('tool WITHOUT extractEffect: always plain markCompleted (no regression)', async () => {
    const result = await dispatchTool({ tool: 'plain_tool', args: {}, ctx: fakeCtx });
    expect(recorder.markCompletedWithEffectCalls).toHaveLength(0);
    expect(recorder.markCompletedCalls).toHaveLength(1);
    expect(result).toEqual({ mensagem_id: 'm1', whatsapp_id: null, jid: 'jid@x', texto: 'hi' });
  });
});
