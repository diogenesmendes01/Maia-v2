/**
 * Smoke test: import_runs and import_entries are exported from the Drizzle
 * schema module so scripts/import-ofx.ts and scripts/import-review.ts type-check
 * and run. Catches a regression that was caught only at runtime before.
 */
import { describe, it, expect } from 'vitest';
import * as schema from '../../src/db/schema.js';

describe('drizzle schema — import tables', () => {
  it('exports import_runs', () => {
    expect(schema.import_runs).toBeDefined();
  });
  it('exports import_entries', () => {
    expect(schema.import_entries).toBeDefined();
  });
  it('exports ImportRun and ImportEntry types (compile-time only)', () => {
    // type-only check: instantiation through type would fail at compile if missing
    type _Run = schema.ImportRun;
    type _Entry = schema.ImportEntry;
    const r: _Run | null = null;
    const e: _Entry | null = null;
    expect(r).toBeNull();
    expect(e).toBeNull();
  });
});
