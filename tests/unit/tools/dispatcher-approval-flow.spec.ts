/**
 * Fase 0 cap. 3 — fluxo de aprovação backend no dispatcher.
 *
 * Prova o contrato central da auditoria P0:
 *   (1) operação crítica SEM evidência → cria request persistido, notifica e
 *       NÃO executa (handler zero chamadas);
 *   (2) `dual_approval_granted: true` nos args do LLM é INERTE;
 *   (3) request pendente → segue bloqueado (approval_pending), sem duplicar;
 *   (4) evidência aprovada + intent idêntico → claim → executa UMA vez →
 *       consume (one-time);
 *   (5) payload alterado após aprovação → hash diverge → NOVA solicitação,
 *       sem execução;
 *   (6) evidência consumida não reexecuta (novo request).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

const { auditMock } = vi.hoisted(() => ({ auditMock: vi.fn(async () => undefined) }));
const { sendTextMock, enqueueNoticeMock } = vi.hoisted(() => ({
  sendTextMock: vi.fn(async () => 'msg-1'),
  enqueueNoticeMock: vi.fn(async () => 'enqueued' as const),
}));
const { handlerMock } = vi.hoisted(() => ({
  handlerMock: vi.fn(async () => ({ ok: true })),
}));

type Row = {
  id: string;
  tenant_id: string;
  agent_id: string;
  requester_pessoa_id: string;
  entidade_id: string | null;
  conversa_id: string | null;
  mensagem_id: string | null;
  request_id: string | null;
  tool: string;
  operation_type: string;
  intent_payload: unknown;
  intent_hash: string;
  intent_hash_version: number;
  approval_class: string;
  required_approvals: number;
  status: string;
  fingerprint: string;
  expires_at: Date;
  approved_at: Date | null;
  denied_at: Date | null;
  claimed_at: Date | null;
  consumed_at: Date | null;
  claim_token: string | null;
  result_ref: string | null;
  created_at: Date;
  updated_at: Date;
};

const { store } = vi.hoisted(() => ({
  store: {
    rows: new Map<string, Row>(),
    decisions: [] as Array<{ request_id: string; principal_pessoa_id: string; decision: string }>,
    reset() {
      this.rows.clear();
      this.decisions = [];
    },
    open(fingerprint: string): Row | null {
      for (const r of this.rows.values()) {
        if (
          r.fingerprint === fingerprint &&
          ['pending', 'approved', 'claimed'].includes(r.status)
        ) {
          return r;
        }
      }
      return null;
    },
  },
}));

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
  agentToolGrantsRepo: {
    findForCurrentAgent: vi.fn(async () => ({
      granted_packs: [],
      granted_tools: ['send_proactive_message'],
      denied_tools: [],
    })),
  },
  pessoasRepo: {
    list: vi.fn(async () => [
      makePessoa({ id: 'owner-2', nome: 'Coproprietária', tipo: 'co_dono' }),
      makePessoa({ id: 'p-requester', nome: 'Dono', tipo: 'dono' }),
    ]),
    findById: vi.fn(async () => null),
  },
  approvalRequestsRepo: {
    create: vi.fn(async (input: Omit<Row, 'id' | 'tenant_id' | 'agent_id' | 'status' | 'created_at' | 'updated_at' | 'approved_at' | 'denied_at' | 'claimed_at' | 'consumed_at' | 'claim_token' | 'result_ref'>) => {
      if (store.open(input.fingerprint)) return null;
      const row: Row = {
        ...input,
        id: randomUUID(),
        tenant_id: 'primary',
        agent_id: 'primary',
        status: 'pending',
        approved_at: null,
        denied_at: null,
        claimed_at: null,
        consumed_at: null,
        claim_token: null,
        result_ref: null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      store.rows.set(row.id, row);
      return row;
    }),
    byId: vi.fn(async (id: string) => store.rows.get(id) ?? null),
    findOpenByRefPrefix: vi.fn(async (prefix: string) => {
      const hits = [...store.rows.values()].filter(
        (r) => r.id.startsWith(prefix) && ['pending', 'approved', 'claimed'].includes(r.status),
      );
      return hits.length === 1 ? hits[0] : null;
    }),
    findOpenByFingerprint: vi.fn(async (fp: string) => store.open(fp)),
    markApproved: vi.fn(async (id: string) => {
      const r = store.rows.get(id);
      if (!r || r.status !== 'pending') return null;
      r.status = 'approved';
      r.approved_at = new Date();
      return r;
    }),
    markDenied: vi.fn(async (id: string) => {
      const r = store.rows.get(id);
      if (!r || r.status !== 'pending') return null;
      r.status = 'denied';
      return r;
    }),
    claim: vi.fn(async (input: { id: string; claim_token: string; intent_hash: string }) => {
      const r = store.rows.get(input.id);
      if (!r || r.status !== 'approved' || r.intent_hash !== input.intent_hash) return null;
      r.status = 'claimed';
      r.claim_token = input.claim_token;
      return r;
    }),
    releaseClaim: vi.fn(async (input: { id: string; claim_token: string }) => {
      const r = store.rows.get(input.id);
      if (!r || r.status !== 'claimed' || r.claim_token !== input.claim_token) return null;
      r.status = 'approved';
      r.claim_token = null;
      return r;
    }),
    consume: vi.fn(async (input: { id: string; claim_token: string }) => {
      const r = store.rows.get(input.id);
      if (!r || r.status !== 'claimed' || r.claim_token !== input.claim_token) return null;
      r.status = 'consumed';
      r.consumed_at = new Date();
      return r;
    }),
    markExecutionFailed: vi.fn(async (input: { id: string; claim_token: string }) => {
      const r = store.rows.get(input.id);
      if (!r || r.status !== 'claimed' || r.claim_token !== input.claim_token) return null;
      r.status = 'execution_failed';
      return r;
    }),
    expireDue: vi.fn(async () => []),
  },
  approvalDecisionsRepo: {
    record: vi.fn(async (input: { request_id: string; principal_pessoa_id: string; decision: string }) => {
      const dup = store.decisions.find(
        (d) => d.request_id === input.request_id && d.principal_pessoa_id === input.principal_pessoa_id,
      );
      if (dup) return null;
      store.decisions.push(input);
      return { ...input, id: randomUUID() };
    }),
    byRequest: vi.fn(async (request_id: string) =>
      store.decisions.filter((d) => d.request_id === request_id),
    ),
  },
}));
vi.mock('@/governance/audit.js', () => ({ audit: auditMock }));
vi.mock('@/lib/redis.js', () => ({ isRedisConnected: vi.fn(() => true) }));
vi.mock('@/lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// Issue #506 — o aviso ao aprovador deixou de ser `line.sendText` e virou uma
// linha do ledger durável de agendamento. O mock da fronteira de saída fica
// como TRIPWIRE: se o dispatcher voltar a falar direto com o canal,
// `sendTextMock` registra a chamada e a asserção de "zero envio direto" abaixo
// fica vermelha.
vi.mock('@/gateway/line-output.js', () => ({
  forCurrentAgentChannel: vi.fn(async () => ({ sendText: sendTextMock })),
}));
vi.mock('@/runtime/outbound/proactive-notice.js', () => ({
  enqueueProactiveNotice: enqueueNoticeMock,
}));

// Tool fake de ESCRITA sensível: entra no catálogo crítico via nome
// send_proactive_message (regra C-003 real — nada mockado em rules.ts).
vi.mock('@/tools/_registry.js', async () => {
  const { z } = await import('zod');
  const tool = {
    name: 'send_proactive_message',
    description: 'fake',
    input_schema: z.object({
      entidade_id: z.string().optional(),
      valor: z.number().optional(),
      mensagem: z.string().optional(),
    }),
    output_schema: z.object({ ok: z.boolean() }),
    required_actions: [],
    side_effect: 'communication',
    redis_required: false,
    operation_type: 'communicate',
    audit_action: 'transaction_created',
    handler: handlerMock,
  };
  return {
    REGISTRY: { send_proactive_message: tool },
    isToolEnabled: () => true,
  };
});

import { dispatchTool } from '@/tools/_dispatcher.js';
import { recordApprovalDecision } from '@/governance/approval-requests.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import type { Pessoa, Conversa } from '@/db/schema.js';

function makePessoa(overrides: Partial<Pessoa>): Pessoa {
  return {
    id: 'p-requester',
    nome: 'Dono',
    apelido: null,
    telefone_whatsapp: '+5511999990000',
    tipo: 'dono',
    email: null,
    observacoes: null,
    preferencias: {},
    modelo_mental: {},
    status: 'ativa',
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as Pessoa;
}

const requester = makePessoa({});
const conversa = { id: 'c-1', channel_id: null } as unknown as Conversa;

const ctx = {
  pessoa: requester,
  scope: { entidades: ['e-1'], byEntity: new Map() },
  conversa,
  mensagem_id: 'm-1',
  request_id: 'r-1',
};

const dispatch = (args: Record<string, unknown>) =>
  runWithTenantContext({ tenant_id: 'primary', agent_id: 'primary' }, () =>
    dispatchTool({ tool: 'send_proactive_message', args, ctx }),
  );

const approveAs = (approver: Pessoa, refPrefix: string) =>
  runWithTenantContext({ tenant_id: 'primary', agent_id: 'primary' }, () =>
    recordApprovalDecision({ refPrefix, approver, decision: 'approve' }),
  );

beforeEach(() => {
  store.reset();
  handlerMock.mockClear();
  sendTextMock.mockClear();
  enqueueNoticeMock.mockClear();
  auditMock.mockClear();
});

describe('dispatcher — aprovação backend (Fase 0 cap. 3)', () => {
  it('(1) crítica sem evidência: cria request, notifica e NÃO executa', async () => {
    const result = (await dispatch({ mensagem: 'oi' })) as Record<string, unknown>;
    expect(result.error).toBe('requires_dual_approval');
    expect(handlerMock).not.toHaveBeenCalled();
    expect(store.rows.size).toBe(1);
    const row = [...store.rows.values()][0]!;
    expect(row.status).toBe('pending');
    // requester é dono → classe requester_plus_one_owner, assina na criação
    expect(row.approval_class).toBe('requester_plus_one_owner');
    expect(store.decisions).toHaveLength(1);
    // Issue #506 — a notificação ao outro owner (não ao requester) é
    // COMPROMETIDA no ledger durável antes de virar mensagem, e nunca sai por
    // chamada direta ao canal.
    expect(sendTextMock).not.toHaveBeenCalled();
    expect(enqueueNoticeMock).toHaveBeenCalledTimes(1);
    const notice = enqueueNoticeMock.mock.calls[0]![0] as unknown as {
      jid: string;
      text: string;
      dedupe_key: string;
    };
    // A chave amarra o aviso à row durável que o justifica E ao destinatário:
    // é o par que torna "este aviso já foi comprometido" uma pergunta
    // respondível pelo unique do banco, e não pelo texto da mensagem.
    expect(notice.dedupe_key).toBe(`approval_request:${row.id}:notify:owner-2`);
  });

  it('(2) dual_approval_granted nos args do LLM é inerte', async () => {
    const result = (await dispatch({ mensagem: 'oi', dual_approval_granted: true } as Record<
      string,
      unknown
    >)) as Record<string, unknown>;
    expect(result.error).toBe('requires_dual_approval');
    expect(handlerMock).not.toHaveBeenCalled();
  });

  it('(3) request pendente segue bloqueado sem duplicar', async () => {
    await dispatch({ mensagem: 'oi' });
    const again = (await dispatch({ mensagem: 'oi' })) as Record<string, unknown>;
    expect(again.error).toBe('approval_pending');
    expect(store.rows.size).toBe(1);
    expect(handlerMock).not.toHaveBeenCalled();
  });

  it('(4) aprovado + intent idêntico → executa UMA vez e consome', async () => {
    await dispatch({ mensagem: 'oi' });
    const row = [...store.rows.values()][0]!;
    // segunda assinatura por outro owner qualificado → approved
    const outcome = await approveAs(
      makePessoa({ id: 'owner-2', tipo: 'co_dono', nome: 'Coproprietária' }),
      row.id.slice(0, 8),
    );
    expect(outcome.outcome).toBe('approved');

    const result = (await dispatch({ mensagem: 'oi' })) as { ok?: boolean };
    expect(result).toEqual({ ok: true });
    expect(handlerMock).toHaveBeenCalledTimes(1);
    expect(row.status).toBe('consumed');
  });

  it('(5) payload alterado após aprovação exige NOVA aprovação', async () => {
    await dispatch({ mensagem: 'oi' });
    const row = [...store.rows.values()][0]!;
    await approveAs(makePessoa({ id: 'owner-2', tipo: 'co_dono' }), row.id.slice(0, 8));

    const tampered = (await dispatch({ mensagem: 'transfere tudo' })) as Record<string, unknown>;
    expect(tampered.error).toBe('requires_dual_approval');
    expect(handlerMock).not.toHaveBeenCalled();
    // a evidência aprovada do payload original permanece intacta (não vaza)
    expect(row.status).toBe('approved');
  });

  it('(6) evidência consumida não reexecuta — novo request', async () => {
    await dispatch({ mensagem: 'oi' });
    const row = [...store.rows.values()][0]!;
    await approveAs(makePessoa({ id: 'owner-2', tipo: 'co_dono' }), row.id.slice(0, 8));
    await dispatch({ mensagem: 'oi' }); // executa + consome

    const replay = (await dispatch({ mensagem: 'oi' })) as Record<string, unknown>;
    expect(replay.error).toBe('requires_dual_approval');
    expect(handlerMock).toHaveBeenCalledTimes(1);
    expect(store.rows.size).toBe(2); // request novo, evidência antiga preservada
  });

  it('mesma pessoa não conta duas vezes (dois canais)', async () => {
    await dispatch({ mensagem: 'oi' });
    const row = [...store.rows.values()][0]!;
    // requester (que já assinou na criação) tenta aprovar de novo
    const dup = await approveAs(requester, row.id.slice(0, 8));
    expect(dup.outcome).toBe('duplicate');
    expect(row.status).toBe('pending');
  });

  it('aprovador não qualificado não conta', async () => {
    await dispatch({ mensagem: 'oi' });
    const row = [...store.rows.values()][0]!;
    const outcome = await approveAs(
      makePessoa({ id: 'p-contador', tipo: 'contador' }),
      row.id.slice(0, 8),
    );
    expect(outcome.outcome).toBe('not_eligible');
    expect(row.status).toBe('pending');
  });
});
