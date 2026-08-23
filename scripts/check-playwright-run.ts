#!/usr/bin/env node
/**
 * Guard de VOLUME da rodada Playwright.
 *
 * Por que existe: o Playwright sai com código 0 quando não encontra teste
 * nenhum para executar. Um `--grep` que deixou de casar, um `testDir` que
 * mudou de lugar, um projeto renomeado, um arquivo de spec que sumiu do
 * checkout — todos produzem "Running 0 tests" e um job VERDE. Um gate que
 * fica verde por ausência de trabalho não é um gate.
 *
 * Também reprova teste PULADO: `test.skip`/`describe.skip` (inclusive
 * condicional, do tipo `test.skip(!process.env.X)`) some do log e não some do
 * relatório. Se a infraestrutura obrigatória faltar, o job tem de FALHAR.
 *
 * Uso:
 *   node scripts/check-playwright-run.ts <relatorio.json> [--min N]
 *
 * Escrito só com sintaxe TS apagável e invocado com `node` direto — como
 * `scripts/check-audit-exceptions.ts` — para não depender de `tsx` estar
 * instalado no job que o chama.
 */
import { readFileSync } from 'node:fs';

interface PlaywrightSpecTest {
  readonly results?: readonly { readonly status?: string }[];
  readonly status?: string;
}
interface PlaywrightSpec {
  readonly title?: string;
  readonly tests?: readonly PlaywrightSpecTest[];
}
interface PlaywrightSuite {
  readonly title?: string;
  readonly specs?: readonly PlaywrightSpec[];
  readonly suites?: readonly PlaywrightSuite[];
}
interface PlaywrightReport {
  readonly suites?: readonly PlaywrightSuite[];
  readonly stats?: {
    readonly expected?: number;
    readonly unexpected?: number;
    readonly flaky?: number;
    readonly skipped?: number;
  };
}

function parseArgs(argv: readonly string[]): { file: string; min: number } {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const file = positional[0];
  if (file === undefined) {
    throw new Error('uso: node scripts/check-playwright-run.ts <relatorio.json> [--min N]');
  }
  const minIndex = argv.indexOf('--min');
  const min = minIndex === -1 ? 1 : Number.parseInt(argv[minIndex + 1] ?? '', 10);
  if (!Number.isInteger(min) || min < 1) {
    throw new Error(`--min precisa ser um inteiro >= 1 (recebido: ${String(argv[minIndex + 1])})`);
  }
  return { file, min };
}

/** Títulos completos das specs do relatório — só para a mensagem de erro. */
function collectTitles(suites: readonly PlaywrightSuite[], prefix = ''): string[] {
  const out: string[] = [];
  for (const suite of suites) {
    const here = [prefix, suite.title ?? ''].filter((s) => s.length > 0).join(' › ');
    for (const spec of suite.specs ?? []) {
      out.push([here, spec.title ?? ''].filter((s) => s.length > 0).join(' › '));
    }
    out.push(...collectTitles(suite.suites ?? [], here));
  }
  return out;
}

function main(argv: readonly string[]): void {
  const { file, min } = parseArgs(argv);

  let report: PlaywrightReport;
  try {
    report = JSON.parse(readFileSync(file, 'utf8')) as PlaywrightReport;
  } catch (e) {
    // Relatório ausente/ilegível é FALHA, não "nada a verificar": ele só some
    // quando o runner morreu antes de escrever, e isso é exatamente o caso
    // que este guard tem de denunciar.
    throw new Error(
      `não foi possível ler o relatório Playwright em ${file}: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }

  const stats = report.stats ?? {};
  const esperados = stats.expected ?? 0;
  const inesperados = stats.unexpected ?? 0;
  const flocos = stats.flaky ?? 0;
  const pulados = stats.skipped ?? 0;
  const executados = esperados + inesperados + flocos;

  const problemas: string[] = [];
  if (executados < min) {
    problemas.push(
      `executou ${executados} teste(s), mínimo exigido ${min}. ` +
        `Um relatório vazio significa que o runner não encontrou nada para rodar ` +
        `(grep/projeto/testDir divergiram), NÃO que está tudo certo. ` +
        `Specs no relatório: ${collectTitles(report.suites ?? []).join(', ') || '<nenhuma>'}`,
    );
  }
  if (pulados > 0) {
    problemas.push(
      `${pulados} teste(s) PULADO(s). Skip condicional por infraestrutura ausente ` +
        `é reprovação neste gate: o job precisa falhar, não pular.`,
    );
  }

  const resumo =
    `Playwright: ${executados} executado(s) ` +
    `(${esperados} ok, ${inesperados} falha(s), ${flocos} floco(s)), ${pulados} pulado(s).`;

  if (problemas.length > 0) {
    console.error(`✖ ${resumo}`);
    for (const p of problemas) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`✓ ${resumo}`);
}

try {
  main(process.argv.slice(2));
} catch (e) {
  console.error(`✖ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
