import { describe, it, expect } from 'vitest';
import {
  CRITICAL_TABLES,
  RESTORE_DRILL_PROBES,
  gradeProbeSuite,
  type ProbeContext,
  type ProbeRow,
} from '../../../src/ops/backup/drill-probes.js';

/**
 * Issue #536 §1 — the probe suite that replaced `SELECT count(*) FROM transacoes`.
 *
 * Every grader is pure, so the interesting cases (the query failed, the table
 * is missing, the database restored EMPTY, the ledger did not come back) are
 * all reachable without Postgres.
 */

const CTX: ProbeContext = { manifest_migration_head: '107_runtime_trace_attempt_grouping.sql' };

function spec(id: string) {
  const found = RESTORE_DRILL_PROBES.find((p) => p.id === id);
  if (!found) throw new Error(`no probe '${id}'`);
  return found;
}

/** Rows for a snapshot that restored perfectly. */
function healthyRows(over: Record<string, ProbeRow | null> = {}): Record<string, ProbeRow | null> {
  return {
    core_tables_present: { present: CRITICAL_TABLES.length },
    tenant_seed_present: { tenants: 1, agents: 2 },
    tenant_scope_valid: { unscoped_mensagens: 0, unscoped_conversas: 0 },
    conversation_integrity: { orphan_mensagens: 0 },
    tombstone_ledger_restored: { tombstones: 0 },
    financial_rows_readable: { transacoes: 42 },
    audit_trail_readable: { audit_logs: 1000 },
    outbox_dispatchable: { pending: 0 },
    migration_head_matches: { head: CTX.manifest_migration_head, applied: 97 },
    ...over,
  };
}

