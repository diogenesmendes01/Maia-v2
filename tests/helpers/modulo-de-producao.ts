/**
 * Carga de grafo de produção fora do orçamento do teste — issue #545.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O problema que este helper existe para eliminar
 * ─────────────────────────────────────────────────────────────────────────
 * O padrão dominante nas specs deste repo é `await import()` do módulo de
 * produção DENTRO do `it()`. Medido (4 vCPU, arquivo isolado, cache de
 * transform frio, corpo de teste vazio):
 *
 *   import('@/gateway/baileys.js')   5.77s · 6.40s · 6.64s · 6.83s
 *   import('@/agent/core.js')        6.38s · 6.60s
 *   import('@/db/repositories.js')   1.92s · 2.47s
 *
 * O trabalho real desses mesmos testes, medido no 2º..Nº caso do MESMO
 * arquivo (módulo já em cache), fica entre 1ms e 43ms. Ou seja: o primeiro
 * caso de cada arquivo gastava ~99% do orçamento carregando infraestrutura, e
 * o que sobrava para o teste era ruído de medição.
 *
 * Isso produz DOIS defeitos, e o segundo é o pior:
 *
 *  1. **Vermelho por prazo de import.** O custo depende de o arquivo ter sido
 *     agendado cedo (cache de transform frio) ou tarde (quente), então o
 *     vermelho é loteria de ordenação — muda de arquivo a cada rodada.
 *
 *  2. **Corpo órfão.** O timeout do vitest NÃO aborta o corpo async. A
 *     tentativa que estourou continua rodando e disputa mocks, linhas no banco
 *     e estado de módulo com o que vier depois. A falha que aparece no
 *     relatório é a secundária — `expected "vi.fn()" to be called 1 times, but
 *     got 2 times`, `duplicate key value violates unique constraint` —, nunca
 *     a causa.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O que o helper faz, e por que isto resolve (2) e não só (1)
 * ─────────────────────────────────────────────────────────────────────────
 * Ele registra um `beforeAll` que carrega o módulo uma única vez por arquivo,
 * e devolve um acessor síncrono para os casos usarem.
 *
 * O ganho contra (1) é o óbvio: hook tem orçamento próprio (`hookTimeout`).
 *
 * O ganho contra (2) é o que importa: se o carregamento estourar o prazo, quem
 * estoura é o `beforeAll` — e um `beforeAll` que falha REPROVA os casos do
 * arquivo SEM EXECUTÁ-LOS. Não existe segunda tentativa competindo com um
 * corpo órfão pelo mesmo estado, porque não existe corpo nenhum rodando. O
 * modo de falha ilegível deixa de ser possível para o custo de import, que é
 * de onde ele vinha.
 *
 * O corpo do caso passa a medir o caso. É isso que faz a lista de "mais
 * lentos" do `tests/reporters/diagnostico-reporter.ts` significar alguma coisa.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Quando NÃO usar
 * ─────────────────────────────────────────────────────────────────────────
 * Quando a spec depende de recarregar o módulo por caso — `vi.resetModules()`
 * no `beforeEach`, ou `vi.doMock()` variando entre casos. Aí o import é parte
 * do que o teste exercita e tem que ficar no corpo (com prazo explícito no
 * caso, se for caro).
 *
 * Uso:
 *
 *   const core = moduloDeProducao(() => import('../../src/agent/core.js'));
 *
 *   it('...', async () => {
 *     await core().runAgentForMensagem('in1');
 *   });
 */
import { beforeAll } from 'vitest';

/**
 * Registra o `beforeAll` que carrega `carregar()` uma vez por arquivo e
 * devolve o acessor síncrono do módulo já carregado.
 *
 * Precisa ser chamado no escopo de coleta (topo do arquivo ou dentro de um
 * `describe`), como qualquer hook do vitest.
 */
export function moduloDeProducao<T>(carregar: () => Promise<T>): () => T {
  let modulo: T | undefined;
  let falha: unknown;

  beforeAll(async () => {
    try {
      modulo = await carregar();
    } catch (err) {
      // Guardar e relançar: o `beforeAll` continua reprovando o arquivo (que é
      // o comportamento certo), e o acessor também tem o que dizer caso alguém
      // o chame fora de um caso.
      falha = err;
      throw err;
    }
  });

  return () => {
    if (modulo === undefined) {
      throw new Error(
        'moduloDeProducao(): o módulo não foi carregado. ' +
          'O acessor só é válido depois do `beforeAll` deste arquivo — ' +
          'não o chame no escopo de coleta nem em outro `beforeAll` que corra antes. ' +
          (falha ? `Causa do carregamento: ${String(falha)}` : ''),
      );
    }
    return modulo;
  };
}
