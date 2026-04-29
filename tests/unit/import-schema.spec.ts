/**
 * Smoke test: import_runs and import_entries are exported from the Drizzle
 * schema module so scripts/import-ofx.ts and scripts/import-review.ts type-check
 * and run. Catches a regression that was caught only at runtime before.
 *
 * Also verifies the constraints we mirror from migrations/002_specs_v1.sql
 * are declared on the Drizzle table — so a future migration that drifts
 * apart breaks the build instead of silently allowing duplicate imports.
 */
import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from '../../src/db/schema.js';

describe('drizzle schema — import tables', () => {
  it('exports import_runs', () => {
    expect(schema.import_runs).toBeDefined();
  });

  it('exports import_entries', () => {
    expect(schema.import_entries).toBeDefined();
  });

  it('exports ImportRun and ImportEntry types (compile-time only)', () => {
    type _Run = schema.ImportRun;
    type _Entry = schema.ImportEntry;
    const r: _Run | null = null;
    const e: _Entry | null = null;
    expect(r).toBeNull();
    expect(e).toBeNull();
  });

  it('import_runs declares UNIQUE(conta_id, arquivo_sha256)', () => {
    const cfg = getTableConfig(schema.import_runs);
    const uniques = cfg.uniqueConstraints.map((u) => u.columns.map((c) => c.name).sort());
    expect(uniques).toContainEqual(['arquivo_sha256', 'conta_id']);
  });

  it('import_entries declares (import_run_id, ordem) index', () => {
    const cfg = getTableConfig(schema.import_entries);
    const idx = cfg.indexes.map((i) => i.config.columns.map((c) => (c as { name: string }).name));
    expect(idx).toContainEqual(['import_run_id', 'ordem']);
  });
});
