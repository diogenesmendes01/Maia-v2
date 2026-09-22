/**
 * U-P04.7a (spec §8.2.3, §8.2.5) — o chamador de produção do controle humano.
 *
 * O que estes casos prendem é a SEQUÊNCIA, que é o que o módulo acrescenta
 * sobre o repositório: uma pausa que volta com dreno incompleto não é uma
 * pausa concluída, e a reconciliação precisa rodar no epoch que a pausa
 * devolveu — não no que o comando pediu.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const pauseConversationTx = vi.fn();
const reconcilePauseTx = vi.fn();
const resumeConversationTx = vi.fn();

vi.mock('@/db/repositories/conversation-control-repo.js', () => ({
  conversationControlRepo: { pauseConversationTx, reconcilePauseTx, resumeConversationTx },
}));
vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { pauseConversation, resumeConversation } =
  await import('@/runtime/conversation-control/service.js');

const CMD = {
  control_id: 'ctl-1',
  expected_epoch: '7',
  idempotency_key: 'idem-1',
  requested_by_app_user_id: 'op-1',
  reason_code: 'operator_takeover' as const,
  request_payload: {},
};

const PAUSA_OK = {
  ok: true as const,
  idempotent: false,
  command_id: 'cmd-1',
  control_id: 'ctl-1',
  mode: 'human',
  epoch: '8',
  barrier_committed: true,
  inflight_effects: 0,
  unknown_deliveries: 0,
  updated_at: new Date(),
};

beforeEach(() => {
  pauseConversationTx.mockReset();
  reconcilePauseTx.mockReset();
  resumeConversationTx.mockReset();
});

describe('pauseConversation — pausa e dreno numa operação só', () => {
  it('dreno completo na pausa: controle adquirido sem reconciliar', async () => {
    pauseConversationTx.mockResolvedValue({ ...PAUSA_OK, drain_status: 'complete' });
    const r = await pauseConversation(CMD);
    expect(r.kind).toBe('acquired');
    expect(reconcilePauseTx).not.toHaveBeenCalled();
  });

  it('dreno incompleto reconcilia no epoch DEVOLVIDO, não no pedido', async () => {
    // O epoch sobe na pausa. Reconciliar com o `expected_epoch` do comando
    // seria recusado por `epoch_mismatch` — uma falha que pareceria corrida e
    // seria só erro de sequenciamento nosso.
    pauseConversationTx.mockResolvedValue({
      ...PAUSA_OK,
      drain_status: 'reconciliation_required',
      inflight_effects: 2,
    });
    reconcilePauseTx.mockResolvedValue({
      ok: true,
      idempotent: false,
      control_id: 'ctl-1',
      mode: 'human',
      epoch: '8',
      drain_status: 'complete',
      inflight_effects: 0,
      unknown_deliveries: 0,
      drain_scope: 'engine_originated_only',
      updated_at: new Date(),
    });

    const r = await pauseConversation(CMD);
    expect(reconcilePauseTx).toHaveBeenCalledWith(
      expect.objectContaining({ expected_epoch: '8', idempotency_key: 'idem-1:reconcile' }),
    );
    expect(r.kind).toBe('acquired');
  });

  it('reconciliação recusada NÃO vira recusa: a pausa valeu, a automação está barrada', async () => {
    pauseConversationTx.mockResolvedValue({
      ...PAUSA_OK,
      drain_status: 'reconciliation_required',
      inflight_effects: 1,
      unknown_deliveries: 1,
    });
    reconcilePauseTx.mockResolvedValue({ ok: false, reason: 'epoch_mismatch' });

    const r = await pauseConversation(CMD);
    // Dizer `refused` aqui sugeriria que a conversa continua com o bot, que é
    // o oposto do que aconteceu.
    expect(r.kind).toBe('reconciliation_required');
    expect(r.kind === 'reconciliation_required' && r.inflight_effects).toBe(1);
  });

  it('pausa recusada propaga o motivo e o estado atual', async () => {
    pauseConversationTx.mockResolvedValue({
      ok: false,
      reason: 'epoch_mismatch',
      current_epoch: '9',
      current_mode: 'bot',
    });
    const r = await pauseConversation(CMD);
    expect(r).toEqual({
      kind: 'refused',
      reason: 'epoch_mismatch',
      current_epoch: '9',
      current_mode: 'bot',
    });
    expect(reconcilePauseTx).not.toHaveBeenCalled();
  });
});

describe('resumeConversation — future_only não é escolha do caller', () => {
  it('fixa resume_policy em future_only', async () => {
    resumeConversationTx.mockResolvedValue({
      ok: true,
      idempotent: false,
      command_id: 'cmd-2',
      control_id: 'ctl-1',
      mode: 'bot',
      epoch: '9',
      resume_after_ingress_seq: '1234',
      backlog_cancelled: 3,
      updated_at: new Date(),
    });

    const r = await resumeConversation({ ...CMD, reason_code: 'operator_release' });
    expect(resumeConversationTx).toHaveBeenCalledWith(
      expect.objectContaining({ resume_policy: 'future_only' }),
    );
    expect(r.kind).toBe('resumed');
    expect(r.kind === 'resumed' && r.resume_after_ingress_seq).toBe('1234');
  });
});

describe('identidade do desfecho — comando e chave de idempotência não se misturam', () => {
  it('pausa devolve identidade de COMANDO, com o id emitido pelo repositório', async () => {
    pauseConversationTx.mockResolvedValue({ ...PAUSA_OK, drain_status: 'complete' });
    const r = await pauseConversation(CMD);
    expect(r.kind === 'acquired' && r.identity).toEqual({
      kind: 'command',
      command_id: 'cmd-1',
    });
  });

  it('reconciliação avulsa NÃO fabrica um command_id', async () => {
    // `reconcilePauseTx` não emite comando — ele reconcilia um que já existe.
    // A versão anterior devolvia a `idempotency_key` no campo `command_id`, e
    // um consumidor que correlacionasse os dois resultados receberia
    // identificadores que não são comparáveis entre si.
    const { reconcilePause } = await import('@/runtime/conversation-control/service.js');
    reconcilePauseTx.mockResolvedValue({
      ok: true,
      idempotent: false,
      control_id: 'ctl-1',
      mode: 'human',
      epoch: '8',
      drain_status: 'complete',
      inflight_effects: 0,
      unknown_deliveries: 0,
      drain_scope: 'engine_originated_only',
      updated_at: new Date(),
    });

    const r = await reconcilePause({
      control_id: 'ctl-1',
      expected_epoch: '8',
      idempotency_key: 'idem-9',
      requested_by_app_user_id: 'op-1',
    });

    expect(r.kind === 'acquired' && r.identity).toEqual({
      kind: 'standalone_reconciliation',
      idempotency_key: 'idem-9',
    });
    // E o discriminante impede ler um como o outro por engano.
    expect(JSON.stringify(r)).not.toContain('"command_id"');
  });
});
