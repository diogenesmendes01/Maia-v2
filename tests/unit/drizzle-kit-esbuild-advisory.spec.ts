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
 * O que ele NÃO prova
 * -------------------
 * Nada sobre migrations. Lockfile íntegro não diz que `drizzle-kit generate`
 * produz SQL aplicável — isso é exercitado contra Postgres real, não aqui.
 * E ele afere a faixa de versão RESOLVIDA, não o conteúdo do tarball.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = process.cwd();

/** Os dois lockfiles que o job `dependency-audit` audita (scripts/check-audit-exceptions.ts). */
const LOCKFILES: readonly string[] = ['package-lock.json', 'src/admin-ui/package-lock.json'];

/**
 * Teto vulnerável do advisory, copiado do `range` que o `npm audit` reporta
 * para `GHSA-67mh-4wv8-2f99`: `<=0.24.2`.
 */
const VULNERABLE_MAX: readonly [number, number, number] = [0, 24, 2];

interface LockEntry {
  version?: string;
}

interface Lockfile {
  packages: Record<string, LockEntry>;
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

/** Todo caminho `node_modules/**\/esbuild` de um lockfile, com a versão resolvida. */
function esbuildCopies(lock: Lockfile): { path: string; version: string }[] {
  const out: { path: string; version: string }[] = [];
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!/(^|\/)esbuild$/.test(path)) continue;
    if (typeof entry.version !== 'string') continue;
    out.push({ path, version: entry.version });
  }
  return out;
}

describe('GHSA-67mh-4wv8-2f99 — nenhuma cópia vulnerável de esbuild nos lockfiles (#574)', () => {
  for (const lockPath of LOCKFILES) {
    it(`${lockPath}: toda cópia de esbuild está acima de 0.24.2`, () => {
      const lock = readJson(lockPath) as Lockfile;
      const vulneraveis = esbuildCopies(lock)
        .filter((c) => compareVersions(c.version, VULNERABLE_MAX) <= 0)
        .map((c) => `${c.path}@${c.version}`);
      expect(vulneraveis).toEqual([]);
    });
  }

  it('a cópia vestigial sob @esbuild-kit/core-utils foi deduplicada (o override é carregado)', () => {
    const lock = readJson('package-lock.json') as Lockfile;
    const aninhada = Object.keys(lock.packages).filter((p) =>
      p.endsWith('@esbuild-kit/core-utils/node_modules/esbuild'),
    );
    expect(aninhada).toEqual([]);
  });

  it('o override que produz essa deduplicação continua declarado', () => {
    const pkg = readJson('package.json') as {
      overrides?: Record<string, unknown>;
    };
    expect(pkg.overrides?.['@esbuild-kit/core-utils']).toEqual({ esbuild: '^0.25.4' });
  });

  it('drizzle-kit está no major que conserta a cópia REALMENTE usada', () => {
    const lock = readJson('package-lock.json') as Lockfile;
    const resolvida = lock.packages['node_modules/drizzle-kit']?.version ?? '';
    expect(compareVersions(resolvida, [0, 31, 0])).toBeGreaterThanOrEqual(0);
  });
});
