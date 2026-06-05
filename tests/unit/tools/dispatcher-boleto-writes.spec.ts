/**
 * Issue #416 — the boleto WRITE tools flow through the EXISTING dispatcher guard
 * (no parallel write path). Proves, by driving the REAL dispatcher + the REAL
 * grant math (`resolveGrantedToolNames`) with mocked collateral deps:
 *
 *   1. a write tool is REFUSED (`tool_not_granted`) when the write pack is NOT
 *      granted — fail-closed (invariant #5), the handler never runs.
 *   2. granting `boleto_proposal_write_pack` makes boleto_cancel /
 *      company_campaign_remove dispatchable through the SAME guard chain
 *      (tool_not_granted → constitutionalCheck → canAct → idempotency → audit).
 *   3. granting `refund_intake_pack` makes refund_create dispatchable.
 *   4. `constitutionalCheck` is consulted for the write (compose, don't bypass):
 *      a forbidden violation short-circuits the dispatch.
 *
 * We mock `@/tools/_registry.js` with fake write tools (so we don't boot the
 * gateway), but use the REAL `grant-math.ts` so the pack→tool mapping is
 * exercised end-to-end.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { auditMock } = vi.hoisted(() => ({ auditMock: vi.fn(async () => undefined) }));
const { grantState } = vi.hoisted(() => ({
  grantState: {
    grant: { granted_packs: [] as string[], granted_tools: [] as string[], denied_tools: [] as string[] },
  },
}));
const { constitutionalMock } = vi.hoisted(() => ({ constitutionalMock: vi.fn(() => null) }));
const { handlerSpy } = vi.hoisted(() => ({ handlerSpy: vi.fn(async () => ({ ok: true })) }));

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
  computeIdempotencyKey: vi.fn(() => 'k1'),
  computePayloadHash: vi.fn(() => 'h1'),
}));
vi.mock('@/governance/permissions.js', async () => {
  const actual = await vi.importActual<typeof import('@/governance/permissions.js')>(
    '@/governance/permissions.js',
  );
  return { ...actual, canAct: vi.fn(() => ({ allowed: true })) };
});
vi.mock('@/governance/rules.js', () => ({ constitutionalCheck: constitutionalMock }));

function fakeWriteTool(name: string, audit_action: string) {
  return {
    name,
    operation_type: 'cancel',
    required_actions: [],
    audit_action,
    side_effect: 'write',
    input_schema: { safeParse: (v: unknown) => ({ success: true as const, data: v }) },
    output_schema: { safeParse: (v: unknown) => ({ success: true as const, data: v }) },
    feature_flag: undefined,
    redis_required: false,
    handler: handlerSpy,
  };
}

vi.mock('@/tools/_registry.js', () => ({
  REGISTRY: {
    boleto_cancel: fakeWriteTool('boleto_cancel', 'boleto_cancelled'),
    company_campaign_remove: fakeWriteTool('company_campaign_remove', 'company_campaign_removed'),
    refund_create: fakeWriteTool('refund_create', 'refund_created'),
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
  constitutionalMock.mockReturnValue(null);
});

describe('dispatcher — boleto write tools compose with the guard (issue #416)', () => {
  it('(1) refuses boleto_cancel when the write pack is NOT granted (fail-closed)', async () => {
    grantState.grant = { granted_packs: ['baseline.core'], granted_tools: [], denied_tools: [] };
    const out = await dispatchTool({ tool: 'boleto_cancel', args: { boleto_id: 'b1' }, ctx: fakeCtx });
    expect(out).toEqual({ error: 'tool_not_granted', details: { tool: 'boleto_cancel' } });
    expect(handlerSpy).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ acao: 'tool_not_granted', metadata: expect.objectContaining({ tool: 'boleto_cancel' }) }),
    );
  });

  it('(2) granting boleto_proposal_write_pack makes the two write tools dispatchable', async () => {
    grantState.grant = {
      granted_packs: ['baseline.core', 'boleto_proposal_write_pack'],
      granted_tools: [],
      denied_tools: [],
    };
    const a = await dispatchTool({ tool: 'boleto_cancel', args: { boleto_id: 'b1' }, ctx: fakeCtx });
    expect(a).toEqual({ ok: true });
    const b = await dispatchTool({ tool: 'company_campaign_remove', args: {}, ctx: fakeCtx });
    expect(b).toEqual({ ok: true });
    expect(handlerSpy).toHaveBeenCalledTimes(2);
    // refund_create is NOT in the write pack → still refused.
    handlerSpy.mockClear();
    const c = await dispatchTool({ tool: 'refund_create', args: {}, ctx: fakeCtx });
    expect(c).toEqual({ error: 'tool_not_granted', details: { tool: 'refund_create' } });
    expect(handlerSpy).not.toHaveBeenCalled();
  });

  it('(3) granting refund_intake_pack makes refund_create dispatchable', async () => {
    grantState.grant = {
      granted_packs: ['baseline.core', 'refund_intake_pack'],
      granted_tools: [],
      denied_tools: [],
    };
    const out = await dispatchTool({ tool: 'refund_create', args: {}, ctx: fakeCtx });
    expect(out).toEqual({ ok: true });
    expect(handlerSpy).toHaveBeenCalledTimes(1);
  });

  it('(4) constitutionalCheck is consulted for the write (compose, don\'t bypass)', async () => {
    grantState.grant = {
      granted_packs: ['baseline.core', 'boleto_proposal_write_pack'],
      granted_tools: [],
      denied_tools: [],
    };
    constitutionalMock.mockReturnValueOnce({ kind: 'forbidden', rule_id: 'r', reason: 'blocked' });
    const out = await dispatchTool({ tool: 'boleto_cancel', args: { boleto_id: 'b1' }, ctx: fakeCtx });
    expect(constitutionalMock).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ error: 'forbidden' });
    expect(handlerSpy).not.toHaveBeenCalled();
  });
});
