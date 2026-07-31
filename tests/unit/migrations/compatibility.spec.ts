/**
 * Issue #516 §6 — schema compatibility, the contract `/readyz`,
 * `maia migrate status` and `maia doctor` (#517) all read.
 *
 * `evaluateCompatibility` is a PURE function over (artifact, ledger), which is
 * what makes these cases possible without Postgres. The states it has to get
 * right are the ones that used to be invisible: an edited migration, a gap in
 * the middle of the chain, dirty state, and the difference between "the
 * database is ahead because we rolled the code back" (fine) and "a merged
 * migration was deleted" (not fine).
 */
import { describe, it, expect } from 'vitest';
import { evaluateCompatibility, firstBlocker } from '@/migrations/compatibility.js';
import { BLOCKS_READINESS, BLOCKS_UP } from '@/migrations/types.js';
import type { DiscoveredMigration, DriftCode, LedgerRow } from '@/migrations/types.js';

function file(id: string, over: Partial<DiscoveredMigration> = {}): DiscoveredMigration {
  return {
    id,
    prefix: id.slice(0, 3),
    path: `/artifact/${id}`,
    noTransaction: false,
    idempotent: false,
    statementTimeoutMs: null,
    checksum: `sum-${id}`,
    downId: `${id.replace('.sql', '')}_down.sql`,
    ...over,
  };
}

function row(id: string, over: Partial<LedgerRow> = {}): LedgerRow {
  return {
    id,
    applied_at: new Date('2026-07-01T00:00:00Z'),
    checksum_sha256: `sum-${id}`,
    checksum_source: 'runner',
    status: 'applied',
    started_at: new Date('2026-07-01T00:00:00Z'),
    execution_ms: 12,
    app_version: 'abc1234',
    runner_version: '2.0.0',
    error_class: null,
    ...over,
  };
}

const ARTIFACT = [file('001_a.sql'), file('002_b.sql'), file('003_c.sql')];

function codes(problems: readonly { code: DriftCode }[]): DriftCode[] {
  return problems.map((p) => p.code);
}

describe('the happy path', () => {
  it('is compatible when every file is applied with a matching checksum', () => {
    const compat = evaluateCompatibility({
      migrations: ARTIFACT,
      rows: ARTIFACT.map((m) => row(m.id)),
    });
    expect(compat.compatible).toBe(true);
    expect(compat.problems).toEqual([]);
    expect(compat.expected_head).toBe('003_c.sql');
    expect(compat.applied_head).toBe('003_c.sql');
    expect(compat.counters.pending_count).toBe(0);
    expect(compat.counters.applied_count).toBe(3);
  });
});

describe('pending work', () => {
  it('lists pending migrations in APPLY order and blocks readiness', () => {
    const compat = evaluateCompatibility({ migrations: ARTIFACT, rows: [row('001_a.sql')] });
    expect(compat.pending).toEqual(['002_b.sql', '003_c.sql']);
    expect(compat.compatible).toBe(false);
    expect(codes(compat.problems)).toContain('pending');
  });

  it('a virgin database is pending, not unknown', () => {
    const compat = evaluateCompatibility({ migrations: ARTIFACT, rows: [] });
    expect(compat.applied_head).toBeNull();
    expect(compat.pending).toHaveLength(3);
  });

  it('catches a GAP IN THE MIDDLE that a head comparison would call ok', () => {
    const compat = evaluateCompatibility({
      migrations: ARTIFACT,
      rows: [row('001_a.sql'), row('003_c.sql')],
    });
    expect(compat.applied_head).toBe('003_c.sql');
    expect(compat.expected_head).toBe('003_c.sql');
    expect(compat.pending).toEqual(['002_b.sql']);
    expect(compat.compatible).toBe(false);
  });
});

describe('append-only violations', () => {
  it('flags an APPLIED migration whose bytes changed', () => {
    const compat = evaluateCompatibility({
      migrations: ARTIFACT,
      rows: ARTIFACT.map((m) => (m.id === '002_b.sql' ? row(m.id, { checksum_sha256: 'edited' }) : row(m.id))),
    });
    expect(codes(compat.problems)).toContain('checksum_mismatch');
    expect(compat.counters.mismatch_count).toBe(1);
    expect(compat.compatible).toBe(false);
    expect(BLOCKS_UP.has('checksum_mismatch')).toBe(true);
  });

  it('does NOT flag a row whose checksum was never recorded (pre-v2 ledger)', () => {
    const compat = evaluateCompatibility({
      migrations: ARTIFACT,
      rows: ARTIFACT.map((m) => row(m.id, { checksum_sha256: null, checksum_source: null })),
    });
    expect(compat.compatible).toBe(true);
  });

  it('flags a merged migration that was DELETED or renamed', () => {
    const compat = evaluateCompatibility({
      migrations: [ARTIFACT[0]!, ARTIFACT[2]!],
      rows: ARTIFACT.map((m) => row(m.id)),
    });
    expect(codes(compat.problems)).toContain('missing_file');
  });

  it('flags a forward migration shipped without its _down sibling', () => {
    const compat = evaluateCompatibility({
      migrations: [file('001_a.sql', { downId: null })],
      rows: [row('001_a.sql')],
    });
    expect(codes(compat.problems)).toContain('missing_down_sibling');
    // Blocks `up` (a build defect), but never drains a healthy fleet.
    expect(BLOCKS_UP.has('missing_down_sibling')).toBe(true);
    expect(BLOCKS_READINESS.has('missing_down_sibling')).toBe(false);
    expect(compat.compatible).toBe(true);
  });

  it('flags a filename with no conforming numeric prefix', () => {
    const compat = evaluateCompatibility({
      migrations: [file('nope.sql', { prefix: null })],
      rows: [row('nope.sql')],
    });
    expect(codes(compat.problems)).toContain('malformed_id');
  });
});

