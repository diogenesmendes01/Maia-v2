/**
 * Issue #574 — `GHSA-67mh-4wv8-2f99` (esbuild dev-server) não pode voltar aos
 * lockfiles.
 *
 * O que este arquivo tranca, e por que ele NÃO é o teste óbvio
 * ------------------------------------------------------------
 * O teste óbvio seria "`package.json` diz `drizzle-kit@^0.31.x`". Ele seria
 * VACUOSO: subir a faixa declarada não remove o advisory. Medido nesta issue,
 * numa árvore limpa com `drizzle-kit@0.31.10` e mais nada:
 *
 *   drizzle-kit@0.31.10
 *   +-- @esbuild-kit/esm-loader@2.6.5
 *   |   +-- @esbuild-kit/core-utils@3.3.2
 *   |       +-- esbuild@0.18.20        ← DENTRO da faixa vulnerável (<=0.24.2)
 *   +-- esbuild@0.25.12                ← fora da faixa
 *
 *   4 moderate severity vulnerabilities
 *
 * O major conserta a cópia que o drizzle-kit REALMENTE usa (`^0.19.7` →
 * `^0.25.4`) e não toca na outra: `@esbuild-kit/esm-loader` continua declarado
 * em `dependencies` do drizzle-kit 0.31.10 mesmo sem NENHUMA referência a ele
 * no código publicado — `grep -rl esbuild-kit node_modules/drizzle-kit` casa só
 * com o `package.json`. É dependência vestigial, e é ela que segura o
 * `esbuild@0.18.20`.
 *
 * Por isso o conserto tem DUAS partes, e as duas são carregadas:
 *   1. `drizzle-kit` no major `^0.31.10`;
 *   2. o `overrides` de `@esbuild-kit/core-utils → esbuild: ^0.25.4`, que
 *      dedupa a cópia vestigial na `esbuild` de topo.
 *
 * Remover a parte 2 devolve `esbuild@0.18.20` ao lockfile e o advisory volta —
 * verificado removendo a linha e regenerando o lockfile. Este spec existe para
 * que essa remoção reprove OFFLINE, em vez de esperar o job `dependency-audit`
 * (que precisa do registry para consultar o banco de advisories).
 *
 * Por que a política é CONDICIONAL (revisão do PR #594)
 * ----------------------------------------------------
 * A primeira versão deste arquivo afirmava duas coisas soltas: "não existe
 * cópia aninhada sob `@esbuild-kit/core-utils`" e "o override continua
 * declarado". As duas ficavam VERDES no dia em que um update do `drizzle-kit`
 * removesse `@esbuild-kit/esm-loader` da árvore: sem a cadeia não há cópia
 * aninhada (primeira asserção vacuamente verde) e o override continuaria
 * exigido (segunda asserção verde com um override ÓRFÃO). O teste fixava o
 * workaround para sempre em vez de avisar quando o upstream o tornasse
 * desnecessário — e o Dependabot da raiz, que enxerga `drizzle-kit`, não teria
 * nenhum gate pedindo a limpeza.
 *
 * A política agora depende da presença da cadeia, e as DUAS direções reprovam:
 *
 *   cadeia PRESENTE  → o override tem de existir (na forma exata) E a
 *                      resolução EFETIVA de `esbuild` sob `@esbuild-kit/
 *                      core-utils` tem de estar fora da faixa vulnerável;
 *   cadeia AUSENTE   → o override tem de ter sumido junto.
 *
 * "Resolução efetiva" é literal: se existe cópia aninhada
 * (`.../@esbuild-kit/core-utils/node_modules/esbuild`), é ela que vale; se não
 * existe, `@esbuild-kit/core-utils` foi deduplicado na `esbuild` de topo e é
 * a versão de topo que vale. Aferir "não há cópia aninhada" não é a mesma
 * coisa: uma árvore sem `node_modules/esbuild` nenhum passaria.
 *
 * A sonda que prova as duas direções está versionada aqui como os casos de
 * `avaliarPoliticaDoOverride` sobre lockfiles sintéticos — não como relato.
 *
 * O que ele NÃO prova
 * -------------------
 * Nada sobre migrations. Lockfile íntegro não diz que `drizzle-kit generate`
 * produz SQL aplicável — quem prova isso é `scripts/probe-drizzle-kit.ts`
 * (`npm run probe:drizzle-kit`), que roda o binário local contra um banco
 * descartável no job `drizzle-kit-roundtrip` do CI.
 * E ele afere a faixa de versão RESOLVIDA, não o conteúdo do tarball.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = process.cwd();

/** Os dois lockfiles que o job `dependency-audit` audita (scripts/check-audit-exceptions.ts). */
const LOCKFILES: readonly string[] = ['package-lock.json', 'src/admin-ui/package-lock.json'];

