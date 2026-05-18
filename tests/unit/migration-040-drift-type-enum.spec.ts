/**
 * Migration 040 — enum superset safety test.
 *
 * Asserts that the CHECK constraint defined in
 * migrations/040_p8d_extend_drift_type_papel.sql includes the FULL set of
 * expected drift_type values: the original 7 P4 values + soul_drift (P8b)
 * + papel_drift (P8d).
 *
 * Motivation (round-2 review finding 3): the previous version of 040 only
 * listed P4+papel_drift, silently removing soul_drift from the allowed set
 * when P8b's migration had already run. This test catches any future edit
 * that drops a value from the CHECK.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const MIGRATION_FILE = join(process.cwd(), 'migrations', '040_p8d_extend_drift_type_papel.sql');

const EXPECTED_VALUES = [
  'tom',
  'valores',
  'confianca',
  'vies',
  'escopo',
  'linguagem',
  'procedimento',
  'soul_drift',    // P8b — must be preserved for merge-safety
  'papel_drift',   // P8d — this branch's addition
];

describe('migration 040 — drift_type CHECK enum superset', () => {
  let sql: string;

  beforeAll(() => {
    sql = readFileSync(MIGRATION_FILE, 'utf-8');
  });

  it('o arquivo SQL existe e não está vazio', () => {
    expect(sql.length).toBeGreaterThan(0);
  });

  it('dropa o CHECK antigo antes de recriar (idempotência)', () => {
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS');
    expect(sql).toContain('agent_drift_alerts_drift_type_check');
  });

  it('recria o CHECK com ADD CONSTRAINT', () => {
    expect(sql).toContain('ADD CONSTRAINT agent_drift_alerts_drift_type_check');
    expect(sql).toContain('CHECK (drift_type IN');
  });

  for (const value of EXPECTED_VALUES) {
    it(`CHECK inclui '${value}'`, () => {
      // Each value must appear as a quoted string literal in the IN list.
      expect(sql).toContain(`'${value}'`);
    });
  }

  it('CHECK contém todos os valores esperados em uma única asserção', () => {
    const missing = EXPECTED_VALUES.filter((v) => !sql.includes(`'${v}'`));
    expect(missing, `Valores ausentes na CHECK: ${missing.join(', ')}`).toHaveLength(0);
  });
});
