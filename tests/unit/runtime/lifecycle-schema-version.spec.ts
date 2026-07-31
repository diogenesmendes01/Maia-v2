/**
 * Issue #512 — schema/migration version gate, rebuilt on the #516 contract.
 *
 * Readiness validates the version; it NEVER applies a migration (explicitly
 * out of scope in both issues). The point is that a process deployed against a
 * database that has not been migrated yet refuses to enter the load-balancer
 * rotation instead of failing at the first query touching a new column.
 *
 * WHAT #516 CHANGED, and why these cases exist:
 *
 * The gate used to compare ONE id ("newest file on disk" vs. "newest id in
 * schema_migrations"). That answered `ok` for three real broken states — a
 * migration missing from the MIDDLE of the chain, an already-applied migration
 * that had been EDITED, and a no-transaction migration that crashed and left
 * DIRTY state. It now walks the whole ledger through `evaluateCompatibility`,
 * so those three are covered below alongside the original cases.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock('../../../src/db/client.js', () => ({ db: { execute: executeMock } }));
vi.mock('../../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { checksumOf } from '../../../src/migrations/discover.js';
import {
  checkSchemaVersion,
  expectedSchemaVersion,
  _resetSchemaVersionCacheForTests,
} from '../../../src/runtime/lifecycle/schema-version.js';

const MIG_DIR = join(process.cwd(), 'migrations');

/** Every forward migration id, in apply order — the real artifact on disk. */
function forwardIds(): string[] {
  return readdirSync(MIG_DIR)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('_down.sql'))
    .sort();
}

function checksumFor(id: string): string {
  return checksumOf(readFileSync(join(MIG_DIR, id), 'utf8'));
}

/** A ledger where every migration on disk is applied with the right checksum. */
function fullyMigratedRows(): Record<string, unknown>[] {
  return forwardIds().map((id) => ({
    id,
    status: 'applied',
    applied_at: new Date(),
    checksum_sha256: checksumFor(id),
    checksum_source: 'runner',
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetSchemaVersionCacheForTests();
});

describe('expectedSchemaVersion', () => {
  it('is the newest FORWARD migration on disk (never a _down script)', () => {
    const expected = expectedSchemaVersion();
    expect(expected).toBeTruthy();
    expect(expected).toMatch(/^\d{3}_.*\.sql$/);
    expect(expected).not.toMatch(/_down\.sql$/);
  });
});

describe('checkSchemaVersion', () => {
  it('is ok when every migration on disk is applied with a matching checksum', async () => {
    executeMock.mockResolvedValue({ rows: fullyMigratedRows() });
    const r = await checkSchemaVersion();
    expect(r.status).toBe('ok');
    expect(r.applied).toBe(expectedSchemaVersion());
    expect(r.counters?.pending_count).toBe(0);
  });

  it('is PENDING when the database is behind the code (fail-closed for readiness)', async () => {
    executeMock.mockResolvedValue({ rows: [{ id: '001_initial.sql', status: 'applied' }] });
    const r = await checkSchemaVersion();
    expect(r.status).toBe('pending');
    expect(r.code).toBe('pending');
  });

  it('is PENDING when schema_migrations is empty', async () => {
    executeMock.mockResolvedValue({ rows: [] });
    const r = await checkSchemaVersion();
    expect(r.status).toBe('pending');
    expect(r.detail).toMatch(/migrate up/);
  });

  it('is ok when the database is AHEAD (rollback deploy: new schema, older code)', async () => {
    executeMock.mockResolvedValue({
      rows: [...fullyMigratedRows(), { id: '999_future.sql', status: 'applied' }],
    });
    const r = await checkSchemaVersion();
    expect(r.status).toBe('ok');
    expect(r.applied).toBe('999_future.sql');
  });

  it('#516: catches a gap in the MIDDLE of the chain, which a head comparison missed', async () => {
    const rows = fullyMigratedRows();
    const head = rows[rows.length - 1]!;
    // Head is applied; a migration in the middle is not. The old gate said ok.
    executeMock.mockResolvedValue({ rows: [rows[0]!, head] });
    const r = await checkSchemaVersion();
    expect(r.status).toBe('pending');
    expect(r.applied).toBe(expectedSchemaVersion());
  });

  it('#516: refuses when an ALREADY-APPLIED migration was edited (checksum drift)', async () => {
    const rows = fullyMigratedRows();
    rows[0] = { ...rows[0]!, checksum_sha256: 'deadbeef'.repeat(8) };
    executeMock.mockResolvedValue({ rows });
    const r = await checkSchemaVersion();
    expect(r.status).toBe('pending');
    expect(r.code).toBe('checksum_mismatch');
    expect(r.detail).toMatch(/was applied with checksum/);
    expect(r.counters?.mismatch_count).toBe(1);
  });

  it('#516: DIRTY state is never read as success', async () => {
    const rows = fullyMigratedRows();
    rows[rows.length - 1] = { ...rows[rows.length - 1]!, status: 'dirty', applied_at: null };
    executeMock.mockResolvedValue({ rows });
    const r = await checkSchemaVersion();
    expect(r.status).toBe('pending');
    expect(r.code).toBe('dirty');
    expect(r.counters?.dirty_count).toBe(1);
  });

  it('#516: a v1 ledger row (no status column) still counts as applied', async () => {
    // A database that has not applied migration 110 yet has no `status`
    // column at all. The old runner only ever inserted AFTER success, so the
    // honest reading is `applied` — anything else would drain a healthy fleet
    // during the very upgrade that introduces the column.
    executeMock.mockResolvedValue({
      rows: forwardIds().map((id) => ({ id, applied_at: new Date() })),
    });
    const r = await checkSchemaVersion();
    expect(r.status).toBe('ok');
  });

  it('is UNKNOWN on a query failure, and never leaks the driver message', async () => {
    executeMock.mockRejectedValue(new Error('relation "schema_migrations" does not exist'));
    const r = await checkSchemaVersion();
    expect(r.status).toBe('unknown');
    expect(r.detail).toBe('schema version query failed');
    expect(JSON.stringify(r)).not.toMatch(/relation "schema_migrations"/);
  });

  it('caches the answer so an aggressive probe poll is not a query per request', async () => {
    executeMock.mockResolvedValue({ rows: fullyMigratedRows() });
    await checkSchemaVersion();
    await checkSchemaVersion();
    await checkSchemaVersion();
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it('tolerates a driver that returns an array instead of a QueryResult', async () => {
    executeMock.mockResolvedValue(fullyMigratedRows());
    const r = await checkSchemaVersion();
    expect(r.status).toBe('ok');
  });
});