describe('a code rollback (database ahead of the binary)', () => {
  const rows = [...ARTIFACT.map((m) => row(m.id)), row('004_future.sql')];

  it('stays compatible by default — expand/contract is the norm', () => {
    const compat = evaluateCompatibility({ migrations: ARTIFACT, rows });
    expect(compat.compatible).toBe(true);
    expect(compat.applied_head).toBe('004_future.sql');
    // Crucially NOT reported as a deleted migration: it is simply newer.
    expect(codes(compat.problems)).not.toContain('missing_file');
  });

  it('is BLOCKED once the release declares a maximum it can serve', () => {
    const compat = evaluateCompatibility({
      migrations: ARTIFACT,
      rows,
      maxSupported: '003_c.sql',
    });
    expect(compat.compatible).toBe(false);
    expect(codes(compat.problems)).toContain('above_max');
    expect(firstBlocker(compat)?.code).toBe('above_max');
  });
});

describe('the supported range', () => {
  it('defaults min_supported to the expected head (fail-closed)', () => {
    const compat = evaluateCompatibility({ migrations: ARTIFACT, rows: [] });
    expect(compat.min_supported).toBe('003_c.sql');
    expect(compat.max_supported).toBeNull();
  });

  it('blocks a database below the declared minimum', () => {
    const compat = evaluateCompatibility({
      migrations: ARTIFACT,
      rows: [row('001_a.sql')],
      minSupported: '002_b.sql',
    });
    expect(codes(compat.problems)).toContain('below_min');
  });

  it('a widened minimum lets an expand/contract release serve on the old schema', () => {
    const compat = evaluateCompatibility({
      migrations: ARTIFACT,
      rows: [row('001_a.sql'), row('002_b.sql')],
      minSupported: '002_b.sql',
    });
    expect(codes(compat.problems)).not.toContain('below_min');
    // Still pending — widening the range does not make the work disappear.
    expect(codes(compat.problems)).toContain('pending');
  });
});

describe('partial and crashed runs', () => {
  it('never reads DIRTY as success', () => {
    const compat = evaluateCompatibility({
      migrations: ARTIFACT,
      rows: [row('001_a.sql'), row('002_b.sql'), row('003_c.sql', { status: 'dirty', applied_at: null })],
    });
    expect(compat.applied_head).toBe('002_b.sql');
    expect(codes(compat.problems)).toContain('dirty');
    expect(compat.counters.dirty_count).toBe(1);
    expect(compat.compatible).toBe(false);
  });

  it('reports a FAILED transactional migration as recoverable, not partial', () => {
    const compat = evaluateCompatibility({
      migrations: ARTIFACT,
      rows: [row('001_a.sql'), row('002_b.sql', { status: 'failed', error_class: '42P07', applied_at: null })],
    });
    const failed = compat.problems.find((p) => p.code === 'failed');
    expect(failed?.detail).toMatch(/rolled back/);
    expect(failed?.detail).toMatch(/42P07/);
  });

  it('tolerates a FRESH running row (a migrator is working right now)', () => {
    const now = Date.parse('2026-07-31T12:00:00Z');
    const compat = evaluateCompatibility({
      migrations: ARTIFACT,
      rows: [
        row('001_a.sql'),
        row('002_b.sql'),
        row('003_c.sql', { status: 'running', started_at: new Date(now - 5_000), applied_at: null }),
      ],
      now,
    });
    expect(codes(compat.problems)).not.toContain('running_stale');
  });

  it('flags a STALE running row (the migrator crashed)', () => {
    const now = Date.parse('2026-07-31T12:00:00Z');
    const compat = evaluateCompatibility({
      migrations: ARTIFACT,
      rows: [
        row('001_a.sql'),
        row('002_b.sql'),
        row('003_c.sql', { status: 'running', started_at: new Date(now - 3_600_000), applied_at: null }),
      ],
      now,
    });
    expect(codes(compat.problems)).toContain('running_stale');
  });
});

describe('concurrent branches merged out of order', () => {
  it('reports out_of_order as a WARNING and still applies it', () => {
    // 002 merged after 003 did — the exact shape of two branches that each
    // reserved a prefix and passed CI in isolation.
    const compat = evaluateCompatibility({
      migrations: ARTIFACT,
      rows: [row('001_a.sql'), row('003_c.sql')],
    });
    const drift = compat.problems.find((p) => p.code === 'out_of_order');
    expect(drift?.severity).toBe('warn');
    expect(drift?.id).toBe('002_b.sql');
    // Warned, never blocked: refusing here would wedge every normal merge.
    expect(BLOCKS_UP.has('out_of_order')).toBe(false);
    expect(BLOCKS_READINESS.has('out_of_order')).toBe(false);
  });
});

describe('detail strings are safe to return on a public probe', () => {
  it('never carry a DSN, a filesystem path or a driver message', () => {
    const compat = evaluateCompatibility({
      migrations: [file('001_a.sql', { path: '/srv/secret/app/migrations/001_a.sql' })],
      rows: [row('001_a.sql', { checksum_sha256: 'edited' })],
    });
    const text = JSON.stringify(compat.problems);
    expect(text).not.toMatch(/postgres:\/\//);
    expect(text).not.toMatch(/\/srv\/secret/);
  });
});
