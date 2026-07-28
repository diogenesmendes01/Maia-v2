/**
 * Issue #515 — enforcement of "configuration is consumed through a loader".
 *
 * `eslint.config.js` carries a `no-restricted-properties` rule that fails the
 * build on a NEW `process.env` read outside an explicit allow-list. This spec
 * is the second half of that gate:
 *   1. the rule is actually configured (a rule that got deleted or downgraded
 *      would otherwise pass lint silently);
 *   2. the allow-list is EXACT — every file that still reads `process.env` is
 *      listed, and every listed pattern still matches something. A stale entry
 *      is a hole someone can slip a new read through.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');
const SRC = join(REPO_ROOT, 'src');

/** Files/globs allowed to read `process.env`. Mirrors `eslint.config.js`. */
const ALLOWLIST = [
  'src/config/env.ts',
  'src/config/load.ts',
  'src/admin-ui/**',
  'src/agent/prompt-builder.ts',
  'src/cognition/calendar-pattern-detector.ts',
  'src/cognition/capability-proposer.ts',
  'src/cognition/drift/**',
  'src/cognition/role-selector/llm-suggester.ts',
  'src/db/tenant-context.ts',
  'src/lib/mcp-client.ts',
  'src/runtime/context-packet/test-fixtures.ts',
  'src/runtime/feature-flags/context-packet-flag.ts',
  'src/setup/index.ts',
  'src/shared/risk/llm-gate.ts',
  'src/workers/procedure-execution-reaper.ts',
] as const;

function matchesGlob(file: string, pattern: string): boolean {
  if (pattern.endsWith('/**')) return file.startsWith(pattern.slice(0, -2));
  return file === pattern;
}

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'generated') continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) walkTs(abs, out);
    else if (/\.tsx?$/.test(entry)) out.push(relative(REPO_ROOT, abs).split('\\').join('/'));
  }
  return out;
}

/**
 * Strip comments and string literals so that a docstring MENTIONING
 * `process.env` (the contract modules are full of them, by design) or a
 * generated documentation line containing the words is not counted as a read.
 */
function stripNonCode(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const READ_RE = /\bprocess\s*\.\s*env\b/;

describe('no direct process.env reads outside the allow-list (#515)', () => {
  const offenders = walkTs(SRC).filter((file) => {
    if (ALLOWLIST.some((p) => matchesGlob(file, p))) return false;
    return READ_RE.test(stripNonCode(readFileSync(join(REPO_ROOT, file), 'utf8')));
  });

  it('src/ has no unlisted direct read', () => {
    expect(
      offenders,
      'Contrato de configuração (#515): declare a variável em src/config/contract.ts e leia pelo ' +
        'loader do serviço. Se a leitura direta for mesmo necessária, adicione o arquivo à ' +
        'allow-list em eslint.config.js E neste teste.',
    ).toEqual([]);
  });

  it('the ESLint rule that enforces this is still configured as an error', () => {
    const config = readFileSync(join(REPO_ROOT, 'eslint.config.js'), 'utf8');
    expect(config).toContain("'no-restricted-properties'");
    expect(config).toMatch(/object:\s*'process'/);
    expect(config).toMatch(/property:\s*'env'/);
    // The rule must not have been downgraded to a warning.
    const block = config.slice(config.indexOf("'no-restricted-properties'"));
    expect(block.slice(0, 80)).toContain("'error'");
  });

  it('the ESLint allow-list and this spec list the same files', () => {
    const config = readFileSync(join(REPO_ROOT, 'eslint.config.js'), 'utf8');
    for (const pattern of ALLOWLIST) {
      expect(config, `${pattern} is missing from eslint.config.js`).toContain(`'${pattern}'`);
    }
  });

  it('every allow-list entry still covers a real reader (no stale exemptions)', () => {
    const readers = walkTs(SRC).filter((file) =>
      READ_RE.test(stripNonCode(readFileSync(join(REPO_ROOT, file), 'utf8'))),
    );
    const stale = ALLOWLIST.filter((pattern) => !readers.some((f) => matchesGlob(f, pattern)));
    expect(
      stale,
      'exemption sem leitor correspondente — remova a entrada da allow-list (ela é um orçamento de ' +
        'migração, não uma isenção permanente)',
    ).toEqual([]);
  });
});
