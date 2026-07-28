/**
 * Issue #512 — schema/migration version gate.
 *
 * Readiness validates the version; it NEVER applies a migration (explicitly
 * out of scope in the issue). The point is that a process deployed against a
 * database that has not been migrated yet refuses to enter the load-balancer
 * rotation instead of failing at the first query touching a new column.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock('../../../src/db/client.js', () => ({ db: { execute: executeMock } }));
vi.mock('../../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  checkSchemaVersion,
  expectedSchemaVersion,
  _resetSchemaVersionCacheForTests,
} from '../../../src/runtime/lifecycle/schema-version.js';

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
  it('is ok when the applied id matches the newest file', async () => {
    const expected = expectedSchemaVersion()!;
    executeMock.mockResolvedValue({ rows: [{ id: expected }] });
    const r = await checkSchemaVersion();
    expect(r.status).toBe('ok');
    expect(r.applied).toBe(expected);
  });

  it('is PENDING when the database is behind the code (fail-closed for readiness)', async () => {
    executeMock.mockResolvedValue({ rows: [{ id: '001_initial.sql' }] });
    const r = await checkSchemaVersion();
    expect(r.status).toBe('pending');
    expect(r.detail).toMatch(/older than the newest file/i);
  });

  it('is PENDING when schema_migrations is empty', async () => {
    executeMock.mockResolvedValue({ rows: [] });
    const r = await checkSchemaVersion();
    expect(r.status).toBe('pending');
    expect(r.detail).toMatch(/db:migrate/);
  });

  it('is ok when the database is AHEAD (rollback deploy: new schema, older code)', async () => {
    executeMock.mockResolvedValue({ rows: [{ id: '999_future.sql' }] });
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
    executeMock.mockResolvedValue({ rows: [{ id: expectedSchemaVersion()! }] });
    await checkSchemaVersion();
    await checkSchemaVersion();
    await checkSchemaVersion();
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it('tolerates a driver that returns an array instead of a QueryResult', async () => {
    executeMock.mockResolvedValue([{ id: expectedSchemaVersion()! }]);
    const r = await checkSchemaVersion();
    expect(r.status).toBe('ok');
  });
});
