/**
 * #637 (fatia B da épica #471) — a métrica DISCRIMINA?
 *
 * Um teste que só compara pares obviamente idênticos não mede nada: qualquer
 * função que devolva 1 para `x === x` passaria. O que este arquivo afirma é a
 * propriedade que interessa — pares que DEVEM fundir fundem, pares que NÃO
 * devem não fundem —, e os pares negativos vêm de casos reais em que uma única
 * palavra troca a ferramenta (municipal × estadual, entrada × saída, consultar
 * × cancelar).
 *
 * NÃO É ESPELHO: importa `similaridadeDeAssinaturas`, `assinaturaDePedido` e
 * `LIMIAR_SIMILARIDADE` do módulo de PRODUÇÃO, e é a mesma função que o
 * `proposer.ts` chama. Apagar o módulo derruba o arquivo no `beforeAll`.
 */
import { describe, it, expect } from 'vitest';
import { moduloDeProducao } from '../helpers/modulo-de-producao.js';

const sim = moduloDeProducao(() => import('@/cognition/tool-request/similarity.js'));

/** `true` quando a política de produção fundiria os dois textos. */
function funde(a: string, b: string): boolean {
  const m = sim();
  return m.mesmoPedido(m.assinaturaDePedido(a), m.assinaturaDePedido(b)).funde;
}

function score(a: string, b: string): number {
  const m = sim();
  return m.similaridadeDeAssinaturas(m.assinaturaDePedido(a), m.assinaturaDePedido(b));
}

describe('#637 — a assinatura', () => {
  it('é estável sob ordem, acento, caixa e pontuação — e só sob isso', () => {
    const m = sim();
    expect(m.assinaturaDePedido('Emitir GUIA de recolhimento municipal!')).toBe(
      m.assinaturaDePedido('recolhimento, municipal; guia — emitir'),
    );
    expect(m.assinaturaDePedido('emitir guia de recolhimento municipal')).toBe(
      m.assinaturaDePedido('emitir guia de recolhimento municipal'),
    );
    // Mas NÃO é estável sob troca de palavra de conteúdo: se fosse, o limiar
    // não teria o que discriminar.
    expect(m.assinaturaDePedido('emitir guia municipal')).not.toBe(
      m.assinaturaDePedido('emitir guia estadual'),
    );
  });

  it('descarta palavra vazia mas nunca o verbo que dá sentido ao pedido', () => {
    const a = sim().assinaturaDePedido('não consigo emitir a guia de recolhimento');
    expect(a.split(' ')).toContain('emitir');
    expect(a.split(' ')).toContain('guia');
    expect(a.split(' ')).not.toContain('nao');
    expect(a.split(' ')).not.toContain('de');
  });

  it('texto sem token de conteúdo dá assinatura VAZIA, e vazio não funde com vazio', () => {
    const m = sim();
    expect(m.assinaturaDePedido('de a o para com')).toBe('');
    // Dois pedidos indescritíveis NÃO são o mesmo pedido. Se `dice` devolvesse
    // 1 para dois vazios, todo pedido sem conteúdo cairia no mesmo balde — o
    // pior agrupamento possível, e silencioso.
    expect(m.similaridadeDeAssinaturas('', '')).toBe(0);
    expect(funde('de a o', 'para com o')).toBe(false);
  });
});

describe('#637 — o limiar discrimina', () => {
  /** Pares que DEVEM fundir: o mesmo pedido, dito de outro jeito. */
  const DEVEM_FUNDIR: Array<[string, string, string]> = [
    [
      'ordem das palavras',
      'emitir guia de recolhimento municipal',
      'guia de recolhimento municipal, emitir',
    ],
    [
      'moldura de queixa em volta do mesmo pedido',
      'consultar protocolo de atendimento no portal',
      'não consigo consultar o protocolo de atendimento no portal',
    ],
    [
      'acento e caixa',
      'emitir certidão negativa de débitos',
      'EMITIR CERTIDAO NEGATIVA DE DEBITOS',
    ],
    [
      'uma palavra vazia a mais',
      'agendar visita técnica para o cliente',
      'agendar uma visita técnica para o cliente',
    ],
  ];

  it.each(DEVEM_FUNDIR)('funde (%s)', (_nome, a, b) => {
    expect(funde(a, b), `${score(a, b).toFixed(3)} < limiar`).toBe(true);
  });

  /**
   * Pares que NÃO devem fundir. Todos têm alta sobreposição de palavras — é
   * exatamente esse o caso difícil. Um par obviamente distinto ("emitir guia" ×
   * "cancelar assinatura de newsletter") não provaria nada.
   */
  const NAO_DEVEM_FUNDIR: Array<[string, string, string]> = [
    [
      'o discriminador é a última palavra',
      'emitir guia de recolhimento municipal',
      'emitir guia de recolhimento estadual',
    ],
    [
      'verbos opostos, resto idêntico',
      'aprovar proposta de capability pendente',
      'rejeitar proposta de capability pendente',
    ],
    [
      'entrada × saída',
      'registrar nota fiscal de entrada do fornecedor',
      'registrar nota fiscal de saída para o cliente',
    ],
    [
      'a mesma entidade, operações diferentes',
      'consultar saldo da conta corrente',
      'transferir saldo da conta corrente',
    ],
    [
      'subconjunto: o mesmo pedido dito pela metade NÃO funde a 0,85',
      'emitir guia de recolhimento no portal municipal da prefeitura',
      'emitir guia',
    ],
  ];

  it.each(NAO_DEVEM_FUNDIR)('não funde (%s)', (_nome, a, b) => {
    expect(funde(a, b), `${score(a, b).toFixed(3)} >= limiar`).toBe(false);
  });

  it('o pior par que NÃO deve fundir fica abaixo do limiar com margem visível', () => {
    // Não basta "não fundiu": interessa QUANTO abaixo, porque a margem é o que
    // sobrevive a uma redação um pouco diferente. Se este número subir para
    // perto de 0,85, o limiar deixou de ser seguro para este caso.
    const s = score(
      'emitir guia de recolhimento municipal',
      'emitir guia de recolhimento estadual',
    );
    expect(s).toBeLessThan(sim().LIMIAR_SIMILARIDADE);
    expect(s).toBeGreaterThan(0.5); // é um par DIFÍCIL, não um par qualquer
  });

  it('o limiar em vigor é o valor medido, e a métrica declara qual é', () => {
    expect(sim().LIMIAR_SIMILARIDADE).toBe(0.85);
    expect(sim().METRICA_SIMILARIDADE).toBe('dice_token_v1');
    expect(sim().ASSINATURA_VERSION).toBe(1);
  });
});
