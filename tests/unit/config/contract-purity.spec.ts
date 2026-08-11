/**
 * Issue #515 — the configuration contract MUST be importable with zero side
 * effects.
 *
 * This is the load-bearing property of the whole issue: `maia doctor` (#517),
 * the migration runner (#516), the CLI and the test suite all import the
 * contract to reason about configuration. If importing it ran `dotenv/config`,
 * validated the process, opened a socket or created a directory — as
 * `src/config/env.ts` still legitimately does — none of those consumers could
 * exist.
 *
 * Two complementary gates:
 *   1. STATIC — walk the real import graph of every pure module and assert it
 *      never reaches a side-effecting module (`config/env.ts`, `dotenv`, `pg`,
 *      `ioredis`, `node:fs`, …). A graph walk catches the regression at the
 *      moment someone adds the import, not when a consumer mysteriously boots
 *      the world.
 *   2. RUNTIME — call the pure API with an EMPTY environment and assert it
 *      works. `src/config/env.ts` throws under the same conditions.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');
const SRC = join(REPO_ROOT, 'src');

/** The modules that must stay pure. */
const PURE_ENTRYPOINTS = [
  'src/config/metadata.ts',
  'src/config/contract.ts',
  'src/config/profiles.ts',
  'src/config/rules.ts',
  'src/config/redact.ts',
  'src/config/validate.ts',
  'src/config/services.ts',
  'src/config/generate.ts',
  'src/config/env-file.ts',
  'src/setup/auth-dir-path.ts',
];

/**
 * Modules whose mere import has side effects (or that drag in I/O). Reaching
 * any of these from a pure entrypoint is the regression.
 *
 * NOTE on `dotenv`: the bare module is a pure library — `dotenv.parse(src)` is
 * string → object. It is `dotenv/config` (and calling `dotenv.config()`) that
 * reads the filesystem and mutates `process.env`. `src/config/env-file.ts`
 * deliberately uses `dotenv.parse` so the validator and the runtime boot share
 * ONE interpretation of a `.env` file (PR #522 review round 1); the dedicated
 * tests below pin the side-effecting entry points as forbidden.
 */
const FORBIDDEN_SPECIFIERS = [
  'dotenv/config',
  'pg',
  'ioredis',
  'bullmq',
  'openai',
  '@anthropic-ai/sdk',
  '@whiskeysockets/baileys',
  '@aws-sdk/client-s3',
  'drizzle-orm',
  'fastify',
  'node:fs',
  'node:fs/promises',
  'node:child_process',
  'node:net',
  'node:http',
  'node:https',
  'node:dns',
];

/** Repo-local modules that are known to have import-time side effects. */
const FORBIDDEN_LOCAL = ['src/config/env.ts', 'src/config/load.ts'];

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g;
const BARE_IMPORT_RE = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;

function specifiersOf(source: string): string[] {
  const out: string[] = [];
  for (const re of [IMPORT_RE, BARE_IMPORT_RE]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      if (match[1]) out.push(match[1]);
    }
  }
  return out;
}

/** Resolve a specifier to a repo-relative `.ts` path, or `null` if external. */
function resolveLocal(fromFile: string, specifier: string): string | null {
  let absNoExt: string;
  if (specifier.startsWith('@/')) {
    absNoExt = join(SRC, specifier.slice(2));
  } else if (specifier.startsWith('.')) {
    absNoExt = resolve(dirname(join(REPO_ROOT, fromFile)), specifier);
  } else {
    return null;
  }
  const candidate = absNoExt.replace(/\.js$/, '.ts');
  const withIndex = join(absNoExt.replace(/\.js$/, ''), 'index.ts');
  const abs = existsSync(candidate) ? candidate : existsSync(withIndex) ? withIndex : null;
  return abs === null ? null : relative(REPO_ROOT, abs).split('\\').join('/');
}

interface GraphNode {
  readonly file: string;
  readonly external: string[];
}

