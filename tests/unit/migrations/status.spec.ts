/**
 * Issue #516 §2/§6 — the fail-closed decision core.
 *
 * These are the rules that decide whether production traffic is allowed onto a
 * schema. They are pure, so they get exhaustive coverage here rather than
 * partial coverage behind a live database. The bar throughout: anything that is
 * not "verified applied with a matching checksum" must NOT be ready.
 */
import { describe, it, expect } from 'vitest';
import { buildMigrationArtifact, type MigrationSource } from '@/migrations/discover.js';
import {
  computeMigrationStatus,
  defaultCompatibilityManifest,
  evaluateSchemaReadiness,
  unknownReadiness,
} from '@/migrations/status.js';
import { migrationChecksum } from '@/migrations/checksum.js';
import type { LedgerEntry, LedgerStatus, MigrationArtifact } from '@/migrations/types.js';

const A = 'BEGIN;\nCREATE TABLE a (id TEXT);\nCOMMIT;\n';
const B = 'BEGIN;\nCREATE TABLE b (id TEXT);\nCOMMIT;\n';

function artifact(): MigrationArtifact {
  const sources: MigrationSource[] = [
    { filename: '001_a.sql', contents: A },
    { filename: '002_b.sql', contents: B },
  ];
  return buildMigrationArtifact(sources, ['001_a_down.sql', '002_b_down.sql']);
}

function row(id: string, over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id,
    checksum_sha256: null,
    checksum_source: null,
    status: 'applied' as LedgerStatus,
    started_at: null,
    applied_at: '2026-01-01T00:00:00.000Z',
    execution_ms: 12,
    app_version: '3.1.0',
    runner_version: '2.0.0',
    error_class: null,
    repaired_at: null,
    repair_reason: null,
    ...over,
  };
}

const appliedA = row('001_a.sql', { checksum_sha256: migrationChecksum(A), checksum_source: 'computed' });
const appliedB = row('002_b.sql', { checksum_sha256: migrationChecksum(B), checksum_source: 'computed' });

const now = () => new Date('2026-08-04T12:00:00.000Z');

