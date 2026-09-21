/**
 * P02 (spec §5.2, §5.3.4, §5.9.2.1) — `EngineResultAssembler`.
 *
 * ─── A regra que este arquivo prende ────────────────────────────────────────
 *
 * O journal é a fonte; a proposta do motor é alegação. Todo caso abaixo existe
 * para impedir uma variação do mesmo defeito: derivar do que o motor DISSE em
 * vez do que a Maia GRAVOU.
 *
 * O caso que mais importa é o da divergência `claimed_not_journaled`. Ele não é
 * hipotético: um motor remoto que reexecuta internamente, ou um adapter com bug
 * de retry, produz exatamente isso — uma chamada afirmada sem receipt. Tratar
 * como ruído deixaria a Maia responder ao usuário em cima de um efeito que
 * nunca passou pelo dispatcher da casa.
 */
import { describe, it, expect } from 'vitest';
import {
  assembleTurnResult,
  divergenceBlocksDelivery,
  divergenceToAuditPayload,
  type EngineToolReceiptV1,
} from '@/runtime/engines/assembler.js';
import type { EngineTerminalProposalV1, ReportedUsageV1 } from '@/runtime/engines/contracts.js';

const USO: ReportedUsageV1 = {
  input_tokens: 10,
  output_tokens: 20,
  cost_microusd: '1500',
  source: 'provider_accounted',
};

function receipt(
  over: Partial<EngineToolReceiptV1> & { call_id: string; ordinal: number },
): EngineToolReceiptV1 {
  return {
    tool_name: 'consultar_saldo',
    result: { ok: true },
    status: 'success',
    side_effect: 'read',
    sensitive: false,
    summary: {
      tool_call_id: over.call_id,
      tool_name: over.tool_name ?? 'consultar_saldo',
      status: 'success',
      side_effect: over.side_effect ?? 'read',
      result_summary: 'ok',
      occurred_at: '2026-09-21T00:00:00.000Z',
    },
    pending: null,
    report_pdf: null,
    ...over,
  };
}

function proposta(over: Partial<EngineTerminalProposalV1> = {}): EngineTerminalProposalV1 {
  return {
    version: 1,
    run_id: '11111111-1111-4111-8111-111111111111',
    request_key: '22222222-2222-4222-8222-222222222222',
    stop: { kind: 'reply', raw_text: 'Seu saldo é R$ 10,00.' },
    iterations: 2,
    observed_tool_call_ids: [],
    usage: USO,
    ...over,
  };
}

