/**
 * Issue #512 — `ensureRedisConnect()` is FAIL-CLOSED.
 *
 * The regression it fixes: the old implementation caught the connection error
 * and logged a warning, so a process with no Redis kept booting, started HTTP,
 * announced readiness to the load balancer and only failed later — once per
 * inbound message — on the BullMQ, dedup, debouncer and working-memory paths.
 * Redis is a MANDATORY dependency, so AGENTS.md §4.2 makes "log and continue"
 * the wrong default: the boot must stop with an explicit, typed policy.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

class FakeRedis extends EventEmitter {
  status = 'wait';
  connect = vi.fn(async () => {
    this.status = 'connecting';
  });
  ping = vi.fn(async () => 'PONG');
  quit = vi.fn(async () => 'OK');
  /** Drive the ioredis handshake from a test. */
  becomeReady(): void {
    this.status = 'ready';
    this.emit('ready');
  }
  failWith(err: Error): void {
    this.emit('error', err);
  }
}

const { fake } = vi.hoisted(() => ({ fake: { instance: null as unknown } }));

vi.mock('ioredis', () => {
  class Ctor {
    constructor() {
      return fake.instance as object;
    }
  }
  return { default: Ctor };
});
vi.mock('../../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/lib/metrics.js', () => ({ incCounter: vi.fn() }));

let client: FakeRedis;
let ensureRedisConnect: (opts?: { timeoutMs?: number }) => Promise<void>;
let RedisUnavailableError: new (d: string) => Error;

beforeEach(async () => {
  vi.resetModules();
  client = new FakeRedis();
  // ioredis registers its own listeners at module load; keep the fake quiet.
  client.setMaxListeners(50);
  fake.instance = client;
  const mod = await import('../../../src/lib/redis.js');
  ensureRedisConnect = mod.ensureRedisConnect;
  RedisUnavailableError = mod.RedisUnavailableError;
});

describe('ensureRedisConnect — fail-closed', () => {
  it('resolves without reconnecting when the client is already ready', async () => {
    client.status = 'ready';
    await expect(ensureRedisConnect({ timeoutMs: 50 })).resolves.toBeUndefined();
    expect(client.connect).not.toHaveBeenCalled();
  });

  it('connects and resolves once the client reports ready', async () => {
    const p = ensureRedisConnect({ timeoutMs: 500 });
    await new Promise((r) => setImmediate(r));
    expect(client.connect).toHaveBeenCalledTimes(1);
    client.becomeReady();
    await expect(p).resolves.toBeUndefined();
  });

  it('THROWS a typed RedisUnavailableError when the connect attempt fails', async () => {
    client.connect.mockRejectedValueOnce(new Error('ECONNREFUSED 127.0.0.1:6379'));
    await expect(ensureRedisConnect({ timeoutMs: 100 })).rejects.toBeInstanceOf(
      RedisUnavailableError,
    );
  });

  it('THROWS when the client never becomes ready within the timeout', async () => {
    const p = ensureRedisConnect({ timeoutMs: 30 });
    await expect(p).rejects.toThrow(/redis unavailable at startup/i);
  });

  it('THROWS on a connection error emitted while waiting for ready', async () => {
    const p = ensureRedisConnect({ timeoutMs: 2000 });
    await new Promise((r) => setImmediate(r));
    client.failWith(new Error('ECONNREFUSED'));
    await expect(p).rejects.toBeInstanceOf(RedisUnavailableError);
  });

  it('does NOT re-initiate a connect that is already in flight, but still waits for ready', async () => {
    client.status = 'connecting';
    const p = ensureRedisConnect({ timeoutMs: 500 });
    await new Promise((r) => setImmediate(r));
    expect(client.connect).not.toHaveBeenCalled();
    client.becomeReady();
    await expect(p).resolves.toBeUndefined();
  });

  it('carries the failure detail but is recognisable by its code', async () => {
    client.connect.mockRejectedValueOnce(new Error('AUTH failed'));
    await ensureRedisConnect({ timeoutMs: 50 }).catch((err: Error & { code?: string }) => {
      expect(err.code).toBe('REDIS_UNAVAILABLE');
      expect(err.message).toMatch(/AUTH failed/);
    });
    expect.assertions(2);
  });
});
