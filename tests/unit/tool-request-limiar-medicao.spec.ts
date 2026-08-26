/**
 * #637 (fatia B da épica #471) — A MEDIÇÃO, EXECUTÁVEL.
 *
 * O critério de pronto da issue exige "o limiar escolhido, com a medição que o
 * sustenta — não um número redondo escolhido por gosto". Uma tabela colada num
 * comentário envelhece em silêncio: o catálogo de tools cresce, o pior par
 * negativo muda, e o número continua lá parecendo medido.
 *
 * Este arquivo é a medição rodando contra o catálogo VIVO
 * (`src/admin-ui/generated/tool-catalog.ts`, artefato committado e mantido em
 * dia por `tests/unit/tool-catalog-drift.spec.ts`), com a MESMA função de
 * similaridade que decide em produção.
 *
 * QUANDO ELE FICAR VERMELHO, ELE ESTÁ CERTO. Uma tool nova cuja descrição
 * empurre o pior par negativo acima de 0,85 significa que o limiar deixou de
 * separar — e o desfecho tem de ser um vermelho no CI, não dois pedidos
 * distintos fundidos em produção. O conserto é rodar
 * `npx tsx scripts/medir-limiar-tool-request.ts` e re-decidir o número.
 *
 * NÃO É ESPELHO: as funções vêm de `scripts/medir-limiar-tool-request.ts` (que
 * por sua vez importa a similaridade de produção). Apagar qualquer um dos dois
 * derruba o arquivo no `beforeAll`.
 */
import { describe, it, expect } from 'vitest';
import { moduloDeProducao } from '../helpers/modulo-de-producao.js';
import { TOOL_CATALOG } from '@/admin-ui/generated/tool-catalog.js';

const medicao = moduloDeProducao(() => import('../../scripts/medir-limiar-tool-request.js'));
const sim = moduloDeProducao(() => import('@/cognition/tool-request/similarity.js'));

const GRADE = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95];

describe('#637 — a medição que sustenta o limiar', () => {
  it('o conjunto negativo é REAL e grande o bastante para significar alguma coisa', () => {
    const { negativos, positivos } = medicao().construirCorpus();
    // C(n,2) sobre o catálogo. O rótulo não é opinião: duas tools distintas no
    // catálogo committado são duas coisas que o projeto já decidiu separar.
    expect(negativos.length).toBeGreaterThan(1500);
    expect(negativos.every((p) => p.mesmo === false)).toBe(true);
    // Os positivos são SINTÉTICOS e isso está declarado no script; aqui o teste
    // afirma que são EXATAMENTE uma paráfrase por perturbação por tool — se uma
    // perturbação sumir sem ninguém notar, o recall da tabela muda de
    // significado e a medição passa a comparar coisas diferentes.
    expect(positivos.length).toBe(medicao().PERTURBACOES.length * TOOL_CATALOG.length);
    expect(positivos.every((p) => p.mesmo === true)).toBe(true);
    // E o número de negativos é C(n,2) sobre o MESMO catálogo — nenhum par
    // ficou de fora.
    const n = TOOL_CATALOG.length;
    expect(negativos.length).toBe((n * (n - 1)) / 2);
  });

  it('NO LIMIAR EM VIGOR não há UMA falsa fusão no conjunto negativo real', () => {
    const { negativos } = medicao().construirCorpus();
    const fundidos = negativos.filter(
      (p) => medicao().scoreDoPar(p) >= sim().LIMIAR_SIMILARIDADE,
    );
    expect(
      fundidos.map((p) => `${p.a} ~ ${p.b} = ${medicao().scoreDoPar(p).toFixed(3)}`),
      'o limiar deixou de separar: rode `npx tsx scripts/medir-limiar-tool-request.ts` e re-decida o número',
    ).toEqual([]);
  });

  it('o limiar em vigor É o menor da grade com zero falsas fusões (a regra de decisão)', () => {
    const { negativos, positivos } = medicao().construirCorpus();
    const linhas = medicao().varrer(negativos, positivos, GRADE);
    expect(medicao().menorLimiarSeguro(linhas)).toBe(sim().LIMIAR_SIMILARIDADE);
  });

  it('o vizinho de baixo é PIOR de verdade — o número não é arbitrário', () => {
    // Sem este caso, 0,85 poderia ser um valor redondo com uma tabela ao lado.
    // Aqui a tabela é interrogada: em 0,80 existe pelo menos uma fusão que o
    // catálogo diz que está errada.
    const { negativos, positivos } = medicao().construirCorpus();
    const [emOitenta] = medicao().varrer(negativos, positivos, [0.8]);
    expect(emOitenta!.falsas_fusoes).toBeGreaterThan(0);
  });

  it('o vizinho de cima não compra segurança e custa recall — por isso não subimos', () => {
    const { negativos, positivos } = medicao().construirCorpus();
    const [aqui, acima] = medicao().varrer(negativos, positivos, [
      sim().LIMIAR_SIMILARIDADE,
      0.9,
    ]);
    expect(aqui!.falsas_fusoes).toBe(0);
    expect(acima!.falsas_fusoes).toBe(0); // nada a ganhar
    expect(acima!.recall).toBeLessThan(aqui!.recall); // e algo a perder
  });

  it('a curva é monótona: subir o limiar nunca aumenta falsa fusão nem recall', () => {
    // Se isto quebrar, a métrica não é um score comparável e a tabela inteira
    // perde sentido — inclusive a regra "o menor θ seguro".
    const { negativos, positivos } = medicao().construirCorpus();
    const linhas = medicao().varrer(negativos, positivos, GRADE);
    for (let i = 1; i < linhas.length; i += 1) {
      expect(linhas[i]!.falsas_fusoes).toBeLessThanOrEqual(linhas[i - 1]!.falsas_fusoes);
      expect(linhas[i]!.recall).toBeLessThanOrEqual(linhas[i - 1]!.recall);
    }
  });

  it('o custo do limiar está registrado: nem todo positivo sintético funde', () => {
    // A honestidade do número passa por dizer o que ele custa. Se um dia TODOS
    // os positivos fundirem no limiar em vigor, ou a métrica melhorou muito ou
    // as perturbações ficaram triviais — e nos dois casos a medição precisa ser
    // relida antes de continuar valendo.
    const { negativos, positivos } = medicao().construirCorpus();
    const [aqui] = medicao().varrer(negativos, positivos, [sim().LIMIAR_SIMILARIDADE]);
    expect(aqui!.recall).toBeGreaterThan(0.5);
    expect(aqui!.recall).toBeLessThan(1);
  });
});
