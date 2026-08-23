/**
 * Guard do gate do console (#472 parte A — pré-requisito de #604 e #605).
 *
 * O job `admin-ui` de `.github/workflows/ci.yml` é o que faz um `next build`
 * quebrado e uma regressão de runtime do console REPROVAREM a PR. Este arquivo
 * existe porque um gate de CI tem exatamente as mesmas doenças de qualquer
 * outro código — só que a doença aqui é sempre silenciosa:
 *
 *   - alguém marca o passo com `continue-on-error` "só pra destravar" e o
 *     gate vira aviso;
 *   - alguém tira o `--min` do guard de volume e "0 tests" volta a ser verde;
 *   - o bloco de env do build do CI e o do `src/admin-ui/Dockerfile` se
 *     separam, e o CI passa a construir num ambiente que a imagem de produção
 *     não tem (foi assim que o bloco do Dockerfile ficou desatualizado a ponto
 *     de o build da imagem do console estar QUEBRADO sem ninguém notar);
 *   - a quarentena `@pendente-472` cresce em silêncio até o gate medir nada.
 *
 * [declaração]: este arquivo LÊ o workflow, o Dockerfile e as specs. Ele não
 * executa o CI — o que ele impede é o gate ser desarmado por edição.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');
const CI_YML = join(REPO_ROOT, '.github/workflows/ci.yml');
const DOCKERFILE = join(REPO_ROOT, 'src/admin-ui/Dockerfile');
const E2E_DIR = join(REPO_ROOT, 'tests/admin-ui/e2e');

/** A tag como o Playwright a vê: dentro do título de um `test.describe`. */
const TAG_NO_DESCRIBE = /^test\.describe\(.*@pendente-472/m;

const ci = readFileSync(CI_YML, 'utf8');
const dockerfile = readFileSync(DOCKERFILE, 'utf8');

/**
 * Specs e2e que estão FORA do gate. Elas exigem sessão autenticada (o
 * `middleware.ts` redireciona toda rota protegida para /auth/signin) e
 * fixtures que `scripts/seed-proposals-fixtures.ts` não cria — ligá-las é o
 * corpo da issue #472, não este pré-requisito.
 *
 * A lista é FIXA de propósito: entrar ou sair dela tem de ser um diff que
 * alguém lê, não um efeito colateral de marcar mais um `describe`.
 */
const QUARENTENA_472 = [
  'architecture-lock.spec.ts',
  'audit-log.spec.ts',
  'channel-lines-pairing.spec.ts',
  'drift-incidents.spec.ts',
  'inbox.spec.ts',
  'proposal-approval-dual.spec.ts',
  'proposal-approval.spec.ts',
  'proposal-rejection.spec.ts',
  'trace-explorer.spec.ts',
  'versions-rollback.spec.ts',
] as const;

/** Bloco `env:` de um passo do workflow, achado pelo `name:` do passo. */
function envDoPasso(nomeDoPasso: string): Record<string, string> {
  const linhas = ci.split('\n');
  const inicio = linhas.findIndex((l) => l.includes(`- name: ${nomeDoPasso}`));
  if (inicio === -1) throw new Error(`passo não encontrado em ci.yml: ${nomeDoPasso}`);

  const envIdx = linhas.findIndex((l, i) => i > inicio && /^\s*env:\s*$/.test(l));
  const runIdx = linhas.findIndex((l, i) => i > inicio && /^\s*run:/.test(l));
  if (envIdx === -1 || envIdx > runIdx) {
    throw new Error(`passo "${nomeDoPasso}" não tem bloco env: antes do run:`);
  }

  const out: Record<string, string> = {};
  for (let i = envIdx + 1; i < runIdx; i++) {
    const m = /^\s{10}([A-Z][A-Z0-9_]*):\s*(.*)$/.exec(linhas[i]!);
    if (!m) continue; // comentários e continuações
    out[m[1]!] = m[2]!.trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}

/** Bloco `ENV` do estágio `build` do Dockerfile do console. */
function envDoDockerfileBuild(): Record<string, string> {
  const linhas = dockerfile.split('\n');
  const inicio = linhas.findIndex((l) => /^FROM .* AS build$/.test(l.trim()));
  const fim = linhas.findIndex((l, i) => i > inicio && /^FROM /.test(l.trim()));
  expect(inicio, 'estágio `AS build` não encontrado no Dockerfile').toBeGreaterThan(-1);

  const out: Record<string, string> = {};
  for (let i = inicio; i < (fim === -1 ? linhas.length : fim); i++) {
    const m = /^ENV\s+([A-Z][A-Z0-9_]*)=(.*)$/.exec(linhas[i]!);
    if (m) out[m[1]!] = m[2]!.trim();
  }
  return out;
}

describe('[declaração] o job `admin-ui` do CI existe e é bloqueante', () => {
  it('o workflow declara o job e ele roda o build e o e2e do console', () => {
    expect(ci).toMatch(/^ {2}admin-ui:$/m);
    expect(ci).toContain('run: npm run admin:build');
    expect(ci).toContain('run: npm run test:admin-ui:e2e:ci');
  });

  it('nenhum passo do job desarma o gate com continue-on-error', () => {
    // Recorta o job (do cabeçalho dele até o fim do arquivo — é o último) e
    // olha só os passos que PRODUZEM veredito. Os passos de legibilidade
    // (quarentena, relatório) podem e devem ser tolerantes.
    const job = ci.slice(ci.indexOf('\n  admin-ui:'));
    const passosDeVeredito = [
      'run: npm run admin:build',
      'run: test -f src/admin-ui/.next/BUILD_ID',
      'run: npm run db:migrate',
      'run: npm run test:admin-ui:e2e:ci',
    ];
    for (const passo of passosDeVeredito) {
      const idx = job.indexOf(passo);
      expect(idx, `passo sumiu do job: ${passo}`).toBeGreaterThan(-1);
      // O `continue-on-error` de um passo vem ANTES do `run:` dele; procura
      // no trecho entre o `- name:` anterior e este `run:`.
      const inicioDoPasso = job.lastIndexOf('- name:', idx);
      const trecho = job.slice(inicioDoPasso, idx);
      expect(trecho, `passo bloqueante marcado como tolerante: ${passo}`).not.toContain(
        'continue-on-error',
      );
    }
  });

  it('o browser é instalado pelo próprio workflow', () => {
    // No CI o Chromium NÃO vem pronto. Sem este passo o job reprovaria com
    // "Executable doesn't exist" — falha de ambiente disfarçada de falha de
    // teste.
    expect(ci).toContain('npx playwright install --with-deps chromium');
  });

  it('o piso de testes executados está armado (um job com 0 teste é reprovação)', () => {
    const env = envDoPasso('E2E do console (Playwright, projeto `smoke`)');
    const minimo = Number.parseInt(env.TEST_ADMIN_UI_MIN_TESTS ?? '', 10);
    expect(
      Number.isInteger(minimo) && minimo > 0,
      'TEST_ADMIN_UI_MIN_TESTS ausente ou <= 0: sem piso, "Running 0 tests" ' +
        'sai com código 0 e o gate fica verde sem medir nada',
    ).toBe(true);
  });

  it('nenhuma variável do job usa um namespace reservado da Maia por engano', async () => {
    // A armadilha documentada: `ADMIN_UI_`, `MAIA_`, `FEATURE_`, `BACKUP_`,
    // `OWNER_`, ... são namespaces do contrato, e uma chave DESCONHECIDA sob
    // eles reprova o boot de todo processo Maia do job. As que aparecem aqui
    // precisam existir no contrato; as de teste usam prefixo neutro `TEST_`.
    const { isMaiaNamespacedKey, isUnknownMaiaKey } = await Promise.all([
      import('@/config/metadata.js'),
      import('@/config/contract.js'),
    ]).then(([meta, contrato]) => ({
      isMaiaNamespacedKey: meta.isMaiaNamespacedKey,
      isUnknownMaiaKey: contrato.isUnknownMaiaKey,
    }));

    const job = ci.slice(ci.indexOf('\n  admin-ui:'));
    const chaves = [...job.matchAll(/^ {10}([A-Z][A-Z0-9_]*):\s/gm)].map((m) => m[1]!);
    expect(chaves.length, 'nenhuma variável encontrada — a varredura virou no-op').toBeGreaterThan(
      10,
    );

    const desconhecidas = chaves.filter((k) => isMaiaNamespacedKey(k) && isUnknownMaiaKey(k));
    expect(
      desconhecidas,
      `chaves sob namespace da Maia que o contrato não conhece (o boot reprova ` +
        `com contract/unknown): ${desconhecidas.join(', ')}`,
    ).toEqual([]);
  });
});

describe('[declaração] o env de build do CI não pode divergir do Dockerfile', () => {
  it('o bloco do passo de build é exatamente o do estágio `build` da imagem', () => {
    const doCi = envDoPasso('Build do console (next build)');
    const doDocker = envDoDockerfileBuild();

    expect(
      Object.keys(doDocker).length,
      'o estágio build do Dockerfile não tem ENV — a varredura virou no-op',
    ).toBeGreaterThan(10);

    // O CI constrói o console com o MESMO ambiente da imagem de produção. Se
    // divergirem, o CI passa a medir um build que ninguém faz — e foi
    // divergência assim que deixou o build da imagem quebrado por meses.
    expect(doCi).toEqual(doDocker);
  });
});

describe('[declaração] a quarentena `@pendente-472` não cresce em silêncio', () => {
  const arquivos = readdirSync(E2E_DIR).filter((f) => f.endsWith('.spec.ts'));

  it('encontra specs para inspecionar (anti-vacuidade)', () => {
    expect(arquivos.length).toBeGreaterThan(QUARENTENA_472.length);
  });

  it('a lista de arquivos em quarentena é exatamente a declarada', () => {
    // A marca é a TAG no título do `describe` — é o que o `grep`/`grepInvert`
    // do Playwright enxerga. Uma menção ao identificador num comentário (a
    // spec do gate cita a issue) não põe ninguém em quarentena.
    const marcados = arquivos
      .filter((f) => TAG_NO_DESCRIBE.test(readFileSync(join(E2E_DIR, f), 'utf8')))
      .sort();
    expect(
      marcados,
      'entrar ou sair da quarentena tem de ser um diff visível nesta lista, ' +
        'não um efeito colateral de marcar/desmarcar um describe',
    ).toEqual([...QUARENTENA_472].sort());
  });

  it('sobra pelo menos uma spec DENTRO do gate (senão o gate não mede nada)', () => {
    const noGate = arquivos.filter((f) => !QUARENTENA_472.includes(f as never));
    expect(
      noGate,
      'toda spec e2e ficou em quarentena — o projeto `smoke` rodaria vazio',
    ).not.toEqual([]);
  });
});
