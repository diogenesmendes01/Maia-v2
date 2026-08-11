import { describe, it, expect, vi } from 'vitest';
import {
  OPS_LOCK_KEYS,
  OPS_LOCK_NAMESPACE,
  withOpsLock,
  requireOpsLock,
  tryAcquireOpsLock,
  type LockClient,
  type LockPool,
} from '../../../src/ops/backup/single-flight.js';

/**
 * Issue #520 §2 — "lock global/advisory lock para impedir colisão entre cron,
 * CLI e retry" + "um job concorrente retorna 'already running' … sem iniciar
 * segundo dump".
 */

function fakePool(opts: {
  locked?: boolean;
  connectThrows?: boolean;
  queryThrows?: boolean;
  unlockThrows?: boolean;
}): { pool: LockPool; client: LockClient; queries: string[]; released: () => number } {
  const queries: string[] = [];
  let releases = 0;
  const client: LockClient = {
    query: vi.fn(async (text: string) => {
      queries.push(text);
      if (text.includes('pg_try_advisory_lock')) {
        if (opts.queryThrows) throw new Error('boom');
        return { rows: [{ locked: opts.locked ?? true }] } as never;
      }
      if (opts.unlockThrows) throw new Error('unlock boom');
      return { rows: [] } as never;
    }),
    release: vi.fn(() => {
      releases += 1;
    }),
  };
  const pool: LockPool = {
    connect: vi.fn(async () => {
      if (opts.connectThrows) throw new Error('no client');
      return client;
    }),
  };
  return { pool, client, queries, released: () => releases };
}

describe('tryAcquireOpsLock', () => {
  it('uses a namespaced advisory key so it cannot collide with other consumers', async () => {
    const { pool, client } = fakePool({ locked: true });
    await tryAcquireOpsLock(OPS_LOCK_KEYS.backup_run, { pool });
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('pg_try_advisory_lock'), [
      OPS_LOCK_KEYS.backup_run,
      OPS_LOCK_NAMESPACE.toString(),
    ]);
  });

  it('returns null and releases the client when the lock is already held', async () => {
    const { pool, released } = fakePool({ locked: false });
    expect(await tryAcquireOpsLock(OPS_LOCK_KEYS.backup_run, { pool })).toBeNull();
    expect(released()).toBe(1);
  });

  it('returns null (never proceeds unguarded) when connecting fails', async () => {
    const warn = vi.fn();
    const { pool } = fakePool({ connectThrows: true });
    expect(await tryAcquireOpsLock(OPS_LOCK_KEYS.backup_run, { pool, onWarn: warn })).toBeNull();
    expect(warn).toHaveBeenCalledWith('ops_lock.connect_failed', expect.anything());
  });

  it('returns null and releases when the lock query itself errors', async () => {
    const { pool, released } = fakePool({ queryThrows: true });
    expect(await tryAcquireOpsLock(OPS_LOCK_KEYS.backup_run, { pool })).toBeNull();
    expect(released()).toBe(1);
  });

  it('release is idempotent', async () => {
    const { pool, released } = fakePool({ locked: true });
    const lock = await tryAcquireOpsLock(OPS_LOCK_KEYS.backup_run, { pool });
    await lock!.release();
    await lock!.release();
    expect(released()).toBe(1);
  });
});

describe('withOpsLock', () => {
  it('runs the body and releases on success', async () => {
    const { pool, queries, released } = fakePool({ locked: true });
    const out = await withOpsLock(OPS_LOCK_KEYS.backup_run, { pool }, async () => 42);
    expect(out).toEqual({ status: 'ran', result: 42 });
    expect(queries.some((q) => q.includes('pg_advisory_unlock'))).toBe(true);
    expect(released()).toBe(1);
  });

  it('releases even when the body throws (no leaked lock)', async () => {
    const { pool, queries } = fakePool({ locked: true });
    await expect(
      withOpsLock(OPS_LOCK_KEYS.backup_run, { pool }, async () => {
        throw new Error('dump failed');
      }),
    ).rejects.toThrow('dump failed');
    expect(queries.some((q) => q.includes('pg_advisory_unlock'))).toBe(true);
  });

  it('reports already_running WITHOUT invoking the body (no second dump)', async () => {
    const { pool } = fakePool({ locked: false });
    const body = vi.fn();
    const out = await withOpsLock(OPS_LOCK_KEYS.backup_run, { pool }, async () => {
      body();
      return 1;
    });
    expect(out).toEqual({ status: 'already_running' });
    expect(body).not.toHaveBeenCalled();
  });

  it('survives a failing unlock (session end releases it anyway)', async () => {
    const warn = vi.fn();
    const { pool } = fakePool({ locked: true, unlockThrows: true });
    const out = await withOpsLock(OPS_LOCK_KEYS.backup_run, { pool, onWarn: warn }, async () => 7);
    expect(out).toEqual({ status: 'ran', result: 7 });
    expect(warn).toHaveBeenCalledWith('ops_lock.release_failed', expect.anything());
  });
});

describe('requireOpsLock', () => {
  it('throws instead of silently skipping a destructive pass', async () => {
    const { pool } = fakePool({ locked: false });
    await expect(
      requireOpsLock(OPS_LOCK_KEYS.retention_run, { pool }, async () => 1),
    ).rejects.toThrow(/refusing to run a second destructive pass/);
  });
});
