/**
 * P9b — Architecture lock test (G7).
 *
 * Spec §11 G7: nothing inside `src/runtime/decision/` or
 * `src/runtime/guardrails/` may import `policy-descriptor-resolver.ts`
 * directly. The resolver MUST enter via dependency injection (env arg
 * in the composition root).
 *
 * This is a static-grep test — fast, no need for full AST parsing.
 */
import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(__filename), '..', '..', '..', '..');

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else if (e.isFile() && full.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('P9b — Architecture lock (G7)', () => {
  it('src/runtime/decision/* does NOT import policy-descriptor-resolver directly', async () => {
    const dir = join(REPO_ROOT, 'src', 'runtime', 'decision');
    const files = await walk(dir);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const content = await readFile(f, 'utf8');
      // Allow comments referencing the resolver as documentation/TODO.
      // Forbid only actual import statements.
      const importPattern =
        /^\s*import\s.*from\s+['"][^'"]*policy-descriptor-resolver[^'"]*['"]/m;
      expect(
        importPattern.test(content),
        `file ${f} imports policy-descriptor-resolver directly`,
      ).toBe(false);
    }
  });

  it('src/runtime/guardrails/* does NOT import policy-descriptor-resolver directly', async () => {
    const dir = join(REPO_ROOT, 'src', 'runtime', 'guardrails');
    const files = await walk(dir);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const content = await readFile(f, 'utf8');
      const importPattern =
        /^\s*import\s.*from\s+['"][^'"]*policy-descriptor-resolver[^'"]*['"]/m;
      expect(
        importPattern.test(content),
        `file ${f} imports policy-descriptor-resolver directly`,
      ).toBe(false);
    }
  });
});
