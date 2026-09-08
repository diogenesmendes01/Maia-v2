/**
 * A migration deliberadamente quebrada do drill (#705, item 2) NÃO PODE VAZAR.
 *
 * O item 2 exige provar que uma migration que falha impede o app novo de
 * iniciar, e isso exige uma migration quebrada de verdade. O perigo é óbvio e
 * é o motivo deste arquivo existir: um `.sql` quebrado dentro de `migrations/`
 * entraria no artefato empacotado da imagem, no `migrate status` de todo mundo,
 * no CI, e um dia num deploy de produção.
 *
 * O isolamento escolhido tem três camadas, e as três são medidas aqui:
 *
 *   1. **domicílio** — a fixture mora em
 *      `scripts/drill/705-gate-de-migration/fixtures/`, fora do diretório que
 *      o runner varre. O artefato REAL não a contém;
 *   2. **overlay efêmero** — a fase `quebrar` copia os `.sql` reais mais as
 *      fixtures para um diretório em `os.tmpdir()` e aponta o runner para ele
 *      (`RunnerDeps.migrationsDir` é parâmetro). `migrations/` é só LIDO;
 *   3. **guard de vazamento** — `assertFixtureNaoVazou()` roda antes de tudo e
 *      aborta se algo do drill aparecer em `migrations/`, inclusive renomeado.
 *
 * Sem banco: tudo aqui é disco e função pura.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { discoverMigrations, terminalLedgerStatusFor } from '@/migrations/index.js';
import {
  DIR_FIXTURES,
  MIGRATION_QUEBRADA,
  FixtureVazouError,
  arquivosDoDrill,
  assertFixtureNaoVazou,
  montarOverlay,
} from '../../../scripts/drill-migration-705.js';

const RAIZ = process.cwd();
const MIGRATIONS = join(RAIZ, 'migrations');
const FIXTURES = join(RAIZ, DIR_FIXTURES);

const paraLimpar: string[] = [];
afterEach(async () => {
  while (paraLimpar.length > 0) {
    const d = paraLimpar.pop();
    if (d) await rm(d, { recursive: true, force: true });
  }
});

describe('camada 1 — domicílio: o artefato REAL não conhece a fixture', () => {
  it('`migrations/` não contém nenhum arquivo do drill', async () => {
    const nomes = await readdir(MIGRATIONS);
    for (const proibido of arquivosDoDrill()) expect(nomes).not.toContain(proibido);
    expect(nomes.filter((n) => /drill.{0,3}705/i.test(n))).toEqual([]);
  });

  it('o artefato que o runner descobre em `migrations/` não a inclui', async () => {
    const artefato = await discoverMigrations(MIGRATIONS);
    expect(artefato.byId.has(MIGRATION_QUEBRADA)).toBe(false);
    expect(artefato.migrations.some((m) => /drill.{0,3}705/i.test(m.id))).toBe(false);
  });

  it('o prefixo 900 não colide com nenhuma migration real', async () => {
    const artefato = await discoverMigrations(MIGRATIONS);
    expect(artefato.migrations.filter((m) => m.prefix === '900')).toEqual([]);
    // e ela ordena DEPOIS do head atual, então no overlay ela é a última a rodar
    expect(artefato.head).not.toBeNull();
    expect(MIGRATION_QUEBRADA > (artefato.head as string)).toBe(true);
  });

  it('as duas fixtures existem onde deveriam — forward e `_down` irmã', async () => {
    const nomes = await readdir(FIXTURES);
    expect(nomes.sort()).toEqual([...arquivosDoDrill()].sort());
  });
});

describe('camada 2 — overlay efêmero: `migrations/` é lido, nunca escrito', () => {
  it('monta fora do repositório, com todos os .sql reais + as fixtures', async () => {
    const antes = (await readdir(MIGRATIONS)).sort();

    const overlay = await montarOverlay({
      migrationsDir: MIGRATIONS,
      fixturesDir: FIXTURES,
      baseTmp: tmpdir(),
      raizDoRepo: RAIZ,
    });
    paraLimpar.push(overlay.dir);

    // fora da árvore de trabalho — um overlay sob o repo seria um vazamento
    // com outro nome: `git status` o mostraria e um `git add -A` o commitaria
    expect(resolve(overlay.dir).startsWith(resolve(RAIZ))).toBe(false);

    const noOverlay = (await readdir(overlay.dir)).sort();
    const sqlReais = antes.filter((n) => n.endsWith('.sql'));
    for (const n of sqlReais) expect(noOverlay).toContain(n);
    for (const n of arquivosDoDrill()) expect(noOverlay).toContain(n);
    expect(overlay.copiados).toBe(sqlReais.length);

    // e o diretório real ficou EXATAMENTE como estava
    expect((await readdir(MIGRATIONS)).sort()).toEqual(antes);
  });

  it('no overlay, a migration quebrada é `no-transaction` — logo falha vira `dirty`', async () => {
    const overlay = await montarOverlay({
      migrationsDir: MIGRATIONS,
      fixturesDir: FIXTURES,
      baseTmp: tmpdir(),
      raizDoRepo: RAIZ,
    });
    paraLimpar.push(overlay.dir);

    const artefato = await discoverMigrations(overlay.dir);
    const quebrada = artefato.byId.get(MIGRATION_QUEBRADA);
    expect(quebrada).toBeDefined();
    expect(quebrada?.noTransaction).toBe(true);
    expect(quebrada?.transactionMode).toBe('none');
    // é ESTA classificação que faz a evidência do item 2 ser `dirty` e não
    // `failed` — ver o cabeçalho da própria fixture
    expect(terminalLedgerStatusFor(quebrada!)).toBe('dirty');
    // e ela é a ÚLTIMA da ordem: nenhuma migration real roda depois dela
    expect(artefato.head).toBe(MIGRATION_QUEBRADA);
    // o artefato do overlay é íntegro (down sibling presente, envelope ok)
    expect(artefato.problems).toEqual([]);
  });

  it('recusa montar dentro do repositório', async () => {
    const dentro = join(RAIZ, 'node_modules', '.drill-705-spec');
    await mkdir(dentro, { recursive: true });
    paraLimpar.push(dentro);
    await expect(
      montarOverlay({
        migrationsDir: MIGRATIONS,
        fixturesDir: FIXTURES,
        baseTmp: dentro,
        raizDoRepo: RAIZ,
      }),
    ).rejects.toThrow(/dentro do repositório/);
  });
});

describe('camada 3 — o guard de vazamento', () => {
  it('passa no `migrations/` real', async () => {
    await expect(assertFixtureNaoVazou(MIGRATIONS)).resolves.toBeUndefined();
  });

  it('aborta quando a fixture aparece com o nome original', async () => {
    const falso = await mkdtemp(join(tmpdir(), 'drill-705-vazou-'));
    paraLimpar.push(falso);
    await writeFile(join(falso, MIGRATION_QUEBRADA), '-- vazou\n', 'utf8');

    const erro = await assertFixtureNaoVazou(falso).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(FixtureVazouError);
    expect((erro as FixtureVazouError).code).toBe('DRILL_FIXTURE_VAZOU');
    expect((erro as FixtureVazouError).arquivos).toContain(MIGRATION_QUEBRADA);
  });

  it('aborta também quando alguém a RENOMEIA ao copiar — um vazamento renomeado é um vazamento', async () => {
    const falso = await mkdtemp(join(tmpdir(), 'drill-705-vazou-'));
    paraLimpar.push(falso);
    await writeFile(join(falso, '140_drill_705_copia.sql'), '-- vazou\n', 'utf8');

    await expect(assertFixtureNaoVazou(falso)).rejects.toBeInstanceOf(FixtureVazouError);
  });
});
