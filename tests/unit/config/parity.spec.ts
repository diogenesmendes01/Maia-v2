/**
 * Issue #515 — parity between the contract and everything else that names an
 * environment variable or a runtime version.
 *
 * Two families of drift the issue calls out explicitly:
 *   - Compose files / Dockerfiles referencing a variable the contract does not
 *     know about (or one that was removed) — the operator sets it, nothing
 *     reads it, and the deployment looks configured when it is not.
 *   - Node/npm versions documented in one place and pinned in another.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { findSpec, findTombstone, isUnknownMaiaKey } from '@/config/contract.js';
import { isMaiaNamespacedKey } from '@/config/metadata.js';

const REPO_ROOT = resolve(__dirname, '../../..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');

/**
 * Env var names referenced by a compose file or Dockerfile:
 *   `KEY: value`, `KEY=value`, `${KEY}`, `${KEY:?msg}`, `${KEY:-default}`.
 * Restricted to SCREAMING_SNAKE tokens, then filtered to Maia-owned names.
 */
function referencedEnvKeys(content: string): string[] {
  const keys = new Set<string>();
  const interpolated = /\$\{([A-Z][A-Z0-9_]{2,})[:}]/g;
  const assigned = /^\s{2,}([A-Z][A-Z0-9_]{2,})\s*[:=]/gm;
  for (const re of [interpolated, assigned]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      if (m[1]) keys.add(m[1]);
    }
  }
  return [...keys].sort();
}

/**
 * Names that legitimately appear in deployment files but are NOT Maia
 * configuration: Postgres/Redis image knobs, Docker/Coolify plumbing, and the
 * Redis password that lives only inside the composed `REDIS_URL`.
 */
const NON_CONTRACT_DEPLOYMENT_KEYS = new Set([
  'PGTZ',
  'PGDATA',
  'POSTGRES_INITDB_ARGS',
  'REDIS_PASSWORD',
  'REDISCLI_AUTH',
  'DOMAIN',
  'PORT',
  'HOST',
  'PATH',
  'HOME',
  'NPM_CONFIG_UPDATE_NOTIFIER',
  'HOSTNAME',
]);

const DEPLOYMENT_FILES = [
  'compose.prod.yml',
  'docker-compose.yml',
  'Dockerfile',
  'src/admin-ui/Dockerfile',
];

describe('contract ↔ deployment parity (#515)', () => {
  it.each(DEPLOYMENT_FILES)(
    '%s references no unknown or removed Maia variable',
    (file) => {
      const offenders: string[] = [];
      for (const key of referencedEnvKeys(read(file))) {
        if (NON_CONTRACT_DEPLOYMENT_KEYS.has(key)) continue;
        if (findTombstone(key)) {
          offenders.push(`${key} (REMOVIDA — tombstone)`);
          continue;
        }
        if (findSpec(key)) continue;
        if (isMaiaNamespacedKey(key) && isUnknownMaiaKey(key)) {
          offenders.push(`${key} (desconhecida no contrato)`);
        }
      }
      expect(
        offenders,
        `${file} names variables the contract does not know: ${offenders.join(', ')}. ` +
          'Declare-as em src/config/contract.ts ou remova-as do deploy.',
      ).toEqual([]);
    },
  );

  it('every variable the runtime container receives is declared for the runtime service', () => {
    const compose = read('compose.prod.yml');
    // The `app` service block runs from its `environment:` key to the next
    // top-level-ish service key. A coarse slice is enough: we only assert that
    // the Maia-owned names inside it are contract variables.
    const unknown = referencedEnvKeys(compose)
      .filter((k) => !NON_CONTRACT_DEPLOYMENT_KEYS.has(k))
      .filter((k) => isMaiaNamespacedKey(k) || findSpec(k))
      .filter((k) => !findSpec(k));
    expect(unknown).toEqual([]);
  });
});

describe('Node/npm version parity (#515)', () => {
  const NODE_MAJOR = '22';

  it('.nvmrc pins the supported line', () => {
    expect(read('.nvmrc').trim()).toBe(NODE_MAJOR);
  });

  it('package.json engines match .nvmrc', () => {
    const pkg = JSON.parse(read('package.json')) as {
      engines: { node: string; npm: string };
      packageManager: string;
    };
    // A paridade que ESTE arquivo cobre é a LINHA (major), que é o que o
    // `.nvmrc` fixa. O minor/patch do piso não é escolha livre: ele é o maior
    // mínimo exigido pela árvore do lockfile sob `engine-strict=true` (hoje
    // 22.13.0, por causa do eslint) e pelo npm pinado. Quem deriva e cobra
    // esse número é tests/unit/scripts/check-node.spec.ts — repeti-lo aqui
    // criaria um segundo número para envelhecer sozinho.
    expect(pkg.engines.node).toMatch(new RegExp(`^>=${NODE_MAJOR}\\.\\d+\\.\\d+$`));
    expect(pkg.packageManager).toMatch(/^npm@11\./);
    expect(pkg.engines.npm).toContain('11.5.2');
  });

  it.each(['Dockerfile', 'src/admin-ui/Dockerfile'])(
    '%s builds on the same Node line',
    (file) => {
      const froms = [...read(file).matchAll(/^FROM\s+node:(\d+)/gm)].map((m) => m[1]);
      expect(froms.length).toBeGreaterThan(0);
      for (const major of froms) {
        expect(major, `${file} pins node:${major}, .nvmrc says ${NODE_MAJOR}`).toBe(NODE_MAJOR);
      }
    },
  );

  it('README and AGENTS.md document the same line they pin', () => {
    const readme = read('README.md');
    expect(readme).toContain(`node-${NODE_MAJOR}%2B`);
    expect(readme).toContain(`Node.js ${NODE_MAJOR}+`);
    expect(readme).not.toMatch(/Node(\.js)? 20\+/);
    expect(read('AGENTS.md')).toContain(`Node ${NODE_MAJOR}+`);
  });
});