/**
 * Os pares (manifesto, lockfile) sobre os quais a política do override roda.
 * `src/admin-ui` entra mesmo sem ter a cadeia hoje: é exatamente o caso
 * "cadeia ausente" e, se alguém colar o override lá por engano, ele reprova.
 */
const PARES: readonly { readonly pkg: string; readonly lock: string }[] = [
  { pkg: 'package.json', lock: 'package-lock.json' },
  { pkg: 'src/admin-ui/package.json', lock: 'src/admin-ui/package-lock.json' },
];

/**
 * Teto vulnerável do advisory, copiado do `range` que o `npm audit` reporta
 * para `GHSA-67mh-4wv8-2f99`: `<=0.24.2`.
 */
const VULNERABLE_MAX: readonly [number, number, number] = [0, 24, 2];

/** Pacote deprecado que segura a cópia vestigial, e chave do override que o corrige. */
const PACOTE_DA_CADEIA = '@esbuild-kit/core-utils';

/** Forma exata exigida do override enquanto a cadeia existir. */
const OVERRIDE_ESPERADO = { esbuild: '^0.25.4' } as const;

interface LockEntry {
  version?: string;
}

interface Lockfile {
  packages: Record<string, LockEntry>;
}

interface Manifest {
  overrides?: Record<string, unknown>;
}

function readJson(relPath: string): unknown {
  return JSON.parse(readFileSync(join(REPO_ROOT, relPath), 'utf8'));
}

/**
 * Compara `x.y.z` numericamente. Sufixo de pré-lançamento é ignorado de
 * propósito: nenhuma das cópias em jogo usa um, e tratá-lo aqui só
 * acrescentaria caminho sem teste.
 */
