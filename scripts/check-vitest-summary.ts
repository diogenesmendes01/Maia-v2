#!/usr/bin/env node
/**
 * Guard de VOLUME da rodada Vitest — o análogo de
 * `scripts/check-playwright-run.ts` para as suítes de backend.
 *
 * Por que existe: o vitest sai com código 0 quando não encontra teste nenhum
 * para executar. Um filtro que deixou de casar, um `testDir` movido, um
 * `describe.skip` no topo do arquivo, uma variável de ambiente ausente que
 * desliga a suíte inteira — todos produzem um job VERDE sobre trabalho
 * nenhum. Foi exatamente o que aconteceu com o e2e de backend: o job
 * `integration + e2e` rodava `vitest run tests/e2e` contra um único arquivo
 * cujo `describe` estava com `.skip` HARDCODED e cujos três corpos eram
 * comentários. Verde, por anos, sobre zero asserção.
 *
 * `pulado` não é `passou`. `executados=0 falharam=0` não é verde: é ausência
 * de evidência apresentada como evidência de ausência.
 *
 * Este guard lê o resumo que `tests/reporters/diagnostico-reporter.ts` grava
 * em `VITEST_SUMMARY_FILE` e reprova quando:
 *
 *   1. `executados` < o piso exigido (`--min`, default 1);
 *   2. o resumo traz a seção ARQUIVOS QUE NÃO CARREGARAM / ERROS FORA DE
 *      TESTE — um arquivo que não coletou não tem caso nenhum contado em
 *      `executados`, então `falharam=0` sobre o resto é leitura falsa;
 *   3. o arquivo não existe ou não casa o formato esperado — some quando o
 *      runner morreu antes de escrever, que é justamente o caso a denunciar.
 *
 * `pulados` NÃO reprova por si só: as specs de integração fazem
 * `describe.skip` legítimo sem `TEST_DB_URL`, e um piso de zero pulados aqui
 * quebraria o uso local. O piso que importa é o de EXECUTADOS.
 *
 * Uso:
 *   node scripts/check-vitest-summary.ts <resumo.txt> [--min N] [--rotulo X]
 *
 * Escrito só com sintaxe TS apagável e invocado com `node` direto — como
 * `scripts/check-playwright-run.ts` e `scripts/check-audit-exceptions.ts` —
 * para não depender de `tsx` no job que o chama.
 */
import { readFileSync } from 'node:fs';

/** A linha de contadores do reporter: `executados=N  falharam=N  pulados=N`. */
const RE_CONTADORES = /executados=(\d+)\s+falharam=(\d+)\s+pulados=(\d+)/;
const RE_NAO_CARREGARAM = /^ARQUIVOS QUE NÃO CARREGARAM \/ ERROS FORA DE TESTE: /m;

interface Args {
  file: string;
  min: number;
  rotulo: string;
}

function parseArgs(argv: readonly string[]): Args {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const file = positional[0];
  if (file === undefined) {
    throw new Error(
      'uso: node scripts/check-vitest-summary.ts <resumo.txt> [--min N] [--rotulo X]',
    );
  }
  const iMin = argv.indexOf('--min');
  const min = iMin === -1 ? 1 : Number.parseInt(argv[iMin + 1] ?? '', 10);
  if (!Number.isInteger(min) || min < 1) {
    throw new Error(`--min precisa ser um inteiro >= 1 (recebido: ${String(argv[iMin + 1])})`);
  }
  const iRot = argv.indexOf('--rotulo');
  const rotulo = iRot === -1 ? file : (argv[iRot + 1] ?? file);
  return { file, min, rotulo };
}

function main(argv: readonly string[]): void {
  const { file, min, rotulo } = parseArgs(argv);

  let texto: string;
  try {
    texto = readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(
      `não foi possível ler o resumo de testes em ${file}: ` +
        `${e instanceof Error ? e.message : String(e)}. ` +
        `O resumo só some quando o runner morreu antes de escrevê-lo — ` +
        `ausência de resumo é FALHA, não "nada a verificar".`,
      { cause: e },
    );
  }

  const m = RE_CONTADORES.exec(texto);
  if (m === null) {
    throw new Error(
      `o resumo em ${file} não traz a linha de contadores ` +
        `(\`executados=N  falharam=N  pulados=N\`). Ou o reporter ` +
        `\`tests/reporters/diagnostico-reporter.ts\` mudou de formato e este ` +
        `guard ficou cego, ou o arquivo não é um resumo de rodada. ` +
        `Nos dois casos: FALHA.`,
    );
  }

  const executados = Number.parseInt(m[1] ?? '', 10);
  const falharam = Number.parseInt(m[2] ?? '', 10);
  const pulados = Number.parseInt(m[3] ?? '', 10);

  const problemas: string[] = [];
  if (executados < min) {
    problemas.push(
      `executou ${executados} caso(s), mínimo exigido ${min}. ` +
        `Um resumo com executados=0 significa que o runner não encontrou ` +
        `trabalho (filtro, diretório ou \`.skip\` no topo), NÃO que está ` +
        `tudo certo. ${pulados} caso(s) pulado(s) nesta rodada — pulado não é passou.`,
    );
  }
  if (RE_NAO_CARREGARAM.test(texto)) {
    problemas.push(
      `o resumo traz a seção ARQUIVOS QUE NÃO CARREGARAM / ERROS FORA DE ` +
        `TESTE. Nenhum caso desses arquivos entrou em \`executados\`, então ` +
        `\`falharam=${falharam}\` não cobre o que eles teriam achado.`,
    );
  }

  const resumo =
    `${rotulo}: ${executados} executado(s), ${falharam} falha(s), ${pulados} pulado(s) ` +
    `(piso ${min}).`;

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
