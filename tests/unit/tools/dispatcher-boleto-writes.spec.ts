/**
 * Issue #416 — the boleto WRITE tools flow through the EXISTING dispatcher guard
 * (no parallel write path). Drives the REAL dispatcher + REAL grant math
 * (`resolveGrantedToolNames`) + the REAL tool input schemas / required_actions /
 * handlers (the three write tools are IMPORTED, not faked) with mocked collateral
 * deps:
 *
 *   1. a write tool is REFUSED (`tool_not_granted`) when the write pack is NOT
 *      granted — fail-closed (invariant #5), the handler never runs.
 *   2. granting `boleto_proposal_write_pack` makes boleto_cancel /
 *      company_campaign_remove dispatchable through the SAME guard chain, and
 *      `canAct` is consulted (the real action keys gate execution).
 *   3. granting `refund_intake_pack` makes refund_create dispatchable.
 *   4. `constitutionalCheck` is consulted for the write (compose, don't bypass):
 *      a forbidden violation short-circuits the dispatch.
 *   5. the REAL input schema rejects an incomplete write (refund_create without
 *      `valor`/evidence) BEFORE the handler runs.
 *
 * We mock `@/tools/_registry.js` to expose ONLY the three real write tools (so we
 * don't boot the gateway) — keeping their real `input_schema`, `required_actions`
 * AND `handler` (contract-honouring stubs that return schema-valid output) — and
 * use the REAL `grant-math.ts` so the pack→tool mapping is exercised end-to-end.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { auditMock } = vi.hoisted(() => ({ auditMock: vi.fn(async () => undefined) }));
const { grantState } = vi.hoisted(() => ({
  grantState: {
    grant: { granted_packs: [] as string[], granted_tools: [] as string[], denied_tools: [] as string[] },
  },
}));
const { constitutionalMock } = vi.hoisted(() => ({ constitutionalMock: vi.fn(() => null) }));
const { canActMock } = vi.hoisted(() => ({ canActMock: vi.fn(() => ({ allowed: true })) }));

vi.mock('@/db/repositories.js', () => ({
  idempotencyRepo: {
    lookup: vi.fn(async () => null),
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
  // Fase 0 cap. 2/3 — repos do store de aprovação (não exercitados aqui: o
  // constitutionalCheck está mockado para null e os valores ficam abaixo dos
  // thresholds, então o dispatcher não entra no fluxo de approval).
  approvalRequestsRepo: {
    findOpenByFingerprint: vi.fn(async () => null),
    create: vi.fn(async () => null),
  },
  approvalDecisionsRepo: { record: vi.fn(async () => null), byRequest: vi.fn(async () => []) },
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
  return { ...actual, canAct: canActMock };
});
vi.mock('@/governance/rules.js', () => ({ constitutionalCheck: constitutionalMock }));

// Expose ONLY the three REAL write tools (real input_schema + required_actions +
// the stub handlers that return schema-valid output). boleto-*.ts only import zod
// + a type, so this does NOT boot the gateway / the full registry.
vi.mock('@/tools/_registry.js', async () => {
  const [bc, cc, rc] = await Promise.all([
    import('@/tools/boleto-cancel.js'),
    import('@/tools/company-campaign-remove.js'),
    import('@/tools/refund-create.js'),
  ]);
  return {
    REGISTRY: {
      boleto_cancel: bc.boletoCancelTool,
      company_campaign_remove: cc.companyCampaignRemoveTool,
      refund_create: rc.refundCreateTool,
    },
    isToolEnabled: () => true,
  };
});

import { dispatchTool } from '@/tools/_dispatcher.js';
import type { Pessoa, Conversa } from '@/db/schema.js';

const UUID = '00000000-0000-4000-8000-000000000001';
// Fase 0 cap. 3 (revisão adversarial): o dispatcher agora roda o avaliador
// financeiro REAL (não mockado) para tools com `valor` — refund_create tem
// `valor`. O escopo precisa carregar uma permissão resolvida ativa (sem
// limite individual) para o entity, senão o gate fail-closed nega
// `no_permission_for_entity` antes do handler. `canAct` continua mockado
// (isola a composição pack↔guard); o teto global default (50k) admite 100.
const resolvedForEntity = {
  permissao: { status: 'ativa' },
  profile: { acoes: ['*'] },
  effective_limits: { valor_max: null },
} as unknown as import('@/governance/permissions.js').ResolvedPermission;
const fakeCtx = {
  pessoa: { id: 'p1', status: 'ativa' } as unknown as Pessoa,
  scope: { entidades: [UUID], byEntity: new Map([[UUID, resolvedForEntity]]) },
  conversa: { id: 'c1' } as unknown as Conversa,
  mensagem_id: 'm1',
  request_id: 'r1',
};
// Valid args per the REAL schemas (entidade_id uuid; refine constraints satisfied).
const cancelArgs = { entidade_id: UUID, boleto_id: 'b1', reason: 'cliente pediu' };
const removeArgs = { entidade_id: UUID, company_id: 'cmp_1', reason: 'opt-out' };
const refundArgs = {
  entidade_id: UUID,
  valor: 100,
  receipt_reference: 'rcpt_1',
  reason: 'pago em duplicidade',
};

beforeEach(() => {
  vi.clearAllMocks();
  grantState.grant = { granted_packs: [], granted_tools: [], denied_tools: [] };
  constitutionalMock.mockReturnValue(null);
  canActMock.mockReturnValue({ allowed: true });
});

describe('dispatcher — boleto write tools compose with the guard (issue #416)', () => {
  it('(1) refuses boleto_cancel when the write pack is NOT granted (fail-closed)', async () => {
    grantState.grant = { granted_packs: ['baseline.core'], granted_tools: [], denied_tools: [] };
    const out = await dispatchTool({ tool: 'boleto_cancel', args: cancelArgs, ctx: fakeCtx });
    expect(out).toEqual({ error: 'tool_not_granted', details: { tool: 'boleto_cancel' } });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        acao: 'tool_not_granted',
        metadata: expect.objectContaining({ tool: 'boleto_cancel' }),
      }),
    );
  });

  it('(2) granting boleto_proposal_write_pack makes the two write tools dispatchable; canAct is consulted', async () => {
    grantState.grant = {
      granted_packs: ['baseline.core', 'boleto_proposal_write_pack'],
      granted_tools: [],
      denied_tools: [],
    };
    // Honest stub (#432): the write is DISPATCHABLE (handler runs through the
    // guard) but reports it executed NOTHING — no faked `ok: true`.
    const a = await dispatchTool({ tool: 'boleto_cancel', args: cancelArgs, ctx: fakeCtx });
    expect(a).toMatchObject({ executed: false, status: 'stub_not_executed' });
    const b = await dispatchTool({ tool: 'company_campaign_remove', args: removeArgs, ctx: fakeCtx });
    expect(b).toMatchObject({ executed: false, status: 'stub_not_executed' });
    // The dispatcher consulted canAct (the real granular action keys gate exec).
    expect(canActMock).toHaveBeenCalled();
    // refund_create is NOT in the write pack → still refused (handler never runs).
    const c = await dispatchTool({ tool: 'refund_create', args: refundArgs, ctx: fakeCtx });
    expect(c).toEqual({ error: 'tool_not_granted', details: { tool: 'refund_create' } });
  });

  it('(3) granting refund_intake_pack makes refund_create dispatchable', async () => {
    grantState.grant = {
      granted_packs: ['baseline.core', 'refund_intake_pack'],
      granted_tools: [],
      denied_tools: [],
    };
    const out = await dispatchTool({ tool: 'refund_create', args: refundArgs, ctx: fakeCtx });
    expect(out).toMatchObject({ executed: false, status: 'stub_not_executed' });
  });

  it("(4) constitutionalCheck is consulted for the write (compose, don't bypass)", async () => {
    grantState.grant = {
      granted_packs: ['baseline.core', 'boleto_proposal_write_pack'],
      granted_tools: [],
      denied_tools: [],
    };
    constitutionalMock.mockReturnValueOnce({ kind: 'forbidden', rule_id: 'r', reason: 'blocked' });
    const out = await dispatchTool({ tool: 'boleto_cancel', args: cancelArgs, ctx: fakeCtx });
    expect(constitutionalMock).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ error: 'forbidden' });
  });

  it('(5) the REAL input schema rejects an incomplete write (refund without valor/evidence)', async () => {
    grantState.grant = {
      granted_packs: ['baseline.core', 'refund_intake_pack'],
      granted_tools: [],
      denied_tools: [],
    };
    // Missing `valor` and any evidence → the real schema (+ refine) refuses; the
    // dispatch must NOT succeed as a write.
    const out = await dispatchTool({
      tool: 'refund_create',
      args: { entidade_id: UUID, reason: 'sem valor nem evidência' },
      ctx: fakeCtx,
    }).catch((e: unknown) => ({ error: String(e) }));
    expect(out).not.toMatchObject({ ok: true });
    expect(out).toHaveProperty('error');
  });
});
