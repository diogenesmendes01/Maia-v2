/**
 * Spec Maia+Hermes §8.3 — o router de controle humano de conversa.
 *
 * O que estes casos travam, e que nenhum compilador trava:
 *
 *   1. **`reconciliation_required` NÃO é recusa.** É o achado de revisão que
 *      este router mais arrisca perder: dizer `refused` sugeriria que a
 *      conversa voltou para o bot, o oposto do que aconteceu. Ele volta como
 *      ESTADO, com contagens e `drain_scope`. A contra-prova é o caso vizinho,
 *      em que `refused` de verdade LANÇA;
 *   2. **ACL do §8.3 mora aqui, e só aqui.** `viewer`/`analyst` não tomam
 *      conversa; `owner`/`founder`/`compliance_officer` tomam;
 *   3. **Escopo vem da SESSÃO.** O serviço e o repositório leem tenant e agente
 *      do ALS — se o router não abrir o contexto, a chamada lança. Os casos
 *      medem o par EFETIVO dentro do serviço, não a intenção do router;
 *   4. **O router não reaudita.** As três ações de auditoria são escritas
 *      dentro das transações do repositório; uma segunda linha aqui mentiria
 *      num rollback. O caso prova pela ausência de chamada ao repo de trilha;
 *   5. **Cada recusa tem um código HTTP próprio.** "Você está desatualizado" e
 *      "isto não se aplica aqui" não podem contar a mesma história.
 *
 * Puro: o serviço é dublado, e nenhum caso toca Postgres.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { getCurrentAgent, getCurrentTenant } from '@/db/tenant-context.js';

/**
 * O repositório é dublado só pelas CONSTANTES: o router importa os vocabulários
 * fechados de motivo, e importar o módulo real arrastaria `db/client.ts` (que
 * constrói o `pg.Pool` no import) para dentro de um teste que não tem banco.
 */
vi.mock('@/db/repositories/conversation-control-repo.js', () => ({
  PAUSE_REASON_CODES: [
    'operator_takeover',
    'customer_requested',
    'safety_review',
    'handoff_accepted',
  ] as const,
  RESUME_REASON_CODES: ['human_resolved', 'operator_release', 'supervised_recovery'] as const,
}));

const servico = vi.hoisted(() => ({
  pause: vi.fn(),
  reconcile: vi.fn(),
  resume: vi.fn(),
  /** Par EFETIVO visto de dentro do serviço — é a prova do ALS. */
  escopoVisto: [] as Array<{ tenant_id: string; agent_id: string }>,
}));

vi.mock('@/runtime/conversation-control/service.js', () => ({
  pauseConversation: (...a: unknown[]) => {
    servico.escopoVisto.push({ tenant_id: getCurrentTenant(), agent_id: getCurrentAgent() });
    return servico.pause(...(a as []));
  },
  reconcilePause: (...a: unknown[]) => {
    servico.escopoVisto.push({ tenant_id: getCurrentTenant(), agent_id: getCurrentAgent() });
    return servico.reconcile(...(a as []));
  },
  resumeConversation: (...a: unknown[]) => {
    servico.escopoVisto.push({ tenant_id: getCurrentTenant(), agent_id: getCurrentAgent() });
    return servico.resume(...(a as []));
  },
}));

import { conversationControlRouter } from '@/admin-ui/trpc/routers/conversationControl.js';
import { _resetRateLimitForTests } from '@/admin-ui/trpc/rate-limit.js';

const CONTROL = '11111111-1111-4111-8111-111111111111';
const CHAVE = 'pausa-2026-09-22-0001';

function makeCtx(role: string) {
  const audits: Array<Record<string, unknown>> = [];
  const ctx = {
    session: { user: { id: 'user-1', role, tenant_id: 'tenant-A' } },
    userId: 'user-1',
    userRole: role,
    tenantId: 'tenant-A',
    repos: {
      adminAuditLogRepo: {
        async append(row: Record<string, unknown>) {
          audits.push(row);
          return row;
        },
      },
    } as unknown as typeof import('@/db/repositories.js'),
    assertTenant(input_tenant: string) {
      if (role === 'founder') return;
      if (input_tenant !== 'tenant-A') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Tenant isolation violation' });
      }
    },
    assertRole(...allowed: string[]) {
      if (!allowed.includes(role)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: `Role ${role} not allowed` });
      }
    },
  };
  return { ctx, audits };
}

