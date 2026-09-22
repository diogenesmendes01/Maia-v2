/**
 * P10 (spec §7.9.2) — `knowledge_proposal` no inbox unificado.
 *
 * `knowledge_proposal` era tipo DECLARADO e fonte VAZIA: `countersByType` o
 * listava com zero e a fila nunca produzia uma linha dele. O efeito, depois do
 * G1, é o que importa: itens nascendo em `pending_review` ficavam num estado
 * sem porta — ninguém os via, ninguém os decidia, e a fila de revisão que o
 * `LearningService` passou a alimentar não tinha para onde crescer.
 *
 * Este arquivo prende as duas pontas da correção: o risco projetado na fila e
 * a exigência de saber QUAL tabela decidir.
 */
import { describe, it, expect } from 'vitest';
import { riscoDaUltimaTransicao } from '@/db/repositories/admin-repos.js';

describe('riscoDaUltimaTransicao — risco REGISTRADO, não recalculado', () => {
  it('lê o nível da última transição que o carrega', () => {
    expect(
      riscoDaUltimaTransicao([
        { from: 'proposed', to: 'pending_review', risk_score: { level: 'medium' } },
      ]),
    ).toBe('medium');
  });

  it('a ÚLTIMA vence quando há várias', () => {
    expect(
      riscoDaUltimaTransicao([{ risk_score: { level: 'low' } }, { risk_score: { level: 'high' } }]),
    ).toBe('high');
  });

  it('ignora transições sem risco e continua procurando para trás', () => {
    expect(riscoDaUltimaTransicao([{ risk_score: { level: 'low' } }, { from: 'a', to: 'b' }])).toBe(
      'low',
    );
  });

  it('sem registro legível, `critical`', () => {
    // É o lado que exige a assinatura mais forte. Um default baixo faria uma
    // leitura falha virar aprovação mais fácil.
    for (const entrada of [null, undefined, [], 'nada', [{ risk_score: { level: 'zzz' } }]]) {
      expect(riscoDaUltimaTransicao(entrada), JSON.stringify(entrada)).toBe('critical');
    }
  });

  it('NÃO recalcula a partir do conteúdo', () => {
    // O scorer decidiu quando o item nasceu. Refazer a conta aqui daria outro
    // número para o MESMO item conforme o texto do modelo mudasse de versão, e
    // a fila mostraria risco oscilando sem nada ter acontecido.
    const transicoes = [{ risk_score: { level: 'low' } }];
    expect(riscoDaUltimaTransicao(transicoes)).toBe('low');
    expect(riscoDaUltimaTransicao(transicoes)).toBe('low');
  });
});