describe('EngineResultAssembler — o journal é a fonte', () => {
  it('deriva tools, sumários e ordem dos RECEIPTS, não da proposta', () => {
    // A proposta afirma ordem invertida e uma chamada a mais; nada disso entra.
    const r = assembleTurnResult({
      proposal: proposta({ observed_tool_call_ids: ['c2', 'c1'] }),
      receipts: [
        receipt({ call_id: 'c2', ordinal: 1, tool_name: 'listar_contas' }),
        receipt({ call_id: 'c1', ordinal: 0, tool_name: 'consultar_saldo' }),
      ],
      outboundPrefix: null,
    });
    expect(r.toolsCalled.map((t) => t.name)).toEqual(['consultar_saldo', 'listar_contas']);
    expect(r.toolSummaries.map((s) => s.tool_call_id)).toEqual(['c1', 'c2']);
    expect(r.divergence).toEqual({ kind: 'none' });
  });

  it('chamada AFIRMADA sem receipt é divergência que bloqueia entrega', () => {
    const r = assembleTurnResult({
      proposal: proposta({ observed_tool_call_ids: ['c1', 'fantasma'] }),
      receipts: [receipt({ call_id: 'c1', ordinal: 0 })],
      outboundPrefix: null,
    });
    expect(r.divergence).toEqual({ kind: 'claimed_not_journaled', call_ids: ['fantasma'] });
    expect(divergenceBlocksDelivery(r.divergence)).toBe(true);
  });

  it('receipt sem alegação NÃO bloqueia: o efeito está no journal, que é a fonte', () => {
    const r = assembleTurnResult({
      proposal: proposta({ observed_tool_call_ids: [] }),
      receipts: [receipt({ call_id: 'c1', ordinal: 0, side_effect: 'write' })],
      outboundPrefix: null,
    });
    expect(r.divergence).toEqual({ kind: 'journaled_not_claimed', call_ids: ['c1'] });
    expect(divergenceBlocksDelivery(r.divergence)).toBe(false);
    // …e o efeito continua contando para a decisão de retry.
    expect(r.sideEffectsCommitted).toBe(true);
  });

  it('efeito irreversível vem do side_effect DESPACHADO, mesmo com status error', () => {
    // Uma tool de escrita que falhou ainda pode ter commitado antes de falhar.
    // Usar `status` como gate autorizaria um retry que duplicaria o efeito.
    const r = assembleTurnResult({
      proposal: proposta(),
      receipts: [receipt({ call_id: 'c1', ordinal: 0, side_effect: 'write', status: 'error' })],
      outboundPrefix: null,
    });
    expect(r.sideEffectsCommitted).toBe(true);
  });

  it('leitura pura não marca efeito irreversível', () => {
    const r = assembleTurnResult({
      proposal: proposta(),
      receipts: [receipt({ call_id: 'c1', ordinal: 0, side_effect: 'read' })],
      outboundPrefix: null,
    });
    expect(r.sideEffectsCommitted).toBe(false);
  });

  it('pending e PDF: vence o ÚLTIMO do journal, não o primeiro', () => {
    const r = assembleTurnResult({
      proposal: proposta(),
      receipts: [
        receipt({
          call_id: 'c1',
          ordinal: 0,
          pending: { id: 'p1', opcoes_validas: [{ key: 'a', label: 'A' }] },
        }),
        receipt({
          call_id: 'c2',
          ordinal: 1,
          pending: { id: 'p2', opcoes_validas: [{ key: 'b', label: 'B' }] },
        }),
      ],
      outboundPrefix: null,
    });
    expect(r.latestPending?.id).toBe('p2');
  });

  it('sensitive_tools lista NOMES distintos, não uma entrada por chamada', () => {
    const r = assembleTurnResult({
      proposal: proposta(),
      receipts: [
        receipt({ call_id: 'c1', ordinal: 0, tool_name: 'ver_extrato', sensitive: true }),
        receipt({ call_id: 'c2', ordinal: 1, tool_name: 'ver_extrato', sensitive: true }),
      ],
      outboundPrefix: null,
    });
    expect(r.sensitiveTools).toEqual(['ver_extrato']);
    expect(r.turnHasSensitive).toBe(true);
  });

  it('lacuna de ordinal é reportada, nunca silenciada', () => {
    const r = assembleTurnResult({
      proposal: proposta(),
      receipts: [receipt({ call_id: 'c0', ordinal: 0 }), receipt({ call_id: 'c2', ordinal: 2 })],
      outboundPrefix: null,
    });
    expect(r.missingOrdinals).toEqual([1]);
  });

  it('prefixo de role entra no texto entregue e fica FORA do texto cru', () => {
    // O texto cru alimenta a detecção de lacuna; o anúncio é frase da Maia e
    // dispararia lacuna por conta própria se vazasse para lá ([P88-C4]).
    const r = assembleTurnResult({
      proposal: proposta({ stop: { kind: 'reply', raw_text: 'Não sei.' } }),
      receipts: [],
      outboundPrefix: '[Consultor] ',
    });
    expect(r.candidate).toEqual({ rawText: 'Não sei.', text: '[Consultor] Não sei.' });
  });

  it('desfecho sem texto não produz candidato', () => {
    for (const stop of [
      { kind: 'no_reply', reason: 'iteration_cap' },
      { kind: 'failed', code: 'reasoner_failed' },
      { kind: 'cancelled', reason: 'ownership_lost' },
      { kind: 'reply', raw_text: '' },
    ] as const) {
      const r = assembleTurnResult({
        proposal: proposta({ stop }),
        receipts: [],
        outboundPrefix: null,
      });
      expect(r.candidate).toBeNull();
    }
  });

  it('payload de auditoria da divergência não carrega resultado de tool', () => {
    const d = { kind: 'both' as const, claimed_not_journaled: ['x'], journaled_not_claimed: ['y'] };
    expect(divergenceToAuditPayload(d)).toEqual({
      kind: 'both',
      claimed_not_journaled: ['x'],
      journaled_not_claimed: ['y'],
    });
    expect(divergenceBlocksDelivery(d)).toBe(true);
  });
});
