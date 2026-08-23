/**
 * Regressão do review da PR #566.
 *
 * O reporter classificava prazo estourado lendo só `TestCase.result().errors`,
 * ou seja, só o que acontece DENTRO de um caso. Um `beforeAll` que estoura não
 * produz caso nenhum: o erro fica em `modulo.errors()`, e o bloco de
 * diagnóstico terminava dizendo `prazos estourados: nenhum` e
 * `falhas: nenhuma` numa rodada em que o vitest imprimira `Test Files 1 failed`.
 *
 * A ironia é o motivo de este teste existir: a #545 MOVEU os imports frios para
 * `beforeAll`. Ela criou o modo de falha que o reporter não enxergava.
 *
 * O teste roda um vitest FILHO sobre uma fixture — é a única forma de exercer
 * o reporter de verdade. Afirmar sobre um objeto montado à mão seria espelho:
 * passaria mesmo se o reporter parasse de ser registrado no `vitest.config.ts`.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { arquivoDoPacote } from '../helpers/pkg-path.js';

/**
 * Issue #571 — `resolve('node_modules/vitest/vitest.mjs')` resolvia contra o
 * `process.cwd()`, ou seja `<worktree>/node_modules`, que não existe numa
 * `git worktree` (ela não tem árvore de dependências própria). Este arquivo
 * falhava 4/4 em qualquer worktree. `require.resolve` sobe a árvore de
 * diretórios até o `node_modules` do repositório raiz, que é onde o vitest
 * realmente está. Ver `tests/helpers/pkg-path.ts`.
 */
const VITEST_CLI = arquivoDoPacote('vitest', 'vitest.mjs', import.meta.url);

function rodarVitestFilho(): string {
  try {
    return execFileSync(
      process.execPath,
      [
        VITEST_CLI,
        'run',
        '--config',
        'tests/reporters/fixtures/vitest.fixture.config.ts',
        '--retry',
        '0',
      ],
      { encoding: 'utf8', cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    // O filho SAI 1 — é o esperado, a fixture falha de propósito. O que
    // interessa é o stdout dele.
    const e = err as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
  }
}

describe('diagnostico-reporter — prazo estourado FORA de um caso', () => {
  const saida = rodarVitestFilho();

  it('o bloco NÃO diz "prazos estourados: nenhum" quando um beforeAll estoura', () => {
    expect(
      saida,
      'o reporter voltou a ler prazo só de dentro do caso; um `beforeAll` estourado ' +
        'passou a ser invisível outra vez',
    ).not.toMatch(/prazos estourados: nenhum/);
    expect(saida).toMatch(/PRAZOS ESTOURADOS: \d+/);
  });

  it('o veredito final NÃO diz "falhas: nenhuma" numa rodada que não passou', () => {
    expect(
      saida,
      'o veredito contradiz o `Test Files 1 failed` do vitest — é a leitura falsa ' +
        'que este bloco existe para eliminar',
    ).not.toMatch(/falhas: nenhuma/);
    expect(saida).toMatch(/a rodada NÃO passou/);
  });

  it('o arquivo aparece como não carregado, com o erro de hook', () => {
    expect(saida).toMatch(/ARQUIVOS QUE NÃO CARREGARAM/);
    expect(saida).toMatch(/Hook timed out in \d+ms/);
  });

  it('o detalhe do estouro está DENTRO do bloco PRAZOS ESTOURADOS', () => {
    // O contador do bloco somava os estouros fora de caso mas a lista não os
    // renderizava: `PRAZOS ESTOURADOS: 1` seguido de zero itens. Quem lê
    // procurava o arquivo culpado em outro bloco. Afirmar sobre `saida` inteira
    // não pega isso — o arquivo e o erro aparecem em ARQUIVOS QUE NÃO
    // CARREGARAM de qualquer jeito. A asserção tem que ser sobre a FATIA.
    const bloco = fatiarBlocoDePrazos(saida);
    expect(bloco, 'bloco PRAZOS ESTOURADOS não encontrado na saída').not.toBeNull();
    expect(
      bloco,
      'o contador de PRAZOS ESTOURADOS voltou a contar sem listar: o estouro ' +
        'de hook não aparece dentro do próprio bloco',
    ).toMatch(/Hook timed out in \d+ms/);
    expect(bloco).toMatch(/hook-timeout\.fixture\.ts/);
    expect(bloco).toMatch(/HOOK \(nenhum caso executou\)/);
  });
}, 180_000);

/**
 * Recorta do cabeçalho `PRAZOS ESTOURADOS: N` até o começo do bloco seguinte
 * (`recuperados pela segunda tentativa`), que o reporter sempre emite — em
 * caixa alta quando há itens, em minúscula com "nenhum" quando não há.
 */
function fatiarBlocoDePrazos(saida: string): string | null {
  const inicio = saida.search(/^PRAZOS ESTOURADOS: \d+$/m);
  if (inicio < 0) return null;
  const resto = saida.slice(inicio);
  const fim = resto.search(/^recuperados pela segunda tentativa|^RECUPERADOS PELA SEGUNDA TENTATIVA/m);
  return fim < 0 ? resto : resto.slice(0, fim);
}
