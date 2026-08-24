/**
 * Guarda de deriva entre a tabela de p50/p95/p99 + custo da #534 e o harness
 * que a produziu (`scripts/llm-benchmark.ts`).
 *
 * ## O defeito que esta suíte trava
 *
 * O critério de aceite da #508 não pede "um harness": pede uma TABELA de
 * p50/p95/p99 e custo, antes e depois, **com o harness que a produziu
 * versionado**. As duas metades só valem juntas — um número que ninguém
 * consegue refazer é um número em que ninguém deveria acreditar.
 *
 * E o jeito de essa metade apodrecer em silêncio já está armado no harness:
 * `parseArgs` lê `--flag` por `argv.indexOf` e **não recusa flag desconhecida**.
 * Renomeie `--think-ms` e o comando documentado continua saindo com código 0,
 * imprimindo uma tabela — só que com `think_ms = 0`, que é outra medição. Isso
 * não é hipótese: medido no cenário `recovery`, uma corrida curta demais
 * termina antes de o cooldown expirar e o braço `enforce` sai com 0 sucessos e
 * estado `open`, contra os 263 sucessos e `closed` da linha documentada. O
 * leitor do runbook concluiria "disjuntor preso em aberto" a partir de um
 * comando que o harness aceitou sem reclamar.
 *
 * ## Por que os dois lados são DERIVADOS do fonte
 *
 * Uma lista de flags escrita à mão aqui teria exatamente o problema que ela
 * existe para pegar: derivar do documento, em silêncio. Então as flags vêm de
 * `parseArgs`, os cenários vêm da união `Scenario`, e os rótulos de linha vêm
 * do array de `renderTable` — tudo lido do fonte do harness. O documento é o
 * outro lado da comparação, nunca a fonte.
 *
 * ## O que NÃO se afirma aqui
 *
 * Que os NÚMEROS da tabela continuam valendo: medição contra provider sintético
 * sob concorrência não se repete dígito a dígito, e travar isso num teste
 * transformaria ruído de escalonador em CI vermelho. O que se afirma é que o
 * comando documentado continua sendo um comando que este harness entende, com
 * o cenário que ele conhece, produzindo as linhas que a tabela promete.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');
const HARNESS_PATH = 'scripts/llm-benchmark.ts';
const DOC_PATH = 'docs/architecture/modules/lib.md';

const harness = readFileSync(resolve(ROOT, HARNESS_PATH), 'utf8');
const doc = readFileSync(resolve(ROOT, DOC_PATH), 'utf8');

/** Título exato da seção que carrega o artefato do critério de aceite. */
const SECTION_HEADING = '#### Tabela p50/p95/p99 e custo — antes e depois (DoD da #508)';

/**
 * As quatro grandezas que o critério de aceite NOMEIA. Esta lista é a única
 * coisa escrita à mão no arquivo, e de propósito: ela é a citação do critério,
 * não uma cópia do harness nem do documento. É contra ela que os dois lados são
 * conferidos.
 */
const DOD_ROWS = ['p50 (ms)', 'p95 (ms)', 'p99 (ms)', 'custo (USD)'] as const;

/** A seção do documento, do título dela até o próximo `###`. */
function dodSection(): string {
  const start = doc.indexOf(SECTION_HEADING);
  expect(
    start,
    `\`${DOC_PATH}\` perdeu a seção "${SECTION_HEADING}" — o artefato do critério de aceite da #508`,
  ).toBeGreaterThanOrEqual(0);
  const rest = doc.slice(start + SECTION_HEADING.length);
  const end = rest.indexOf('\n### ');
  return rest.slice(0, end >= 0 ? end : undefined);
}

