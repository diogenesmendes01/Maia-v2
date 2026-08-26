/**
 * Issue #516 §3 — the global migration advisory lock.
 *
 * Driven with an injected clock and an injected sleep, so the waiting
 * behaviour (the part that actually matters when two replicas boot together) is
 * asserted deterministically instead of by timing a real Postgres.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  acquireMigrationLock,
  withMigrationLock,
  MIGRATION_LOCK_KEY,
  MIGRATION_LOCK_NAMESPACE,
  type LockClient,
  type LockPool,
} from '@/migrations/lock.js';
import { OPS_LOCK_NAMESPACE } from '@/ops/backup/single-flight.js';

/** Grants the lock on the Nth attempt; before that reports it as taken. */
function pool(options: {
  grantOnAttempt?: number;
  connectFails?: boolean;
  queryThrows?: boolean;
}): { pool: LockPool; state: { attempts: number; releases: number; queries: string[] } } {
  const state = { attempts: 0, releases: 0, queries: [] as string[] };
  const client: LockClient = {
    query: <R,>(text: string): Promise<{ rows: R[] }> => {
      state.queries.push(text);
      if (text.includes('pg_try_advisory_lock')) {
        state.attempts += 1;
        if (options.queryThrows) return Promise.reject(Object.assign(new Error('boom'), { code: '57P01' }));
        const granted = state.attempts >= (options.grantOnAttempt ?? 1);
        return Promise.resolve({ rows: [{ locked: granted }] as R[] });
      }
      return Promise.resolve({ rows: [] as R[] });
    },
    release: () => {
      state.releases += 1;
    },
  };
  return {
    pool: {
      connect: () =>
        options.connectFails ? Promise.reject(new Error('ECONNREFUSED')) : Promise.resolve(client),
    },
    state,
  };
}

function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 0;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe('lock namespace', () => {
  it('is a fixed, documented key distinct from every other Maia lock keyspace', () => {
    expect(MIGRATION_LOCK_KEY).toBe('maia_schema_migrations');
    expect(MIGRATION_LOCK_NAMESPACE).toBe(5160_5160n);
    // A collision with the ops keyspace would let a backup block a migration.
    expect(MIGRATION_LOCK_NAMESPACE).not.toBe(OPS_LOCK_NAMESPACE);
  });
});

describe('acquireMigrationLock', () => {
  it('acquires on the first attempt and passes the documented key + namespace', async () => {
    const { pool: p, state } = pool({});
    const result = await acquireMigrationLock({ pool: p });
    expect(result.acquired).toBe(true);
    expect(state.attempts).toBe(1);
    expect(state.queries[0]).toContain('pg_try_advisory_lock');
    if (result.acquired) await result.lock.release();
  });

  it('WAITS for a competing migrator instead of failing immediately', async () => {
    const { pool: p, state } = pool({ grantOnAttempt: 3 });
    const c = clock();
    const events: string[] = [];
    const result = await acquireMigrationLock(
      {
        pool: p,
        now: c.now,
        sleep: (ms) => {
          c.advance(ms);
          return Promise.resolve();
        },
        onEvent: (e) => events.push(e),
      },
      { waitMs: 10_000, pollMs: 500 },
    );
    expect(result.acquired).toBe(true);
    expect(state.attempts).toBe(3);
    expect(events.filter((e) => e === 'migration.lock_wait')).toHaveLength(2);
    expect(events).toContain('migration.lock_acquired');
    if (result.acquired) expect(result.waited_ms).toBe(1000);
  });

  it('gives up with a TYPED timeout — it never proceeds unguarded', async () => {
    const { pool: p, state } = pool({ grantOnAttempt: 999 });
    const c = clock();
    const result = await acquireMigrationLock(
      { pool: p, now: c.now, sleep: (ms) => { c.advance(ms); return Promise.resolve(); } },
      { waitMs: 1000, pollMs: 500 },
    );
    expect(result.acquired).toBe(false);
    if (!result.acquired) expect(result.reason).toBe('timeout');
    // The dedicated client is returned to the pool even on the give-up path.
    expect(state.releases).toBe(1);
  });

  it('reports a connect failure as a non-acquisition, not an exception', async () => {
    const { pool: p } = pool({ connectFails: true });
    const result = await acquireMigrationLock({ pool: p });
    expect(result.acquired).toBe(false);
    if (!result.acquired) expect(result.reason).toBe('connect_failed');
  });

  it('reports a query failure by ERROR CLASS only (never the driver message)', async () => {
    const { pool: p, state } = pool({ queryThrows: true });
    const result = await acquireMigrationLock({ pool: p });
    expect(result.acquired).toBe(false);
    if (!result.acquired) {
      expect(result.reason).toBe('query_failed');
      expect(result.error_class).toBe('57P01');
      expect(JSON.stringify(result)).not.toContain('boom');
    }
    expect(state.releases).toBe(1);
  });

  it('releases exactly once even when release() is called twice', async () => {
    const { pool: p, state } = pool({});
    const result = await acquireMigrationLock({ pool: p });
    expect(result.acquired).toBe(true);
    if (!result.acquired) return;
    await result.lock.release();
    await result.lock.release();
    expect(state.queries.filter((q) => q.includes('pg_advisory_unlock'))).toHaveLength(1);
    expect(state.releases).toBe(1);
  });
});

describe('withMigrationLock', () => {
  it('releases the lock when the body THROWS', async () => {
    const { pool: p, state } = pool({});
    await expect(
      withMigrationLock({ pool: p }, {}, () => Promise.reject(new Error('body failed'))),
    ).rejects.toThrow('body failed');
    expect(state.queries.filter((q) => q.includes('pg_advisory_unlock'))).toHaveLength(1);
    expect(state.releases).toBe(1);
  });

  it('returns the non-acquisition unchanged so the caller must handle it', async () => {
    const { pool: p } = pool({ grantOnAttempt: 999 });
    const fn = vi.fn();
    const c = clock();
    const outcome = await withMigrationLock(
      { pool: p, now: c.now, sleep: (ms) => { c.advance(ms); return Promise.resolve(); } },
      { waitMs: 0, pollMs: 100 },
      fn,
    );
    expect(outcome.acquired).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });
});
