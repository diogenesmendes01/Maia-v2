/**
 * Rate-limit unit tests with a tiny in-memory Redis stub. Validates the
 * decision logic (allow / warn-once / silence) without spinning a real Redis.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Pessoa } from '../../src/db/schema.js';

type RedisStub = {
  store: Map<string, { value: string; expiresAt?: number }>;
  incr(k: string): Promise<number>;
  expire(k: string, _s: number): Promise<number>;
  set(k: string, v: string, _ex?: 'EX', _s?: number): Promise<'OK'>;
  get(k: string): Promise<string | null>;
};

function makeStub(): RedisStub {
  const store = new Map<string, { value: string; expiresAt?: number }>();
  const get = async (k: string) => {
    const entry = store.get(k);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      store.delete(k);
      return null;
    }
    return entry.value;
  };
  return {
    store,
    async incr(k: string): Promise<number> {
      const cur = Number((await get(k)) ?? '0') + 1;
      store.set(k, { value: String(cur), expiresAt: store.get(k)?.expiresAt });
      return cur;
    },
    async expire(_k, _s) {
      return 1;
    },
    async set(k, v) {
      store.set(k, { value: v });
      return 'OK';
    },
    get,
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

const owner: Pessoa = pessoaFixture('dono');
const stranger: Pessoa = pessoaFixture('funcionario');

function pessoaFixture(tipo: 'dono' | 'co_dono' | 'funcionario'): Pessoa {
  return {
    id: `id-${tipo}`,
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
  beforeEach(() => stub.store.clear());

  it('owner is always allowed (counter still increments)', async () => {
    const { checkRateLimit } = await import('../../src/gateway/rate-limit.js');
    for (let i = 0; i < 10; i++) {
      expect((await checkRateLimit(owner)).kind).toBe('allow');
    }
  });

  it('non-owner: allow up to threshold, then warn once, then silence', async () => {
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