/** Flags que `parseArgs` de fato lê, do fonte do harness. */
function harnessFlags(): Set<string> {
  const flags = new Set<string>();
  for (const m of harness.matchAll(/\b(?:get|num)\('([a-z0-9-]+)'/g)) flags.add(m[1]!);
  for (const m of harness.matchAll(/argv\.includes\('--([a-z0-9-]+)'\)/g)) flags.add(m[1]!);
  return flags;
}

/** Cenários da união `Scenario`. */
function harnessScenarios(): Set<string> {
  const decl = /type Scenario =([^;]+);/.exec(harness);
  expect(decl, 'a união `Scenario` sumiu do harness').not.toBeNull();
  return new Set([...decl![1]!.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!));
}

/** Rótulos de linha que `renderTable` emite. */
function renderedRowLabels(): Set<string> {
  const start = harness.indexOf('function renderTable(');
  expect(start, '`renderTable` sumiu do harness').toBeGreaterThanOrEqual(0);
  const body = harness.slice(start, harness.indexOf('\n}', start));
  return new Set([...body.matchAll(/\[\s*'([^']+)'\s*,/g)].map((m) => m[1]!));
}

describe('tabela de benchmark da #534 × harness que a produziu', () => {
  it('a seção do critério de aceite existe e cita o harness versionado', () => {
    expect(dodSection()).toContain('npm run llm:bench');
  });

  it('toda flag citada no comando documentado é uma flag que `parseArgs` lê', () => {
    const section = dodSection();
    const commands = section.split('\n').filter((l) => l.trim().startsWith('npm run llm:bench'));
    expect(
      commands.length,
      'a seção não traz nenhum comando `npm run llm:bench` — a tabela deixa de ser reproduzível',
    ).toBeGreaterThan(0);

    const known = harnessFlags();
    const unknown: string[] = [];
    for (const cmd of commands) {
      for (const m of cmd.matchAll(/--([a-z0-9-]+)/g)) {
        if (!known.has(m[1]!)) unknown.push(`${m[0]} em: ${cmd.trim()}`);
      }
    }
    expect(
      unknown,
      `comando documentado usa flag que \`${HARNESS_PATH}\` NÃO lê — ` +
        '`parseArgs` ignora flag desconhecida em silêncio, então o comando roda e mede outra ' +
        `coisa. Flags aceitas: ${[...known].sort().join(', ')}. Ofensores: ${unknown.join(' | ')}`,
    ).toEqual([]);
  });

  it('todo cenário citado na tabela é um cenário que o harness conhece', () => {
    const section = dodSection();
    const known = harnessScenarios();
    const cited = new Set([...section.matchAll(/^\| `([a-z]+)` \|/gm)].map((m) => m[1]!));
    expect(cited.size, 'a tabela da seção não cita cenário nenhum').toBeGreaterThan(0);
    expect(
      [...cited].filter((s) => !known.has(s)),
      `a tabela cita cenário que \`${HARNESS_PATH}\` não conhece — ` +
        `\`parseArgs\` faz cast cego, então o harness rodaria como \`healthy\`. ` +
        `Cenários reais: ${[...known].sort().join(', ')}`,
    ).toEqual([]);
  });

  it('as quatro grandezas do critério de aceite estão na tabela documentada', () => {
    const section = dodSection();
    const missing = DOD_ROWS.filter((r) => !section.includes(r));
    expect(
      missing,
      `a tabela documentada não traz ${missing.join(', ')} — o critério da #508 pede ` +
        'p50/p95/p99 E custo, antes e depois',
    ).toEqual([]);
  });

  it('o harness continua emitindo as quatro grandezas que a tabela promete', () => {
    const rendered = renderedRowLabels();
    const missing = DOD_ROWS.filter((r) => !rendered.has(r));
    expect(
      missing,
      `\`renderTable\` deixou de emitir ${missing.join(', ')} — a tabela de ` +
        `\`${DOC_PATH}\` vira número que ninguém consegue refazer. Linhas emitidas: ` +
        `${[...rendered].sort().join(', ')}`,
    ).toEqual([]);
  });

  it('a tabela traz o ANTES e o DEPOIS, não só um lado', () => {
    const section = dodSection();
    expect(section).toMatch(/antes \(`off`\)/);
    expect(section).toMatch(/depois \(`enforce`\)/);
  });
});