describe('computeMigrationStatus — per-migration classification', () => {
  it('classifies a fully applied, checksum-matching schema', () => {
    const status = computeMigrationStatus(artifact(), [appliedA, appliedB]);
    expect(status.entries.map((e) => e.state)).toEqual(['applied', 'applied']);
    expect(status.pending).toEqual([]);
    expect(status.applied_head).toBe('002_b.sql');
    expect(status.expected_head).toBe('002_b.sql');
    expect(status.counts.applied).toBe(2);
  });

  it('classifies an unrecorded migration as pending (not an error)', () => {
    const status = computeMigrationStatus(artifact(), [appliedA]);
    expect(status.pending).toEqual(['002_b.sql']);
    expect(status.entries[1]!.blocking).toBe(false);
    expect(status.applied_head).toBe('001_a.sql');
  });

  it('classifies an edited applied migration as checksum_mismatch (blocking)', () => {
    const status = computeMigrationStatus(artifact(), [
      row('001_a.sql', { checksum_sha256: migrationChecksum('DROP TABLE a;'), checksum_source: 'computed' }),
      appliedB,
    ]);
    expect(status.entries[0]!.state).toBe('checksum_mismatch');
    expect(status.entries[0]!.blocking).toBe(true);
    expect(status.counts.checksum_mismatch).toBe(1);
  });

  it('classifies an applied row with NO checksum as checksum_unknown (blocking)', () => {
    const status = computeMigrationStatus(artifact(), [row('001_a.sql'), appliedB]);
    expect(status.entries[0]!.state).toBe('checksum_unknown');
    expect(status.entries[0]!.blocking).toBe(true);
  });

  it('classifies a ledger row with no file as missing_file (blocking)', () => {
    const status = computeMigrationStatus(artifact(), [appliedA, appliedB, row('003_ghost.sql')]);
    const ghost = status.entries.find((e) => e.id === '003_ghost.sql')!;
    expect(ghost.state).toBe('missing_file');
    expect(ghost.blocking).toBe(true);
    // It is still counted as the applied head — the DB really did run it.
    expect(status.applied_head).toBe('003_ghost.sql');
  });

  it('classifies dirty as blocking and never as pending', () => {
    const status = computeMigrationStatus(artifact(), [appliedA, row('002_b.sql', { status: 'dirty' })]);
    expect(status.entries[1]!.state).toBe('dirty');
    expect(status.entries[1]!.blocking).toBe(true);
    expect(status.pending).not.toContain('002_b.sql');
  });

  it('classifies failed as retryable — a rolled-back transaction left nothing', () => {
    const status = computeMigrationStatus(artifact(), [
      appliedA,
      row('002_b.sql', { status: 'failed', error_class: '42P07' }),
    ]);
    expect(status.entries[1]!.state).toBe('failed');
    expect(status.entries[1]!.blocking).toBe(false);
    expect(status.pending).toEqual(['002_b.sql']);
  });

  it('reads `running` as ambiguous-and-blocking for a read-only caller', () => {
    const status = computeMigrationStatus(artifact(), [appliedA, row('002_b.sql', { status: 'running' })]);
    expect(status.entries[1]!.state).toBe('running');
    expect(status.entries[1]!.blocking).toBe(true);
  });

  it('reads `running` as ORPHANED when the caller holds the exclusive lock', () => {
    const status = computeMigrationStatus(
      artifact(),
      [appliedA, row('002_b.sql', { status: 'running' })],
      { lockHeld: true },
    );
    expect(status.entries[1]!.state).toBe('orphaned_running');
    expect(status.entries[1]!.blocking).toBe(true);
    expect(status.counts.orphaned_running).toBe(1);
  });

  it('reports out-of-order pending migrations without blocking them', () => {
    const three = buildMigrationArtifact(
      [
        { filename: '001_a.sql', contents: A },
        { filename: '002_b.sql', contents: B },
        { filename: '003_c.sql', contents: 'SELECT 1;\n' },
      ],
      ['001_a_down.sql', '002_b_down.sql', '003_c_down.sql'],
    );
    // 003 applied, 002 never was — a branch merged out of order.
    const status = computeMigrationStatus(three, [
      appliedA,
      row('003_c.sql', { checksum_sha256: migrationChecksum('SELECT 1;\n'), checksum_source: 'computed' }),
    ]);
    expect(status.out_of_order).toEqual(['002_b.sql']);
    expect(status.pending).toEqual(['002_b.sql']);
    expect(status.entries.find((e) => e.id === '002_b.sql')!.blocking).toBe(false);
  });

  it('propagates artifact problems (missing down sibling) into the report', () => {
    const broken = buildMigrationArtifact([{ filename: '001_a.sql', contents: A }], []);
    const status = computeMigrationStatus(broken, []);
    expect(status.problems.map((p) => p.kind)).toEqual(['missing_down_sibling']);
  });

  it('marks the ledger absent when it could not be read', () => {
    const status = computeMigrationStatus(artifact(), [], { ledgerPresent: false, ledgerVersion: null });
    expect(status.ledger_present).toBe(false);
    expect(status.ledger_version).toBeNull();
  });
});

describe('defaultCompatibilityManifest', () => {
  it('demands the build own head and declares no ceiling', () => {
    const manifest = defaultCompatibilityManifest(artifact());
    expect(manifest).toEqual({
      schema_manifest_version: 1,
      expected_head: '002_b.sql',
      min_supported_migration: '002_b.sql',
      max_supported_migration: null,
    });
  });
});

