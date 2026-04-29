/**
 * Rate-limit unit tests with a tiny in-memory Redis stub. Validates the
 * decision logic (allow / warn-once / silence) plus sliding-window and
 * silence-expiry behavior using fake timers — without spinning real Redis.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Pessoa } from '../../src/db/schema.js';

type Entry = { value: string; expiresAt?: number };
type ZEntry = { score: number; member: string };

type RedisStub = {
  store: Map<string, Entry>;
  zsets: Map<string, ZEntry[]>;
  ttls: Map<string, number>;
  get(k: string): Promise<string | null>;
  set(k: string, v: string, ex?: 'EX', s?: number): Promise<'OK'>;
  expire(k: string, s: number): Promise<number>;
  incr(k: string): Promise<number>;
  zadd(k: string, score: number, member: string): Promise<number>;
  zcard(k: string): Promise<number>;
  zremrangebyscore(k: string, min: number, max: number): Promise<number>;
};

function makeStub(): RedisStub {
  const store = new Map<string, Entry>();
  const zsets = new Map<string, ZEntry[]>();
  const ttls = new Map<string, number>();

  const evictIfExpired = (k: string): void => {
    const entry = store.get(k);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      store.delete(k);
    }
    const zttl = ttls.get(k);
    if (zttl !== undefined && zttl <= Date.now()) {
      zsets.delete(k);
      ttls.delete(k);
    }
  };

  return {
    store,
    zsets,
    ttls,
    async get(k) {
      evictIfExpired(k);
      return store.get(k)?.value ?? null;
    },
    async set(k, v, ex, s) {
      const expiresAt = ex === 'EX' && typeof s === 'number' ? Date.now() + s * 1000 : undefined;
      store.set(k, { value: v, expiresAt });
      return 'OK';
    },
    async expire(k, s) {
      const e = store.get(k);
      if (e) e.expiresAt = Date.now() + s * 1000;
      if (zsets.has(k)) ttls.set(k, Date.now() + s * 1000);
      return e || zsets.has(k) ? 1 : 0;
    },
    async incr(k) {
      evictIfExpired(k);
      const cur = Number(store.get(k)?.value ?? '0') + 1;
      store.set(k, { value: String(cur), expiresAt: store.get(k)?.expiresAt });
      return cur;
    },
    async zadd(k, score, member) {
      evictIfExpired(k);
      const arr = zsets.get(k) ?? [];
      arr.push({ score, member });
      zsets.set(k, arr);
      return 1;
    },
    async zcard(k) {
      evictIfExpired(k);
      return zsets.get(k)?.length ?? 0;
    },
    async zremrangebyscore(k, min, max) {
      evictIfExpired(k);
      const arr = zsets.get(k);
      if (!arr) return 0;
      const before = arr.length;
      const kept = arr.filter((e) => e.score < min || e.score > max);
      zsets.set(k, kept);
      return before - kept.length;
    },
  };
}

const stub = makeStub();

vi.mock('../../src/lib/redis.js', () => ({
  redis: stub,
  isRedisConnected: () => true,
}));

vi.mock('../../src/config/env.js', () => ({
  config: { RATE_LIMIT_MSGS_PER_HOUR: 3 },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  },
}));

function pessoaFixture(tipo: 'dono' | 'co_dono' | 'funcionario'): Pessoa {
  return {
    id: `id-${tipo}-${Math.random().toString(36).slice(2, 6)}`,
    nome: tipo,
    apelido: null,
    telefone_whatsapp: '+55',
    tipo,
    email: null,
    observacoes: null,
    preferencias: {},
    modelo_mental: {},
    status: 'ativa',
    created_at: new Date(),
    updated_at: new Date(),
  };
}

describe('rate-limit decision', () => {
  beforeEach(() => {
    stub.store.clear();
    stub.zsets.clear();
    stub.ttls.clear();
  });

  it('owner is always allowed (counter still increments)', async () => {
    const owner = pessoaFixture('dono');
    const { checkRateLimit } = await import('../../src/gateway/rate-limit.js');
    for (let i = 0; i < 10; i++) {
      expect((await checkRateLimit(owner)).kind).toBe('allow');
    }
  });

  it('non-owner: allow up to threshold, then warn once, then silence', async () => {
    const stranger = pessoaFixture('funcionario');
    const { checkRateLimit } = await import('../../src/gateway/rate-limit.js');
    expect((await checkRateLimit(stranger)).kind).toBe('allow');
    expect((await checkRateLimit(stranger)).kind).toBe('allow');
    expect((await checkRateLimit(stranger)).kind).toBe('allow');
    const overage = await checkRateLimit(stranger);
    expect(overage.kind).toBe('warn');
    if (overage.kind === 'warn') {
      expect(overage.threshold).toBe(3);
      expect(overage.count).toBe(4);
    }
    expect((await checkRateLimit(stranger)).kind).toBe('silence');
    expect((await checkRateLimit(stranger)).kind).toBe('silence');
  });

  it('formatPoliteReply substitutes the threshold', async () => {
    const { formatPoliteReply } = await import('../../src/gateway/rate-limit.js');
    expect(formatPoliteReply(30)).toContain('30');
  });
});

describe('rate-limit sliding window (fake timers)', () => {
  beforeEach(() => {
    stub.store.clear();
    stub.zsets.clear();
    stub.ttls.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T10:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('window slides — events older than 1h drop out, allowing fresh ones', async () => {
    const stranger = pessoaFixture('funcionario');
    const { checkRateLimit } = await import('../../src/gateway/rate-limit.js');

    // 3 messages at 10:00 — fills the threshold exactly.
    expect((await checkRateLimit(stranger)).kind).toBe('allow');
    expect((await checkRateLimit(stranger)).kind).toBe('allow');
    expect((await checkRateLimit(stranger)).kind).toBe('allow');

    // Advance >1h. With a fixed window the counter would reset entirely AND
    // the warned key wouldn't exist; with a true sliding window, the original
    // 3 events leave the trailing-hour view, so the next 3 are also allowed.
    vi.setSystemTime(new Date('2026-01-01T11:00:01Z'));

    expect((await checkRateLimit(stranger)).kind).toBe('allow');
    expect((await checkRateLimit(stranger)).kind).toBe('allow');
    expect((await checkRateLimit(stranger)).kind).toBe('allow');
    // 4th in the new sliding hour → warn.
    expect((await checkRateLimit(stranger)).kind).toBe('warn');
  });

  it('silence expires after 60s but warned-flag persists, so re-overage stays silent', async () => {
    const stranger = pessoaFixture('funcionario');
    const { checkRateLimit } = await import('../../src/gateway/rate-limit.js');

    // Saturate threshold (3 allowed) then trigger warn (4th).
    for (let i = 0; i < 3; i++) await checkRateLimit(stranger);
    expect((await checkRateLimit(stranger)).kind).toBe('warn');
    expect((await checkRateLimit(stranger)).kind).toBe('silence');

    // 61s later — silence key has expired, but warned key (1h TTL) survives.
    // Next over-threshold call must re-arm silence, not emit a second reply.
    vi.setSystemTime(Date.now() + 61_000);
    const next = await checkRateLimit(stranger);
    expect(next.kind).toBe('silence');
  });
});
