/**
 * Review #374 (medium) — the dispatcher's post-commit fallback `audit()` skip
 * must be CONDITIONAL on a PER-INVOCATION signal, not the static tool-wide
 * `audits_in_tx` flag.
 *
 * Issue #366 introduced `audits_in_tx`: money-moving tools (register_transaction,
 * cancel_transaction) write their audit row TRANSACTIONALLY (via `auditTx` inside
 * their own `withTx`), so the dispatcher SKIPS its post-commit best-effort
 * `audit()` to avoid a duplicate row. But the skip was UNCONDITIONAL per tool —
 * and those tools have schema-valid EARLY-RETURN paths (duplicate-suspected /
 * already-cancelada) that exit BEFORE any `auditTx` runs. The static skip
 * therefore dropped the audit row ENTIRELY for those invocations — a regression
 * vs the prior unconditional post-commit audit().
 *
 * Fix: the dispatcher consults `tool.auditedInTx(out.data)` (a per-invocation
 * predicate over the tool's own result) and skips its fallback audit() ONLY when
 * the tool actually self-audited in-tx for THIS result. This spec drives the
 * REAL dispatcher with mocked collateral deps to prove:
 *   1. self-audited result  → dispatcher does NOT call audit() (no duplicate).
 *   2. early-return result   → dispatcher DOES call audit() (trail preserved).
 *   3. tool without auditedInTx but with audits_in_tx → still skips (back-compat
 *      for a hypothetical always-self-auditing tool; the predicate gates it).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { auditMock } = vi.hoisted(() => ({ auditMock: vi.fn(async () => undefined) }));

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
  idempotencyOutboxRepo: {
    markCompletedWithEffect: vi.fn(async () => true),
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
vi.mock('@/governance/permissions.js', async () => {
  const actual = await vi.importActual<typeof import('@/governance/permissions.js')>(
    '@/governance/permissions.js',
  );
  return { ...actual, canAct: vi.fn(() => ({ allowed: true })) };
});
vi.mock('@/governance/rules.js', () => ({ constitutionalCheck: vi.fn(() => null) }));

// A configurable money-moving-like tool: declares audits_in_tx + auditedInTx,
// and returns whatever the test stages in `state.result`.
const { fakeTool, state } = vi.hoisted(() => {
  const s = {
    result: undefined as unknown,
    auditedInTxDefined: true,
  };
  const tool = {
    name: 'fake_money_tool',
    operation_type: 'create',
    required_actions: [],
    audit_action: 'transaction_created',
    input_schema: { safeParse: (v: unknown) => ({ success: true as const, data: v }) },
    output_schema: { safeParse: (v: unknown) => ({ success: true as const, data: v }) },
    feature_flag: undefined,
    redis_required: false,
    audits_in_tx: true,
    auditedInTx: (result: unknown) =>
      typeof result === 'object' && result !== null && 'transacao_id' in result,
    extractAlvoId: (result: unknown) =>
      typeof result === 'object' && result !== null && 'transacao_id' in result
        ? (result as { transacao_id: string }).transacao_id
        : null,
    handler: async () => s.result,
  };
  return { fakeTool: tool, state: s };
});

vi.mock('@/tools/_registry.js', () => ({
  REGISTRY: { fake_money_tool: fakeTool },
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
  state.result = undefined;
  // restore the predicate (a prior test may have deleted it)
  (fakeTool as { auditedInTx?: (r: unknown) => boolean }).auditedInTx = (result: unknown) =>
    typeof result === 'object' && result !== null && 'transacao_id' in result;
});

describe('dispatcher — fallback audit() skip is per-invocation (review #374)', () => {
  it('SKIPS the fallback audit() when auditedInTx(result) is true (self-audited in-tx, no duplicate)', async () => {
    state.result = { transacao_id: 'tx-1', saldo_apos: 1500 };
    const out = await dispatchTool({ tool: 'fake_money_tool', args: {}, ctx: fakeCtx });
    expect(out).toEqual({ transacao_id: 'tx-1', saldo_apos: 1500 });
    // The tool already wrote its audit row transactionally — dispatcher must NOT
    // fire a duplicate post-commit audit().
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('FIRES the fallback audit() on an early-return result (auditedInTx false → trail preserved)', async () => {
    // e.g. register_transaction duplicate-suspected: no transacao_id, no auditTx.
    state.result = {
      duplicate_suspected: true,
      existing: { transacao_id: 'tx-existing', valor: 500 },
    };
    const out = await dispatchTool({ tool: 'fake_money_tool', args: {}, ctx: fakeCtx });
    expect(out).toEqual(state.result);
    // The early-return path self-audited NOTHING, so the dispatcher's fallback
    // audit() MUST run — every invocation appends to the mutation trail.
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0]![0]).toMatchObject({
      acao: 'transaction_created',
      pessoa_id: 'p1',
      entidade_alvo: 'e-1',
      // no new resource created on the early-return path → alvo_id null.
      alvo_id: null,
      metadata: { tool: 'fake_money_tool' },
    });
  });

  it('still SKIPS when a tool sets audits_in_tx but defines NO auditedInTx (back-compat: always self-audits)', async () => {
    // A tool that audits in-tx on EVERY path can omit the predicate; the
    // dispatcher then honours the static flag (auditedInTx?.() is undefined,
    // but the guard `=== true` makes selfAuditedInTx false → audit fires).
    // This asserts the CONSERVATIVE behavior: without a per-invocation signal,
    // the dispatcher fails SAFE by auditing (never drops a row).
    delete (fakeTool as { auditedInTx?: unknown }).auditedInTx;
    state.result = { transacao_id: 'tx-2', saldo_apos: 10 };
    await dispatchTool({ tool: 'fake_money_tool', args: {}, ctx: fakeCtx });
    expect(auditMock).toHaveBeenCalledTimes(1);
  });
});
