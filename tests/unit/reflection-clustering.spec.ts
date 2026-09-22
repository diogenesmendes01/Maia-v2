import { describe, it, expect } from 'vitest';
import {
  clusterCorrections,
  clusterDedupeKey,
  type CorrectionSignal,
  normalizeDescricao,
} from '../../src/agent/reflection-clustering.js';

describe('reflection-clustering — normalizeDescricao', () => {
  it('strips accents and lowercases', () => {
    expect(normalizeDescricao('Almoço Café')).toBe('almoco cafe');
  });

  it('drops stopwords and digits', () => {
    expect(normalizeDescricao('pagamento de aluguel 2026')).toBe('pagamento aluguel');
  });

  it('truncates to first 4 significant tokens', () => {
    expect(normalizeDescricao('uber transporte trabalho centro casa volta')).toBe(
      'uber transporte trabalho centro',
    );
  });

  it('returns empty string for empty input', () => {
    expect(normalizeDescricao('')).toBe('');
  });

  it('returns empty string when input is only stopwords and digits', () => {
    expect(normalizeDescricao('de da 2026 1234')).toBe('');
  });
});

/**
 * G1 (spec §7.6.1 item 2) — o agrupamento passou a ter DONO.
 *
 * A chave era só a descrição normalizada. Duas correções com a mesma descrição
 * feitas sobre dados de PESSOAS DIFERENTES caíam no mesmo cluster, e a regra
 * proposta a partir dele misturava titulares. A spec é literal: "Mesma
 * descrição em A/B não funde clusters."
 */
function sinal(over: Partial<CorrectionSignal> & { descricao: string }): CorrectionSignal {
  return {
    alvo_id: null,
    contexto: {},
    source_event_id: `ev-${over.descricao}-${over.data_subject_ref ?? 'x'}`,
    occurred_at: '2026-09-21T00:00:00.000Z',
    actor_pessoa_id: 'operador-1',
    data_subject_ref: 'titular-A',
    conversa_id: null,
    purpose: null,
    authorized_resource: null,
    ...over,
  };
}

describe('reflection-clustering — clusterCorrections', () => {
  it('agrupa correções com a mesma descrição normalizada do MESMO titular', () => {
    const { clusters } = clusterCorrections([
      sinal({ alvo_id: 'a', descricao: 'Uber Trip' }),
      sinal({ alvo_id: 'b', descricao: 'uber trip' }),
      sinal({ alvo_id: 'c', descricao: 'Almoço' }),
    ]);
    expect(clusters).toHaveLength(2);
    const uber = clusters.find((c) => c.descricao_normalized === 'uber trip');
    expect(uber?.signals).toHaveLength(2);
  });

  it('MESMA descrição de titulares DIFERENTES não funde', () => {
    // O defeito que esta fatia fecha: a regra proposta a partir de um cluster
    // misturado seria derivada de dados de duas pessoas.
    const { clusters } = clusterCorrections([
      sinal({ descricao: 'uber trip', data_subject_ref: 'titular-A' }),
      sinal({ descricao: 'uber trip', data_subject_ref: 'titular-B' }),
    ]);
    expect(clusters).toHaveLength(2);
    expect(new Set(clusters.map((c) => c.data_subject_ref))).toEqual(
      new Set(['titular-A', 'titular-B']),
    );
  });

  it('finalidades diferentes também não fundem', () => {
    const { clusters } = clusterCorrections([
      sinal({ descricao: 'uber trip', purpose: 'suporte' }),
      sinal({ descricao: 'uber trip', purpose: 'cobranca' }),
    ]);
    expect(clusters).toHaveLength(2);
  });

  it('ordena clusters por quantidade de sinais, decrescente', () => {
    const { clusters } = clusterCorrections([
      sinal({ alvo_id: '1', descricao: 'mercado dia' }),
      sinal({ alvo_id: '2', descricao: 'mercado dia' }),
      sinal({ alvo_id: '3', descricao: 'mercado dia' }),
      sinal({ alvo_id: '4', descricao: 'pix joao' }),
    ]);
    expect(clusters[0]?.signals).toHaveLength(3);
    expect(clusters[1]?.signals).toHaveLength(1);
  });

  it('descrição vazia vai para quarentena, não some', () => {
    const { clusters, quarantined } = clusterCorrections([
      sinal({ alvo_id: '1', descricao: '12 34' }),
      sinal({ alvo_id: '2', descricao: 'real one' }),
    ]);
    expect(clusters).toHaveLength(1);
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]?.reason).toBe('empty_descricao');
  });

  it('titular NÃO demonstrável vai para quarentena — nunca vira cluster', () => {
    // §7.6.1 item 1: "se não for demonstrável, quarentena". Usar o ator como
    // titular seria a presunção que a spec proíbe nominalmente.
    const { clusters, quarantined } = clusterCorrections([
      sinal({ descricao: 'uber trip', data_subject_ref: null, actor_pessoa_id: 'operador-1' }),
    ]);
    expect(clusters).toHaveLength(0);
    expect(quarantined[0]?.reason).toBe('subject_not_demonstrable');
  });
});

describe('clusterDedupeKey — inclui titular e fontes', () => {
  it('mesma descrição de titulares diferentes produz chaves diferentes', () => {
    const [a] = clusterCorrections([sinal({ descricao: 'uber', data_subject_ref: 'A' })]).clusters;
    const [b] = clusterCorrections([sinal({ descricao: 'uber', data_subject_ref: 'B' })]).clusters;
    expect(clusterDedupeKey(a!, 'learned_rule')).not.toBe(clusterDedupeKey(b!, 'learned_rule'));
  });

  it('evidência NOVA produz chave nova — não é colapsada', () => {
    // Dois clusters com a mesma descrição e fontes diferentes são propostas
    // diferentes; colapsá-los esconderia evidência.
    const [um] = clusterCorrections([
      sinal({ descricao: 'uber', source_event_id: 'ev-1' }),
    ]).clusters;
    const [dois] = clusterCorrections([
      sinal({ descricao: 'uber', source_event_id: 'ev-1' }),
      sinal({ descricao: 'uber', source_event_id: 'ev-2' }),
    ]).clusters;
    expect(clusterDedupeKey(um!, 'learned_rule')).not.toBe(clusterDedupeKey(dois!, 'learned_rule'));
  });
});
