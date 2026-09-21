/**
 * P09 (spec §7.9.2) — adapter transacional de decisão sobre conhecimento.
 *
 * O que estes casos prendem é que a decisão humana **não pode inventar
 * aresta** nem sobrescrever outra decisão:
 *
 *  - só `pending_review` é decidível por esta porta;
 *  - a transição é validada contra a tabela do KSM antes de tocar o banco;
 *  - a escrita leva `expected_previous_status`, então uma decisão concorrente
 *    perde a corrida em vez de apagar a outra;
 *  - `decided_by` usa o vocabulário FECHADO, e a identidade autenticada vai
 *    para o motivo — cunhar `app_user:<id>` ali partiria em duas todas as
 *    consultas que agrupam por decisor.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findById = vi.fn();
const update = vi.fn(async () => undefined);

vi.mock('@/control-plane/knowledge-state-machine/repos.js', () => ({
  knowledgeRepos: { findById, update },
}));

const { applyKnowledgeDecisionTx } = await import('@/learning/approval-adapter.js');

const TX = {} as never;
const BASE = {
  kind: 'fact' as const,
  proposal_id: '11111111-1111-4111-8111-111111111111',
  decided_by_app_user_id: 'user-7',
  reason: 'confere com o extrato',
};

beforeEach(() => {
  findById.mockReset();
  update.mockReset();
  update.mockResolvedValue(undefined);
});

describe('applyKnowledgeDecisionTx', () => {
  it('aprovar leva pending_review → active, com a identidade no motivo', async () => {
    findById.mockResolvedValue({ lifecycle_status: 'pending_review', lifecycle_transitions: [] });
    const r = await applyKnowledgeDecisionTx(TX, { ...BASE, decision: 'approve' });

    expect(r).toEqual({ ok: true, from: 'pending_review', to: 'active' });
    const [, , updates] = update.mock.calls[0] as [unknown, unknown, Record<string, unknown>];
    const transicoes = updates.lifecycle_transitions as Array<Record<string, unknown>>;
    expect(transicoes[0]?.decided_by).toBe('human_approval');
    expect(String(transicoes[0]?.reason)).toContain('app_user:user-7');
  });

  it('aprovar vai para `active`, não para `verified`', async () => {
    // `verified` é estado de EVIDÊNCIA acumulada, que o auto-promoter atinge
    // sozinho. Aprovação humana é autorização, não evidência.
    findById.mockResolvedValue({ lifecycle_status: 'pending_review', lifecycle_transitions: [] });
    const r = await applyKnowledgeDecisionTx(TX, { ...BASE, decision: 'approve' });
    expect(r).toMatchObject({ to: 'active' });
  });

  it('rejeitar leva a revoked, que é terminal', async () => {
    findById.mockResolvedValue({ lifecycle_status: 'pending_review', lifecycle_transitions: [] });
    const r = await applyKnowledgeDecisionTx(TX, { ...BASE, decision: 'reject' });
    expect(r).toMatchObject({ to: 'revoked' });
    const [, , updates] = update.mock.calls[0] as [unknown, unknown, Record<string, unknown>];
    const transicoes = updates.lifecycle_transitions as Array<Record<string, unknown>>;
    expect(transicoes[0]?.decided_by).toBe('human_rejection');
  });

  it('a escrita leva expected_previous_status — decisão concorrente perde a corrida', async () => {
    // Sem o CAS, duas aprovações simultâneas gravariam as duas, e a segunda
    // apagaria a primeira sem ninguém saber.
    findById.mockResolvedValue({ lifecycle_status: 'pending_review', lifecycle_transitions: [] });
    await applyKnowledgeDecisionTx(TX, { ...BASE, decision: 'approve' });
    const [, , updates] = update.mock.calls[0] as [unknown, unknown, Record<string, unknown>];
    expect(updates.expected_previous_status).toBe('pending_review');
  });

  it('a transição anterior é PRESERVADA, não sobrescrita', async () => {
    findById.mockResolvedValue({
      lifecycle_status: 'pending_review',
      lifecycle_transitions: [{ from: 'proposed', to: 'pending_review' }],
    });
    await applyKnowledgeDecisionTx(TX, { ...BASE, decision: 'approve' });
    const [, , updates] = update.mock.calls[0] as [unknown, unknown, Record<string, unknown>];
    expect((updates.lifecycle_transitions as unknown[]).length).toBe(2);
  });

  it('item que NÃO está pendente não é decidível por esta porta', async () => {
    for (const estado of ['active', 'revoked', 'ephemeral']) {
      findById.mockResolvedValue({ lifecycle_status: estado, lifecycle_transitions: [] });
      const r = await applyKnowledgeDecisionTx(TX, { ...BASE, decision: 'approve' });
      expect(r, estado).toMatchObject({ ok: false, reason: 'invalid_source_status' });
      expect(update).not.toHaveBeenCalled();
    }
  });

  it('proposta inexistente não finge sucesso', async () => {
    findById.mockResolvedValue(null);
    expect(await applyKnowledgeDecisionTx(TX, { ...BASE, decision: 'approve' })).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('a leitura e a escrita usam o MESMO executor recebido', async () => {
    // É a garantia transacional inteira: decisão e efeito na mesma transação.
    findById.mockResolvedValue({ lifecycle_status: 'pending_review', lifecycle_transitions: [] });
    await applyKnowledgeDecisionTx(TX, { ...BASE, decision: 'approve' });
    expect(findById.mock.calls[0]?.[2]).toBe(TX);
    expect(update.mock.calls[0]?.[3]).toBe(TX);
  });
});
