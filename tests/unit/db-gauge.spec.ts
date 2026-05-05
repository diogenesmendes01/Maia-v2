import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Per-test handle to the mock pool.query. Reassigned in `beforeEach` so each
// test starts with a fresh implementation; the factory below reads from this
// closure-captured holder instead of from a top-level `let` so the mock can
// flip between resolve/reject across tests.
const queryImpl = { fn: vi.fn() };

vi.mock('pg', () => {
  // Minimal Pool stub: `client.ts` calls `new pg.Pool(...)`, attaches an
  // 'error' listener, and later invokes `pool.query('SELECT 1')` from the
  // ping timer. We intercept `query` and `on`; everything else stays unset.
  class FakePool {
    on(): this {
      return this;
    }
    query(...args: unknown[]): unknown {
      return queryImpl.fn(...args);
    }
    end(): Promise<void> {
      return Promise.resolve();
    }
    connect(): Promise<unknown> {
      return Promise.resolve({});
    }
  }
  return { default: { Pool: FakePool } };
});

// Drizzle is invoked at module load with the fake pool. The returned object
// is never exercised in this spec, so a bare stub is enough.
vi.mock('drizzle-orm/node-postgres', () => ({
  drizzle: () => ({}),
}));

// Helper: re-import the module fresh after `vi.resetModules()`, so each test
// starts with `cachedDbHealthy = false` and `pingTimerStarted = false`.
async function loadDbClient(): Promise<typeof import('../../src/db/client.js')> {
  return await import('../../src/db/client.js');
}

describe('isDbConnected — DB health gauge', () => {
  beforeEach(() => {
    vi.resetModules();
    queryImpl.fn = vi.fn();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns false before the first ping resolves', async () => {
    // Pending forever — ping never resolves before we read the flag.
    queryImpl.fn = vi.fn(() => new Promise(() => {}));
    const { isDbConnected } = await loadDbClient();

    expect(isDbConnected()).toBe(false);
    // Sanity: lazy timer registration should have triggered exactly one ping.
    expect(queryImpl.fn).toHaveBeenCalledTimes(1);
    expect(queryImpl.fn).toHaveBeenCalledWith('SELECT 1');
  });

  it('flips to true once the ping query resolves', async () => {
    queryImpl.fn = vi.fn(() => Promise.resolve({ rows: [{ '?column?': 1 }] }));
    const { isDbConnected } = await loadDbClient();

    // First call kicks off the lazy ping; the flag is still false until the
    // ping promise has a chance to settle on the microtask queue.
    expect(isDbConnected()).toBe(false);

    // Drain pending microtasks so the `.then(...)` handler runs.
    await Promise.resolve();
    await Promise.resolve();

    expect(isDbConnected()).toBe(true);
  });

  it('stays false when the ping query rejects', async () => {
    queryImpl.fn = vi.fn(() => Promise.reject(new Error('connection refused')));
    const { isDbConnected } = await loadDbClient();

    expect(isDbConnected()).toBe(false);
    // Drain microtasks to let the `.catch(...)` branch run.
    await Promise.resolve();
    await Promise.resolve();

    expect(isDbConnected()).toBe(false);
  });

  it('does not start a second timer across multiple isDbConnected calls', async () => {
    queryImpl.fn = vi.fn(() => Promise.resolve({ rows: [] }));
    const { isDbConnected } = await loadDbClient();

    isDbConnected();
    isDbConnected();
    isDbConnected();

    // Lazy init fires a single immediate ping; subsequent calls are no-ops
    // until the 5s interval ticks.
    expect(queryImpl.fn).toHaveBeenCalledTimes(1);
  });

  it('refreshes the cached flag on the 5s interval tick', async () => {
    let healthy = true;
    queryImpl.fn = vi.fn(() =>
      healthy ? Promise.resolve({ rows: [] }) : Promise.reject(new Error('down')),
    );
    const { isDbConnected } = await loadDbClient();

    isDbConnected();
    await Promise.resolve();
    await Promise.resolve();
    expect(isDbConnected()).toBe(true);

    // Simulate DB going down between ticks.
    healthy = false;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(queryImpl.fn).toHaveBeenCalledTimes(2);
    expect(isDbConnected()).toBe(false);
  });
});