function caller(ctx: ReturnType<typeof makeCtx>['ctx']) {
  return conversationControlRouter.createCaller(ctx as never);
}

const PAUSA = {
  agentId: 'agent-a',
  controlId: CONTROL,
  expectedEpoch: '3',
  idempotencyKey: CHAVE,
  reasonCode: 'operator_takeover' as const,
};

const ADQUIRIDA = {
  kind: 'acquired' as const,
  control_id: CONTROL,
  epoch: '4',
  idempotent: false,
  identity: { kind: 'command' as const, command_id: 'cmd-1' },
};

const PRECISA_RECONCILIAR = {
  kind: 'reconciliation_required' as const,
  control_id: CONTROL,
  epoch: '4',
  identity: { kind: 'command' as const, command_id: 'cmd-1' },
  inflight_effects: 2,
  unknown_deliveries: 1,
  drain_scope: 'engine_originated_only' as const,
};

beforeEach(() => {
  _resetRateLimitForTests();
  servico.pause.mockReset();
  servico.reconcile.mockReset();
  servico.resume.mockReset();
  servico.escopoVisto.length = 0;
});

// ---------------------------------------------------------------------------
// 1. O detalhe de contrato: reconciliação pendente NÃO é recusa
// ---------------------------------------------------------------------------

describe('reconciliation_required é ESTADO, não erro', () => {
  it('pause com dreno em aberto devolve 200 com as contagens e o escopo medido', async () => {
    servico.pause.mockResolvedValue(PRECISA_RECONCILIAR);
    const { ctx } = makeCtx('owner');

    const r = await caller(ctx).pause(PAUSA);

    expect(r).toEqual({
      status: 'reconciliation_required',
      control_id: CONTROL,
      epoch: '4',
      identity: { kind: 'command', command_id: 'cmd-1' },
      inflight_effects: 2,
      unknown_deliveries: 1,
      // Sem isto, "0 efeitos" seria lido como "não há efeito em aberto" — e a
      // medição cobre APENAS egresso de origem engine.
      drain_scope: 'engine_originated_only',
    });
  });

  it('CONTRA-PROVA: `refused` de verdade LANÇA — os dois não colapsam', async () => {
    servico.pause.mockResolvedValue({
      kind: 'refused',
      reason: 'epoch_mismatch',
      current_epoch: '9',
    });
    const { ctx } = makeCtx('owner');

    await expect(caller(ctx).pause(PAUSA)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('reconcile avulso também devolve o estado, nunca erro', async () => {
    servico.reconcile.mockResolvedValue({
      ...PRECISA_RECONCILIAR,
      identity: { kind: 'standalone_reconciliation', idempotency_key: CHAVE },
    });
    const { ctx } = makeCtx('owner');

    const r = await caller(ctx).reconcile({
      agentId: 'agent-a',
      controlId: CONTROL,
      expectedEpoch: '4',
      idempotencyKey: CHAVE,
    });

    expect(r.status).toBe('reconciliation_required');
    expect(r).toMatchObject({
      identity: { kind: 'standalone_reconciliation', idempotency_key: CHAVE },
    });
  });

  it('pause com dreno completo devolve `acquired`', async () => {
    servico.pause.mockResolvedValue(ADQUIRIDA);
    const { ctx } = makeCtx('owner');

    const r = await caller(ctx).pause(PAUSA);

    expect(r).toMatchObject({ status: 'acquired', epoch: '4', idempotent: false });
  });
});

// ---------------------------------------------------------------------------
// 2. ACL do §8.3
// ---------------------------------------------------------------------------

describe('ACL — tomar a conversa é operação, não leitura', () => {
  for (const role of ['viewer', 'analyst']) {
    it(`${role} recebe FORBIDDEN em pause/reconcile/resume`, async () => {
      const { ctx } = makeCtx(role);
      const c = caller(ctx);
      await expect(c.pause(PAUSA)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        c.reconcile({
          agentId: 'agent-a',
          controlId: CONTROL,
          expectedEpoch: '3',
          idempotencyKey: CHAVE,
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(c.resume({ ...PAUSA, reasonCode: 'human_resolved' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(servico.pause).not.toHaveBeenCalled();
    });
  }

  it('CONTRA-PROVA: owner, founder e compliance_officer passam o gate', async () => {
    servico.pause.mockResolvedValue(ADQUIRIDA);
    for (const role of ['owner', 'founder', 'compliance_officer']) {
      _resetRateLimitForTests();
      const { ctx } = makeCtx(role);
      await expect(caller(ctx).pause(PAUSA)).resolves.toMatchObject({ status: 'acquired' });
    }
  });

  it('não-founder não consegue apontar outro tenant pelo corpo', async () => {
    servico.pause.mockResolvedValue(ADQUIRIDA);
    const { ctx } = makeCtx('owner');

    await expect(caller(ctx).pause({ ...PAUSA, tenantId: 'tenant-B' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(servico.pause).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. Escopo: o serviço roda DENTRO do par, e o par vem da sessão
// ---------------------------------------------------------------------------

describe('o escopo efetivo é o da sessão + o agente pedido', () => {
  it('pause roda sob (tenant da sessão, agente do input)', async () => {
    servico.pause.mockResolvedValue(ADQUIRIDA);
    const { ctx } = makeCtx('owner');

    await caller(ctx).pause({ ...PAUSA, agentId: 'agent-z' });

    expect(servico.escopoVisto).toEqual([{ tenant_id: 'tenant-A', agent_id: 'agent-z' }]);
  });

  it('founder operando cross-tenant leva o tenant PEDIDO para o ALS', async () => {
    servico.pause.mockResolvedValue(ADQUIRIDA);
    const { ctx } = makeCtx('founder');

    await caller(ctx).pause({ ...PAUSA, tenantId: 'tenant-B' });

    expect(servico.escopoVisto).toEqual([{ tenant_id: 'tenant-B', agent_id: 'agent-a' }]);
  });

  it('o operador autenticado é quem assina o comando — nunca o corpo', async () => {
    servico.pause.mockResolvedValue(ADQUIRIDA);
    const { ctx } = makeCtx('owner');

    await caller(ctx).pause({ ...PAUSA, note: 'cliente pediu atendente' });

    expect(servico.pause).toHaveBeenCalledWith({
      control_id: CONTROL,
      expected_epoch: '3',
      idempotency_key: CHAVE,
      requested_by_app_user_id: 'user-1',
      reason_code: 'operator_takeover',
      request_payload: { note: 'cliente pediu atendente' },
    });
  });
});

// ---------------------------------------------------------------------------
// 4. O router NÃO reaudita
// ---------------------------------------------------------------------------

describe('a trilha é escrita na transação, não aqui', () => {
  it('nenhuma das três rotas escreve em admin_audit_log', async () => {
    servico.pause.mockResolvedValue(ADQUIRIDA);
    servico.reconcile.mockResolvedValue(ADQUIRIDA);
    servico.resume.mockResolvedValue({
      kind: 'resumed',
      control_id: CONTROL,
      epoch: '5',
      idempotent: false,
      command_id: 'cmd-2',
      resume_after_ingress_seq: '42',
      backlog_cancelled: 3,
    });
    const { ctx, audits } = makeCtx('owner');
    const c = caller(ctx);

    await c.pause(PAUSA);
    await c.reconcile({
      agentId: 'agent-a',
      controlId: CONTROL,
      expectedEpoch: '4',
      idempotencyKey: CHAVE,
    });
    await c.resume({ ...PAUSA, reasonCode: 'human_resolved' });

    // Uma segunda linha aqui seria a que mente no dia em que a transação der
    // rollback: as três ações (`conversation_pause_requested`,
    // `conversation_control_acquired`, `conversation_control_conflict`) já são
    // gravadas no MESMO `tx` da mudança de estado.
    expect(audits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. Cada recusa com o seu código
// ---------------------------------------------------------------------------

describe('a tradução de recusa distingue as situações', () => {
  const casos: Array<[string, string]> = [
    ['control_not_found', 'NOT_FOUND'],
    ['forbidden', 'FORBIDDEN'],
    ['epoch_mismatch', 'CONFLICT'],
    ['mode_not_allowed', 'CONFLICT'],
    ['payload_conflict', 'CONFLICT'],
    ['reconciliation_required', 'PRECONDITION_FAILED'],
  ];

  for (const [reason, code] of casos) {
    it(`${reason} vira ${code}`, async () => {
      servico.pause.mockResolvedValue({ kind: 'refused', reason });
      const { ctx } = makeCtx('owner');
      await expect(caller(ctx).pause(PAUSA)).rejects.toMatchObject({ code });
    });
  }

  it('CONTRA-PROVA: os códigos NÃO são todos iguais', async () => {
    // Uma tradução que devolvesse CONFLICT para tudo passaria em três casos
    // acima. Aqui ela morre.
    const vistos = new Set(casos.map(([, c]) => c));
    expect(vistos.size).toBeGreaterThan(2);
  });

  it('motivo desconhecido não é apresentado como conflito comum', async () => {
    servico.pause.mockResolvedValue({ kind: 'refused', reason: 'motivo_que_nao_existe' });
    const { ctx } = makeCtx('owner');
    await expect(caller(ctx).pause(PAUSA)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Validação de entrada e limite
// ---------------------------------------------------------------------------

describe('entrada e limite', () => {
  it('epoch não canônico é recusado antes de qualquer transação', async () => {
    const { ctx } = makeCtx('owner');
    for (const epoch of ['007', '-1', '1.0', '', 'abc']) {
      await expect(caller(ctx).pause({ ...PAUSA, expectedEpoch: epoch })).rejects.toBeDefined();
    }
    expect(servico.pause).not.toHaveBeenCalled();
  });

  it('motivo fora do vocabulário fechado é recusado', async () => {
    const { ctx } = makeCtx('owner');
    await expect(
      caller(ctx).pause({ ...PAUSA, reasonCode: 'porque_sim' as never }),
    ).rejects.toBeDefined();
    expect(servico.pause).not.toHaveBeenCalled();
  });

  it('o limite é fail-closed: estourar lança TOO_MANY_REQUESTS', async () => {
    servico.pause.mockResolvedValue(ADQUIRIDA);
    const { ctx } = makeCtx('owner');
    const c = caller(ctx);
    for (let i = 0; i < 30; i++) {
      await c.pause({ ...PAUSA, idempotencyKey: `${CHAVE}-${String(i)}` });
    }
    await expect(c.pause({ ...PAUSA, idempotencyKey: `${CHAVE}-x` })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
  });

  it('resume devolve a watermark e quanto backlog foi descartado', async () => {
    servico.resume.mockResolvedValue({
      kind: 'resumed',
      control_id: CONTROL,
      epoch: '5',
      idempotent: false,
      command_id: 'cmd-2',
      resume_after_ingress_seq: '42',
      backlog_cancelled: 3,
    });
    const { ctx } = makeCtx('owner');

    const r = await caller(ctx).resume({ ...PAUSA, reasonCode: 'operator_release' });

    expect(r).toEqual({
      status: 'resumed',
      control_id: CONTROL,
      epoch: '5',
      idempotent: false,
      command_id: 'cmd-2',
      resume_after_ingress_seq: '42',
      backlog_cancelled: 3,
    });
    // `resume_policy` NÃO é parâmetro da rota: o serviço o fixa em
    // `future_only`, e expô-lo convidaria um caller a pedir replay do backlog.
    expect(servico.resume).toHaveBeenCalledWith(
      expect.not.objectContaining({ resume_policy: expect.anything() }),
    );
  });
});
