/**
 * Issue #509 — end-to-end contract at the DISPATCH boundary.
 *
 * Covers the issue's "Integração / com provider fake" list by driving the REAL
 * dispatcher with args shaped exactly like what a provider hands back:
 *
 *   - correct args execute the handler once;
 *   - a missing required field returns a CONTROLLED error, handler never runs;
 *   - an extra field never reaches the handler;
 *   - an invalid enum is rejected;
 *   - malformed JSON (the `{_raw}` shape `fromOpenAIResponse` produces on a
 *     parse failure — src/lib/claude.ts) never reaches the handler;
 *   - a tool outside the agent grant stays unavailable no matter how rich its
 *     schema is.
 *
 * The point: a better schema improves GENERATION. It changes NOTHING about
 * enforcement — Zod and the grant guard decide, exactly as before.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { auditMock } = vi.hoisted(() => ({ auditMock: vi.fn(async () => undefined) }));
const { grantState } = vi.hoisted(() => ({
  grantState: {
    grant: {
      granted_packs: ['baseline.core', 'domain.finance'] as string[],
      granted_tools: [] as string[],
      denied_tools: [] as string[],
    },
  },
}));
const { handlerSpy } = vi.hoisted(() => ({
  handlerSpy: vi.fn(async () => ({ transacao_id: 'tx-1' })),
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
  agentToolGrantsRepo: { findForCurrentAgent: vi.fn(async () => grantState.grant) },
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
vi.mock('@/governance/permissions.js', async () => {
  const actual = await vi.importActual<typeof import('@/governance/permissions.js')>(
    '@/governance/permissions.js',
  );
  return { ...actual, canAct: vi.fn(() => ({ allowed: true })) };
});
vi.mock('@/governance/rules.js', () => ({ constitutionalCheck: vi.fn(() => null) }));

// The registry mock builds a REAL Zod contract (the same shape as
// `register_transaction`'s) inside the factory — the factory is hoisted above
// module scope, so it cannot close over a module-level `const`. The
// dispatcher's `safeParse` then runs against a genuine Zod schema, unmocked.
vi.mock('@/tools/_registry.js', async () => {
  const { z: zod } = await import('zod');
  // Same SHAPE features as register_transaction (uuid / enum / bounded number /
  // bounded string / default), but no `valor` key: the financial-authorization
  // PEP keys off `valor`, and this spec isolates the SCHEMA boundary. The
  // financial gates have their own suites.
  const realInputSchema = zod.object({
    entidade_id: zod.string().uuid(),
    natureza: zod.enum(['receita', 'despesa', 'movimentacao']),
    quantidade: zod.number().positive(),
    descricao: zod.string().min(1).max(280),
    origem: zod.enum(['whatsapp', 'manual']).default('whatsapp'),
  });
  const tool = (name: string, audit_action: string) => ({
    name,
    description: name,
    operation_type: 'read',
    required_actions: [],
    audit_action,
    input_schema: realInputSchema,
    output_schema: { safeParse: (v: unknown) => ({ success: true as const, data: v }) },
    feature_flag: undefined,
    redis_required: false,
    handler: handlerSpy,
  });
  return {
    REGISTRY: {
      register_transaction: tool('register_transaction', 'transaction_created'),
      // Exists in the registry but is NOT in any granted pack for this agent.
      boleto_cancel: tool('boleto_cancel', 'transaction_cancelled'),
    },
    isToolEnabled: () => true,
  };
});

import { dispatchTool } from '@/tools/_dispatcher.js';
import type { Pessoa, Conversa } from '@/db/schema.js';

const UUID = '11111111-2222-4333-8444-555555555555';

const fakeCtx = {
  pessoa: { id: 'p1' } as unknown as Pessoa,
  scope: { entidades: [UUID], byEntity: new Map() },
  conversa: { id: 'c1' } as unknown as Conversa,
  mensagem_id: 'm1',
  request_id: 'r1',
};

const VALID = {
  entidade_id: UUID,
  natureza: 'despesa',
  quantidade: 10,
  descricao: 'almoço',
};

beforeEach(() => {
  vi.clearAllMocks();
  grantState.grant = {
    granted_packs: ['baseline.core', 'domain.finance'],
    granted_tools: [],
    denied_tools: [],
  };
});

describe('#509 dispatch contract — Zod stays the authority', () => {
  it('correct args execute the handler exactly once', async () => {
    const out = await dispatchTool({ tool: 'register_transaction', args: VALID, ctx: fakeCtx });
    expect(out).toEqual({ transacao_id: 'tx-1' });
    expect(handlerSpy).toHaveBeenCalledTimes(1);
  });

  it('a missing required field returns a controlled invalid_args, handler never runs', async () => {
    const { descricao: _drop, ...missing } = VALID;
    const out = await dispatchTool({ tool: 'register_transaction', args: missing, ctx: fakeCtx });
    expect(out).toMatchObject({ error: 'invalid_args' });
    expect(handlerSpy).not.toHaveBeenCalled();
  });

  it('an invalid enum is rejected', async () => {
    const out = await dispatchTool({
      tool: 'register_transaction',
      args: { ...VALID, natureza: 'transferencia' },
      ctx: fakeCtx,
    });
    expect(out).toMatchObject({ error: 'invalid_args' });
    expect(handlerSpy).not.toHaveBeenCalled();
  });

  it('a bound violation is rejected', async () => {
    const out = await dispatchTool({
      tool: 'register_transaction',
      args: { ...VALID, quantidade: 0 },
      ctx: fakeCtx,
    });
    expect(out).toMatchObject({ error: 'invalid_args' });
    expect(handlerSpy).not.toHaveBeenCalled();
  });

  it('an extra field never reaches the handler (Zod strips it)', async () => {
    await dispatchTool({
      tool: 'register_transaction',
      args: { ...VALID, hacked: true, dual_approval_granted: true },
      ctx: fakeCtx,
    });
    expect(handlerSpy).toHaveBeenCalledTimes(1);
    const forwarded = handlerSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.hasOwn(forwarded, 'hacked')).toBe(false);
    expect(Object.hasOwn(forwarded, 'dual_approval_granted')).toBe(false);
    // The schema default IS applied by Zod, so the handler sees the full contract.
    expect(forwarded.origem).toBe('whatsapp');
  });

  it('malformed provider JSON ({_raw}) never reaches the handler', async () => {
    // `fromOpenAIResponse` yields `{ _raw: '<unparseable>' }` when the provider
    // returns broken arguments (src/lib/claude.ts).
    const out = await dispatchTool({
      tool: 'register_transaction',
      args: { _raw: '{"valor": ' },
      ctx: fakeCtx,
    });
    expect(out).toMatchObject({ error: 'invalid_args' });
    expect(handlerSpy).not.toHaveBeenCalled();
  });

  it('a tool outside the agent grant stays unavailable, however rich its schema', async () => {
    const out = await dispatchTool({ tool: 'boleto_cancel', args: VALID, ctx: fakeCtx });
    expect(out).toEqual({ error: 'tool_not_granted', details: { tool: 'boleto_cancel' } });
    expect(handlerSpy).not.toHaveBeenCalled();
  });
});