function compareVersions(a: string, b: readonly [number, number, number]): number {
  const parts = a.split('-')[0]?.split('.') ?? [];
  for (let i = 0; i < 3; i += 1) {
    const left = Number(parts[i] ?? 0);
    const right = b[i] ?? 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

function ehVulneravel(version: string): boolean {
  return compareVersions(version, VULNERABLE_MAX) <= 0;
}

/** Todo caminho `node_modules/**\/esbuild` de um lockfile, com a versão resolvida. */
function esbuildCopies(packages: Record<string, LockEntry>): { path: string; version: string }[] {
  const out: { path: string; version: string }[] = [];
  for (const [path, entry] of Object.entries(packages)) {
    if (!/(^|\/)esbuild$/.test(path)) continue;
    if (typeof entry.version !== 'string') continue;
    out.push({ path, version: entry.version });
  }
  return out;
}

/**
 * A versão de `esbuild` que `@esbuild-kit/core-utils` REALMENTE carrega:
 * a cópia aninhada quando ela existe, senão a `esbuild` de topo (que é o
 * efeito do override — deduplicar em vez de aninhar).
 *
 * `null` = a cadeia está lá mas não há `esbuild` nenhum que a sirva; isso é um
 * lockfile impossível, e a política trata como violação em vez de "sem
 * vulnerável, logo verde".
 */
function resolucaoEfetiva(packages: Record<string, LockEntry>): { path: string; version: string } | null {
  const aninhada = esbuildCopies(packages).find((c) =>
    c.path.endsWith(`${PACOTE_DA_CADEIA}/node_modules/esbuild`),
  );
  if (aninhada) return aninhada;
  const topo = packages['node_modules/esbuild'];
  if (typeof topo?.version !== 'string') return null;
  return { path: 'node_modules/esbuild', version: topo.version };
}

/** A cadeia deprecada ainda está resolvida neste lockfile? */
function cadeiaResolvida(packages: Record<string, LockEntry>): boolean {
  return Object.keys(packages).some(
    (p) => p === `node_modules/${PACOTE_DA_CADEIA}` || p.endsWith(`/node_modules/${PACOTE_DA_CADEIA}`),
  );
}

/**
 * A política inteira, como função pura, para que os dois lados possam ser
 * sondados com lockfiles sintéticos sem tocar nos artefatos reais.
 * Devolve a lista de violações; vazia = conforme.
 */
export function avaliarPoliticaDoOverride(entrada: {
  packages: Record<string, LockEntry>;
  overrides: Record<string, unknown> | undefined;
}): string[] {
  const { packages, overrides } = entrada;
  const violacoes: string[] = [];
  const temCadeia = cadeiaResolvida(packages);
  const declarado = overrides?.[PACOTE_DA_CADEIA];
  const temOverride = declarado !== undefined;

  if (temCadeia) {
    if (!temOverride) {
      violacoes.push(
        `${PACOTE_DA_CADEIA} ainda está resolvido, mas o override que dedupa o esbuild dele sumiu do manifesto`,
      );
    } else if (JSON.stringify(declarado) !== JSON.stringify(OVERRIDE_ESPERADO)) {
      violacoes.push(
        `override de ${PACOTE_DA_CADEIA} mudou de forma: ${JSON.stringify(declarado)} (esperado ${JSON.stringify(OVERRIDE_ESPERADO)})`,
      );
    }
    const efetiva = resolucaoEfetiva(packages);
    if (!efetiva) {
      violacoes.push(
        `${PACOTE_DA_CADEIA} está resolvido mas nenhuma cópia de esbuild o serve — lockfile não interpretável`,
      );
    } else if (ehVulneravel(efetiva.version)) {
      violacoes.push(
        `resolução efetiva de esbuild sob ${PACOTE_DA_CADEIA} é vulnerável: ${efetiva.path}@${efetiva.version}`,
      );
    }
    return violacoes;
  }

  if (temOverride) {
    violacoes.push(
      `${PACOTE_DA_CADEIA} não está mais resolvido: o override virou órfão e deve ser removido do manifesto`,
    );
  }
  return violacoes;
}

describe('GHSA-67mh-4wv8-2f99 — nenhuma cópia vulnerável de esbuild nos lockfiles (#574)', () => {
  for (const lockPath of LOCKFILES) {
    it(`${lockPath}: toda cópia de esbuild está acima de 0.24.2`, () => {
      const lock = readJson(lockPath) as Lockfile;
      const vulneraveis = esbuildCopies(lock.packages)
        .filter((c) => ehVulneravel(c.version))
        .map((c) => `${c.path}@${c.version}`);
      expect(vulneraveis).toEqual([]);
    });
  }

  for (const par of PARES) {
    it(`${par.pkg}: o override de ${PACOTE_DA_CADEIA} está sincronizado com a cadeia real`, () => {
      const lock = readJson(par.lock) as Lockfile;
      const manifest = readJson(par.pkg) as Manifest;
      expect(avaliarPoliticaDoOverride({ packages: lock.packages, overrides: manifest.overrides })).toEqual(
        [],
      );
    });
  }

  it('drizzle-kit está no major que conserta a cópia REALMENTE usada', () => {
    const lock = readJson('package-lock.json') as Lockfile;
    const resolvida = lock.packages['node_modules/drizzle-kit']?.version ?? '';
    expect(compareVersions(resolvida, [0, 31, 0])).toBeGreaterThanOrEqual(0);
  });
});

/**
 * Sonda versionada da política. Cada caso é um lockfile sintético mínimo; não
 * lê nada do disco. É esta suíte que prova que o teste AVISA quando o upstream
 * torna o override desnecessário, em vez de fixá-lo para sempre.
 */
describe('política do override — as duas direções reprovam (revisão do PR #594)', () => {
  const CADEIA = {
    'node_modules/drizzle-kit': { version: '0.31.10' },
    'node_modules/@esbuild-kit/esm-loader': { version: '2.6.5' },
    [`node_modules/${PACOTE_DA_CADEIA}`]: { version: '3.3.2' },
  } as const;
  const OVERRIDE = { [PACOTE_DA_CADEIA]: { esbuild: '^0.25.4' } };

  it('cadeia presente + override presente + esbuild de topo saudável → conforme', () => {
    expect(
      avaliarPoliticaDoOverride({
        packages: { ...CADEIA, 'node_modules/esbuild': { version: '0.25.12' } },
        overrides: OVERRIDE,
      }),
    ).toEqual([]);
  });

  it('cadeia presente + override AUSENTE → viola (o workaround não pode sumir sozinho)', () => {
    const violacoes = avaliarPoliticaDoOverride({
      packages: { ...CADEIA, 'node_modules/esbuild': { version: '0.25.12' } },
      overrides: { protobufjs: '^7.6.5' },
    });
    expect(violacoes).toHaveLength(1);
    expect(violacoes[0]).toContain('o override que dedupa o esbuild dele sumiu');
  });

  it('cadeia AUSENTE + override presente → viola (override órfão tem de ser removido)', () => {
    const violacoes = avaliarPoliticaDoOverride({
      packages: {
        'node_modules/drizzle-kit': { version: '0.32.0' },
        'node_modules/esbuild': { version: '0.25.12' },
      },
      overrides: OVERRIDE,
    });
    expect(violacoes).toHaveLength(1);
    expect(violacoes[0]).toContain('virou órfão');
  });

  it('cadeia AUSENTE + override ausente → conforme (é o estado final desejado)', () => {
    expect(
      avaliarPoliticaDoOverride({
        packages: {
          'node_modules/drizzle-kit': { version: '0.32.0' },
          'node_modules/esbuild': { version: '0.25.12' },
        },
        overrides: { protobufjs: '^7.6.5' },
      }),
    ).toEqual([]);
  });

  it('cadeia presente com cópia ANINHADA vulnerável → viola mesmo com o override declarado', () => {
    const violacoes = avaliarPoliticaDoOverride({
      packages: {
        ...CADEIA,
        'node_modules/esbuild': { version: '0.25.12' },
        [`node_modules/${PACOTE_DA_CADEIA}/node_modules/esbuild`]: { version: '0.18.20' },
      },
      overrides: OVERRIDE,
    });
    expect(violacoes).toHaveLength(1);
    expect(violacoes[0]).toContain('resolução efetiva de esbuild');
  });

  it('cadeia presente deduplicada numa esbuild de TOPO vulnerável → viola', () => {
    // Sem cópia aninhada o teste antigo ficava verde aqui: ele só olhava a
    // ausência do caminho aninhado, nunca a versão que a dedup entregou.
    const violacoes = avaliarPoliticaDoOverride({
      packages: { ...CADEIA, 'node_modules/esbuild': { version: '0.24.2' } },
      overrides: OVERRIDE,
    });
    expect(violacoes).toHaveLength(1);
    expect(violacoes[0]).toContain('resolução efetiva de esbuild');
  });

  it('override presente com FORMA diferente da esperada → viola', () => {
    const violacoes = avaliarPoliticaDoOverride({
      packages: { ...CADEIA, 'node_modules/esbuild': { version: '0.25.12' } },
      overrides: { [PACOTE_DA_CADEIA]: { esbuild: '^0.19.7' } },
    });
    expect(violacoes).toHaveLength(1);
    expect(violacoes[0]).toContain('mudou de forma');
  });
});