describe('evaluateSchemaReadiness — fail-closed', () => {
  const manifest = defaultCompatibilityManifest(artifact());

  it('is ready only when everything is applied and verified', () => {
    const readiness = evaluateSchemaReadiness(
      computeMigrationStatus(artifact(), [appliedA, appliedB]),
      manifest,
      { now },
    );
    expect(readiness.ready).toBe(true);
    expect(readiness.state).toBe('ready');
    expect(readiness.blockers).toEqual([]);
    expect(readiness.reason).toBeNull();
    expect(readiness.checked_at).toBe('2026-08-04T12:00:00.000Z');
  });

  it('is UNKNOWN — never ready — when the ledger is absent', () => {
    const readiness = evaluateSchemaReadiness(
      computeMigrationStatus(artifact(), [], { ledgerPresent: false }),
      manifest,
      { now },
    );
    expect(readiness.ready).toBe(false);
    expect(readiness.state).toBe('unknown');
    expect(readiness.blockers[0]!.kind).toBe('ledger_missing');
  });

  it('blocks on a dirty migration', () => {
    const readiness = evaluateSchemaReadiness(
      computeMigrationStatus(artifact(), [appliedA, row('002_b.sql', { status: 'dirty' })]),
      manifest,
      { now },
    );
    expect(readiness.ready).toBe(false);
    expect(readiness.state).toBe('blocked');
    expect(readiness.blockers.map((b) => b.kind)).toContain('dirty_migration');
    expect(readiness.dirty_count).toBe(1);
  });

  it('blocks on a checksum mismatch', () => {
    const readiness = evaluateSchemaReadiness(
      computeMigrationStatus(artifact(), [
        row('001_a.sql', { checksum_sha256: 'deadbeef'.repeat(8), checksum_source: 'computed' }),
        appliedB,
      ]),
      manifest,
      { now },
    );
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.map((b) => b.kind)).toContain('checksum_mismatch');
  });

  it('blocks on an applied migration with an unknown checksum', () => {
    const readiness = evaluateSchemaReadiness(
      computeMigrationStatus(artifact(), [row('001_a.sql'), appliedB]),
      manifest,
      { now },
    );
    expect(readiness.blockers.map((b) => b.kind)).toContain('checksum_unknown');
  });

  it('blocks when the database ran a migration this build does not ship', () => {
    const readiness = evaluateSchemaReadiness(
      computeMigrationStatus(artifact(), [appliedA, appliedB, row('009_future.sql')]),
      manifest,
      { now },
    );
    expect(readiness.blockers.map((b) => b.kind)).toContain('missing_file');
  });

  it('blocks a schema BELOW the minimum this build supports', () => {
    const readiness = evaluateSchemaReadiness(
      computeMigrationStatus(artifact(), [appliedA]),
      manifest,
      { now },
    );
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.map((b) => b.kind)).toContain('schema_below_minimum');
    expect(readiness.pending_count).toBe(1);
  });

  it('allows a schema below head when the build lowers its minimum (expand/contract)', () => {
    const tolerant = { ...manifest, min_supported_migration: '001_a.sql' };
    const readiness = evaluateSchemaReadiness(
      computeMigrationStatus(artifact(), [appliedA]),
      tolerant,
      { now },
    );
    expect(readiness.ready).toBe(true);
    expect(readiness.pending_count).toBe(1);
  });

  it('blocks an OLD build against a schema above its ceiling', () => {
    const old = {
      schema_manifest_version: 1 as const,
      expected_head: '001_a.sql',
      min_supported_migration: '001_a.sql',
      max_supported_migration: '001_a.sql',
    };
    const oldArtifact = buildMigrationArtifact([{ filename: '001_a.sql', contents: A }], ['001_a_down.sql']);
    const readiness = evaluateSchemaReadiness(
      computeMigrationStatus(oldArtifact, [appliedA, appliedB]),
      old,
      { now },
    );
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.map((b) => b.kind)).toContain('schema_above_maximum');
  });

  it('does NOT block readiness on repository-integrity problems', () => {
    // A missing `_down` sibling stops `migrate up`, but says nothing about
    // whether the schema already in the database is compatible.
    const broken = buildMigrationArtifact([{ filename: '001_a.sql', contents: A }], []);
    const readiness = evaluateSchemaReadiness(
      computeMigrationStatus(broken, [appliedA]),
      { ...manifest, expected_head: '001_a.sql', min_supported_migration: '001_a.sql' },
      { now },
    );
    expect(readiness.ready).toBe(true);
    expect(readiness.status?.problems.map((p) => p.kind)).toEqual(['missing_down_sibling']);
  });

  it('never leaks connection strings or SQL through blocker text', () => {
    const readiness = evaluateSchemaReadiness(
      computeMigrationStatus(artifact(), [appliedA, row('002_b.sql', { status: 'dirty' })]),
      manifest,
      { now },
    );
    const serialised = JSON.stringify(readiness);
    expect(serialised).not.toMatch(/postgres:\/\//);
    expect(serialised).not.toMatch(/CREATE TABLE/);
    expect(serialised).not.toMatch(/password/i);
  });
});

describe('unknownReadiness', () => {
  it('is never ready and carries the ledger_unavailable blocker', () => {
    const readiness = unknownReadiness(defaultCompatibilityManifest(artifact()), 'db down', { now });
    expect(readiness.ready).toBe(false);
    expect(readiness.state).toBe('unknown');
    expect(readiness.blockers[0]!.kind).toBe('ledger_unavailable');
    expect(readiness.status).toBeNull();
  });
});
