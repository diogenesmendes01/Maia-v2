/**
 * PR #310 — regression test for the no-transaction migration runner.
 *
 * Bug: migration 066 was the first `-- maia:no-transaction` file with
 * MULTIPLE statements. node-postgres' simple-query protocol wraps several
 * statements sent in a single `client.query()` call in an IMPLICIT
 * transaction, so even on the no-tx path the migration tripped
 * "CREATE INDEX CONCURRENTLY cannot run inside a transaction block".
 *
 * Fix: `scripts/migrate.ts` (and the testcontainer fixture, kept in sync)
 * now split no-tx files into individual statements via
 * `splitNoTxStatements` and send each on its own.
 *
 * This test pins:
 *   - the marker detection (NO_TX_MARKER),
 *   - that the splitter yields one statement per CONCURRENTLY DDL,
 *   - that migration 066 specifically splits into its 8 CREATE INDEX
 *     statements (no statement still carries an embedded `;`),
 *   - that comments and blank lines are stripped,
 *   - importing the module does NOT run `main()` (entrypoint guard).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  NO_TX_MARKER,
  splitNoTxStatements,
  isDirectInvocation,
} from '../../../scripts/migrate.js';

const MIG_DIR = join(process.cwd(), 'migrations');

function readMig(file: string): string {
  return readFileSync(join(MIG_DIR, file), 'utf8').replace(/\r\n/g, '\n');
}

describe('PR #310 — no-tx migration statement splitter', () => {
  it('detects the maia:no-transaction marker on migration 066', () => {
    const sql = readMig('066_ksm_composite_indexes_tenant_agent_id.sql');
    expect(NO_TX_MARKER.test(sql)).toBe(true);
  });

  it('does NOT flag a normal transactional migration as no-tx', () => {
    // 063 mentions the marker only inside a comment paragraph; it must
    // NOT match (the regex anchors on a line that *starts* with the marker).
    const sql = readMig('063_p10_idempotency_keys_tenant_pk.sql');
    expect(NO_TX_MARKER.test(sql)).toBe(false);
  });

  it('splits migration 066 into 8 separate CREATE INDEX statements', () => {
    const sql = readMig('066_ksm_composite_indexes_tenant_agent_id.sql');
    const stmts = splitNoTxStatements(sql);
    expect(stmts).toHaveLength(8);
    for (const stmt of stmts) {
      expect(stmt).toMatch(/^CREATE INDEX CONCURRENTLY IF NOT EXISTS/);
      // No statement may still contain a `;` — that would re-trigger the
      // implicit-transaction wrapping when sent to node-postgres.
      expect(stmt).not.toContain(';');
    }
  });

  it('splits the 066 down migration into 8 DROP INDEX statements', () => {
    const sql = readMig('066_ksm_composite_indexes_tenant_agent_id_down.sql');
    const stmts = splitNoTxStatements(sql);
    expect(stmts).toHaveLength(8);
    for (const stmt of stmts) {
      expect(stmt).toMatch(/^DROP INDEX CONCURRENTLY IF EXISTS/);
    }
  });

  it('strips comments and blank lines (single-statement no-tx file)', () => {
    // Migration 005 is the established single-statement no-tx precedent.
    const sql = readMig('005_audit_mensagem_idx.sql');
    const stmts = splitNoTxStatements(sql);
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toMatch(/^CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_mensagem/);
    expect(stmts[0]).not.toContain('--');
  });

  it('handles trailing-comment and inline-comment lines without leaking them', () => {
    const sql = [
      '-- maia:no-transaction',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS a ON t (x); -- inline note',
      '',
      '-- standalone comment',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS b ON t (y);',
    ].join('\n');
    expect(splitNoTxStatements(sql)).toEqual([
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS a ON t (x)',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS b ON t (y)',
    ]);
  });

  it('importing scripts/migrate.js does not run main() (entrypoint guard)', () => {
    // If `main()` had run on import, this test process would have tried to
    // open a pg.Pool and the suite would hang/fail. Reaching here means the
    // isDirectInvocation guard held. We also assert the guard logic directly.
    expect(isDirectInvocation(undefined, 'file:///whatever.js')).toBe(false);
    expect(
      isDirectInvocation('/some/other/script.ts', 'file:///different.js'),
    ).toBe(false);
  });
});
