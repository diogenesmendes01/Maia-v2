/**
 * Issue #308 — guards against re-introducing duplicate migration prefixes.
 *
 * `scripts/migrate.ts` orders files by `.sort()` (alphabetical) and tracks
 * applied migrations by filename in `schema_migrations.id`. Two files sharing
 * a numeric prefix (e.g. `063_foo.sql` and `063_bar.sql`) violate the
 * "one migration per number" invariant: the run order within the prefix is
 * only alphabetical-by-suffix, which is locale-sensitive and confuses
 * operator triage ("which 063 ran first in this env?").
 *
 * This regression test fails loudly the moment a NEW migration lands with a
 * prefix that already exists.
 *
 * Historical duplicates predating this check are grandfathered below — they
 * sorted alphabetically-by-suffix in every environment that ran them and
 * renaming them now would force a coordinated `schema_migrations` UPDATE
 * across all envs. Do NOT add to this list when authoring a new migration:
 * pick the next free number instead.
 */
const GRANDFATHERED_DUPLICATE_PREFIXES = new Set<string>([
  '007', '014', '015', '018', '020', '023', '025', '026', '027', '031',
]);

import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIG_DIR = join(process.cwd(), 'migrations');

describe('migration filename invariants', () => {
  it('forward migrations have unique numeric prefixes', () => {
    const forward = readdirSync(MIG_DIR)
      .filter((f) => f.endsWith('.sql') && !f.endsWith('_down.sql'));

    const byPrefix = new Map<string, string[]>();
    for (const file of forward) {
      // Accept optional lowercase patch letter after the digits (e.g. `038b_*`
      // intentionally squeezes between 038 and 039). The full `digits + letter`
      // tuple is what must be unique.
      const prefix = file.match(/^(\d+[a-z]?)_/)?.[1];
      expect(prefix, `migration ${file} must start with a numeric prefix`).toBeDefined();
      const list = byPrefix.get(prefix!) ?? [];
      list.push(file);
      byPrefix.set(prefix!, list);
    }

    const duplicates = [...byPrefix.entries()]
      .filter(([, files]) => files.length > 1)
      .filter(([prefix]) => !GRANDFATHERED_DUPLICATE_PREFIXES.has(prefix));
    expect(
      duplicates,
      `NEW duplicate migration prefixes detected (grandfathered ones are exempt):\n${duplicates
        .map(([p, fs]) => `  ${p}: ${fs.join(', ')}`)
        .join('\n')}`,
    ).toEqual([]);
  });

  it('every forward migration has a matching _down.sql', () => {
    const all = readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql'));
    const forward = all.filter((f) => !f.endsWith('_down.sql'));
    const downs = new Set(all.filter((f) => f.endsWith('_down.sql')));

    const missing = forward.filter(
      (f) => !downs.has(f.replace(/\.sql$/, '_down.sql')),
    );
    expect(missing, `forward migrations missing _down.sql:\n  ${missing.join('\n  ')}`).toEqual([]);
  });
});