/** Drop comments so a docstring naming a forbidden API is not a violation. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Transitive local import graph starting at `entry`. */
function walk(entry: string): { visited: Set<string>; nodes: GraphNode[] } {
  const visited = new Set<string>();
  const nodes: GraphNode[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(join(REPO_ROOT, file), 'utf8');
    const external: string[] = [];
    for (const spec of specifiersOf(source)) {
      const local = resolveLocal(file, spec);
      if (local === null) external.push(spec);
      else queue.push(local);
    }
    nodes.push({ file, external });
  }
  return { visited, nodes };
}

describe('config contract — import purity (#515)', () => {
  for (const entry of PURE_ENTRYPOINTS) {
    it(`${entry} never reaches a side-effecting module`, () => {
      const { visited, nodes } = walk(entry);

      for (const forbidden of FORBIDDEN_LOCAL) {
        expect(
          visited.has(forbidden),
          `${entry} transitively imports ${forbidden}, which runs dotenv/config and validates the ` +
            'process at import time. Move the shared piece into a pure module instead.',
        ).toBe(false);
      }

      const offenders = nodes.flatMap((n) =>
        n.external
          .filter((spec) => FORBIDDEN_SPECIFIERS.includes(spec))
          .map((spec) => `${n.file} → ${spec}`),
      );
      expect(offenders, `pure module graph must not touch I/O: ${offenders.join(', ')}`).toEqual(
        [],
      );
    });
  }

  it('only src/config/env-file.ts may import dotenv, and never its config entry', () => {
    for (const entry of PURE_ENTRYPOINTS) {
      const { nodes } = walk(entry);
      for (const node of nodes) {
        const usesDotenv = node.external.some((s) => s === 'dotenv' || s.startsWith('dotenv/'));
        if (!usesDotenv) continue;
        expect(
          node.file,
          'dotenv belongs behind the single wrapper in src/config/env-file.ts',
        ).toBe('src/config/env-file.ts');
        expect(
          node.external.filter((s) => s.startsWith('dotenv/')),
          'dotenv/config reads the filesystem and mutates process.env',
        ).toEqual([]);
        // `.parse` only — `.config()` / `.configDotenv()` do the I/O. Comments
        // are stripped first: the wrapper's docstring explains precisely why
        // `dotenv.config` is off limits, and must not trip its own guard.
        const source = stripComments(readFileSync(join(REPO_ROOT, node.file), 'utf8'));
        expect(/dotenv\s*\.\s*config/.test(source), `${node.file} calls dotenv.config`).toBe(
          false,
        );
      }
    }
  });

  it('src/config/contract.ts imports nothing but zod', () => {
    // The Admin UI bundles this module. A `node:*` import (or anything with a
    // runtime dependency) would break the Next.js build for a client target and
    // quietly reintroduce the duplicate schema this issue removed.
    const { nodes } = walk('src/config/contract.ts');
    const external = [...new Set(nodes.flatMap((n) => n.external))].sort();
    expect(external).toEqual(['zod']);
  });

  it('the contract can be used with a completely empty environment', async () => {
    const { objectSchemaForService, CONTRACT_ENTRIES } = await import('@/config/contract.js');
    const { validateConfig } = await import('@/config/validate.js');

    // Building the schema must not require anything from the environment.
    expect(() => objectSchemaForService('runtime')).not.toThrow();
    expect(CONTRACT_ENTRIES.length).toBeGreaterThan(50);

    // Validating an empty env must REPORT problems, never throw.
    const result = validateConfig({ env: {}, profile: 'production' });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('generators are deterministic (same input ⇒ byte-identical output)', async () => {
    const { renderEnvExample, renderConfigDoc, renderFixture } = await import(
      '@/config/generate.js'
    );
    expect(renderEnvExample()).toBe(renderEnvExample());
    expect(renderConfigDoc()).toBe(renderConfigDoc());
    expect(renderFixture('production')).toBe(renderFixture('production'));
  });
});
