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
import { resolve } from 'node:path';

const FIXTURE = 'tests/reporters/fixtures/hook-timeout.fixture.ts';

function rodarVitestFilho(): string {
  try {
    return execFileSync(
      process.execPath,
      [
        resolve('node_modules/vitest/vitest.mjs'),
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
}, 180_000);