describe('restore drill probes — the suite goes beyond `transacoes`', () => {
  it('grades a healthy snapshot as passed with no warnings', () => {
    const result = gradeProbeSuite(healthyRows(), CTX);
    expect(result.passed).toBe(true);
    expect(result.failed_required).toEqual([]);
    expect(result.warned).toEqual([]);
    expect(Object.keys(result.probes).sort()).toEqual(
      RESTORE_DRILL_PROBES.map((p) => p.id).sort(),
    );
  });

  it('covers more than the baseline probe: financial rows are ONE of several required probes', () => {
    const required = RESTORE_DRILL_PROBES.filter((p) => p.required).map((p) => p.id);
    expect(required).toContain('financial_rows_readable');
    // The point of the issue: a drill that only counts `transacoes` proves
    // nothing about schema, scope, integrity or the ledger.
    expect(required.length).toBeGreaterThan(4);
    expect(required).toEqual(
      expect.arrayContaining([
        'core_tables_present',
        'tenant_seed_present',
        'tenant_scope_valid',
        'conversation_integrity',
        'tombstone_ledger_restored',
      ]),
    );
  });

  /**
   * The failure this replaces: `pg_restore` can exit 0 having skipped objects.
   */
  it('fails when a critical table did not come back', () => {
    const result = gradeProbeSuite(
      healthyRows({ core_tables_present: { present: CRITICAL_TABLES.length - 2 } }),
      CTX,
    );
    expect(result.passed).toBe(false);
    expect(result.failed_required).toContain('core_tables_present');
    expect(result.probes.core_tables_present?.detail.missing).toBe(2);
  });

  it('fails an EMPTY database that restored without a single error', () => {
    const result = gradeProbeSuite(
      healthyRows({ tenant_seed_present: { tenants: 0, agents: 0 } }),
      CTX,
    );
    expect(result.passed).toBe(false);
    expect(result.failed_required).toContain('tenant_seed_present');
  });

  it('fails when the restored snapshot carries unscoped or `default` rows', () => {
    const result = gradeProbeSuite(
      healthyRows({ tenant_scope_valid: { unscoped_mensagens: 3, unscoped_conversas: 0 } }),
      CTX,
    );
    expect(result.passed).toBe(false);
    expect(result.failed_required).toContain('tenant_scope_valid');
    expect(result.probes.tenant_scope_valid?.detail.unscoped_mensagens).toBe(3);
  });

  it('fails on orphaned messages (a torn restore)', () => {
    const result = gradeProbeSuite(
      healthyRows({ conversation_integrity: { orphan_mensagens: 7 } }),
      CTX,
    );
    expect(result.passed).toBe(false);
    expect(result.failed_required).toContain('conversation_integrity');
  });

  it('fails when the tombstone ledger did not survive the restore', () => {
    // `null` = the query threw, e.g. the table is not there.
    const result = gradeProbeSuite(healthyRows({ tombstone_ledger_restored: null }), CTX);
    expect(result.passed).toBe(false);
    expect(result.failed_required).toContain('tombstone_ledger_restored');
    expect(result.probes.tombstone_ledger_restored?.detail.error).toBe('query_failed');
  });

  /**
   * A probe the executor never ran must not be able to produce a passing
   * drill — "absent" is the shape a silent skip takes.
   */
  it('treats a MISSING probe result exactly like a failed query', () => {
    const rows = healthyRows();
    delete rows.conversation_integrity;
    const result = gradeProbeSuite(rows, CTX);
    expect(result.passed).toBe(false);
    expect(result.failed_required).toContain('conversation_integrity');
  });

  it('grades an entirely empty result set as failed, never as passed', () => {
    const result = gradeProbeSuite({}, CTX);
    expect(result.passed).toBe(false);
    expect(result.failed_required.length).toBeGreaterThan(0);
  });

  it('records a dispatchable outbox as a WARNING, not a drill failure', () => {
    const result = gradeProbeSuite(healthyRows({ outbox_dispatchable: { pending: 12 } }), CTX);
    // Informational: a snapshot legitimately has pending effects. The COUNT is
    // what the operator needs before releasing traffic (runbook §3.7).
    expect(result.passed).toBe(true);
    expect(result.warned).toContain('outbox_dispatchable');
    expect(result.probes.outbox_dispatchable?.detail.pending).toBe(12);
  });

  it('records a migration-head divergence as a warning and reports both heads', () => {
    const result = gradeProbeSuite(
      healthyRows({ migration_head_matches: { head: '097_agent_turns.sql', applied: 90 } }),
      CTX,
    );
    expect(result.passed).toBe(true);
    expect(result.warned).toContain('migration_head_matches');
    expect(result.probes.migration_head_matches?.detail).toMatchObject({
      snapshot_head: '097_agent_turns.sql',
      manifest_head: CTX.manifest_migration_head,
      matches: false,
    });
  });

  it('does not grade the migration head when the manifest makes no claim', () => {
    const result = gradeProbeSuite(healthyRows({ migration_head_matches: { head: 'x.sql', applied: 1 } }), {
      manifest_migration_head: null,
    });
    expect(result.warned).not.toContain('migration_head_matches');
  });

  it('accepts the string counts a driver may return for ::int columns', () => {
    const result = gradeProbeSuite(
      healthyRows({ tenant_seed_present: { tenants: '1', agents: '2' } }),
      CTX,
    );
    expect(result.passed).toBe(true);
  });

  /**
   * Issue §7: "guarda BOOLEANOS e CONTAGENS — nunca valores de linha". The
   * probes JSON is persisted and lands inside the NEXT dump, so a probe that
   * echoed a row value would copy personal data forward.
   */
  it('emits only scalars — no row values, no objects, no arrays', () => {
    const result = gradeProbeSuite(healthyRows(), CTX);
    for (const verdict of Object.values(result.probes)) {
      expect(typeof verdict.ok).toBe('boolean');
      for (const value of Object.values(verdict.detail)) {
        expect(['number', 'string', 'boolean', 'object']).toContain(typeof value);
        if (typeof value === 'object') expect(value).toBeNull();
      }
    }
  });

  it('every probe SQL returns a single row and selects no raw column', () => {
    for (const p of RESTORE_DRILL_PROBES) {
      // `count(*)`, `max(id)` on a migration filename, or a boolean — never
      // `SELECT telefone`, `SELECT conteudo`, `SELECT *`.
      expect(p.sql).not.toMatch(/select\s+\*/i);
      expect(p.sql).toMatch(/count\(|max\(/i);
    }
  });

  it('a probe grader never throws on a malformed row', () => {
    for (const p of RESTORE_DRILL_PROBES) {
      expect(() => p.grade({ nonsense: Symbol('x') as unknown as string }, CTX)).not.toThrow();
      expect(() => p.grade(null, CTX)).not.toThrow();
    }
  });

  it('spec ids are unique and stable (they are JSON keys and metric labels)', () => {
    const ids = RESTORE_DRILL_PROBES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it('the critical-table list is embedded in the structural probe', () => {
    for (const table of CRITICAL_TABLES) {
      expect(spec('core_tables_present').sql).toContain(`'${table}'`);
    }
  });
});
