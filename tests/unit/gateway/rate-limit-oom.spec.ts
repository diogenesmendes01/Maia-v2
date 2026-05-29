/**
 * Issue #309 follow-up (PR #324 B2/W1) — rate-limit classifies OOM vs non-OOM
 * WITHOUT breaking its intentional fail-closed posture.
 *
 * `checkRateLimit` deliberately FAILS CLOSED on any Redis error: non-owner →
 * `silence`, owner → `allow`. That safety posture is KEPT. What this spec
 * proves is that the fault is no longer invisible / unclassified:
 *   - an OOM increments `redis_oom_degraded_total{operation="rate_limit.*"}`,
 *   - any other Redis fault increments `redis_error_total{operation="rate_limit.*"}`,
 *   - in BOTH cases the decision is still the fail-closed `silence` (non-owner),
 *   - the error is NEVER re-thrown (re-throwing would break fail-closed).
 *
 * Covers both try/catch blocks: the sliding-window zset block (zadd/zcard) and
 * the overage get/set block.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { incCounter } from '@/lib/metrics.js';
import type { Pessoa } from '@/db/schema.js';

const { redisStub, logWarn, makeOom } = vi.hoisted(() => {
  const makeOom = () =>
    Object.assign(new Error("OOM command not allowed when used memory > 'maxmemory'."), {
      name: 'ReplyError',
    });
  return {
    redisStub: {
      zremrangebyscore: vi.fn(async () => 0),
      zadd: vi.fn(async () => 1),
      expire: vi.fn(async () => 1),
      zcard: vi.fn(async () => 1),
      get: vi.fn(async () => null),
      set: vi.fn(async () => 'OK'),
    },
    logWarn: vi.fn(),
    makeOom,
  };
});

function detectOom(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: string; code?: string; message?: string };
  if (typeof e.code === 'string' && e.code.toUpperCase() === 'OOM') return true;
  const msg = String(e.message ?? '');
  return (e.name === 'ReplyError' && /^\s*OOM\b/i.test(msg)) || /^\s*OOM command not allowed/i.test(msg);
}

vi.mock('@/lib/redis.js', () => ({
  redis: redisStub,
  isRedisConnected: () => true,
  isRedisOomError: detectOom,
  recordRedisOomDegraded: (caller: string, extra?: Record<string, unknown>) => {
    incCounter('redis_oom_degraded_total', { operation: caller });
    logWarn({ redis_oom: true, caller, ...extra }, 'redis.oom_degraded');
  },
  recordRedisError: (caller: string, extra?: Record<string, unknown>) => {
    incCounter('redis_error_total', { operation: caller });
    logWarn({ redis_error: true, caller, ...extra }, 'redis.error');
  },
}));

vi.mock('@/config/env.js', () => ({ config: { RATE_LIMIT_MSGS_PER_HOUR: 3 } }));
vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: logWarn, error: vi.fn(), debug: vi.fn() },
}));

const { checkRateLimit } = await import('@/gateway/rate-limit.js');
const { _resetForTests, renderPrometheus } = await import('@/lib/metrics.js');

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const AGENT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function pessoaFixture(tipo: 'funcionario' | 'dono' = 'funcionario'): Pessoa {
  return {
    id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
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
  } as Pessoa;
}

function asTenantA<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ tenant_id: TENANT_A, agent_id: AGENT_A }, fn);
}

beforeEach(() => {
  for (const fn of Object.values(redisStub)) (fn as ReturnType<typeof vi.fn>).mockReset();
  redisStub.zremrangebyscore.mockResolvedValue(0);
  redisStub.zadd.mockResolvedValue(1);
  redisStub.expire.mockResolvedValue(1);
  redisStub.zcard.mockResolvedValue(1);
  redisStub.get.mockResolvedValue(null);
  redisStub.set.mockResolvedValue('OK');
  logWarn.mockClear();
  _resetForTests();
});

describe('rate-limit — OOM classification, fail-closed preserved (#309 / PR #324 B2)', () => {
  describe('zset block', () => {
    it('OOM → fail-closed silence (non-owner) + redis_oom_degraded_total{operation="rate_limit.zset"}', async () => {
      redisStub.zadd.mockImplementationOnce(async () => {
        throw makeOom();
      });
      const decision = await asTenantA(() => checkRateLimit(pessoaFixture('funcionario')));
      expect(decision).toEqual({ kind: 'silence' });
      const out = await renderPrometheus();
      expect(out).toContain('redis_oom_degraded_total{operation="rate_limit.zset"} 1');
      expect(out).not.toContain('redis_error_total');
    });

    it('OOM → fail-OPEN allow for owners (still classified)', async () => {
      redisStub.zadd.mockImplementationOnce(async () => {
        throw makeOom();
      });
      const decision = await asTenantA(() => checkRateLimit(pessoaFixture('dono')));
      expect(decision).toEqual({ kind: 'allow' });
      const out = await renderPrometheus();
      expect(out).toContain('redis_oom_degraded_total{operation="rate_limit.zset"} 1');
    });

    it('NON-OOM → still fail-closed silence, but VISIBLE via redis_error_total{operation="rate_limit.zset"} (NOT re-thrown)', async () => {
      const boom = Object.assign(new Error('READONLY You can\'t write against a read only replica.'), {
        name: 'ReplyError',
      });
      redisStub.zadd.mockImplementationOnce(async () => {
        throw boom;
      });
      // Must resolve (fail-closed), not reject — re-throwing would break the posture.
      const decision = await asTenantA(() => checkRateLimit(pessoaFixture('funcionario')));
      expect(decision).toEqual({ kind: 'silence' });
      const out = await renderPrometheus();
      expect(out).toContain('redis_error_total{operation="rate_limit.zset"} 1');
      expect(out).not.toContain('redis_oom_degraded_total');
    });
  });

  describe('overage block', () => {
    // Drive into the overage path: zcard returns above threshold (3) so a
    // non-owner reaches the get/set block.
    beforeEach(() => {
      redisStub.zcard.mockResolvedValue(99);
    });

    it('OOM on the silence GET → fail-closed silence + redis_oom_degraded_total{operation="rate_limit.overage"}', async () => {
      redisStub.get.mockImplementationOnce(async () => {
        throw makeOom();
      });
      const decision = await asTenantA(() => checkRateLimit(pessoaFixture('funcionario')));
      expect(decision).toEqual({ kind: 'silence' });
      const out = await renderPrometheus();
      expect(out).toContain('redis_oom_degraded_total{operation="rate_limit.overage"} 1');
    });

    it('NON-OOM on the overage SET → fail-closed silence, VISIBLE via redis_error_total{operation="rate_limit.overage"} (NOT re-thrown)', async () => {
      // get returns null (not silenced, not warned) → code reaches the SET writes.
      redisStub.get.mockResolvedValue(null);
      const boom = Object.assign(new Error('Connection is closed.'), { code: 'ECONNRESET' });
      redisStub.set.mockImplementationOnce(async () => {
        throw boom;
      });
      const decision = await asTenantA(() => checkRateLimit(pessoaFixture('funcionario')));
      expect(decision).toEqual({ kind: 'silence' });
      const out = await renderPrometheus();
      expect(out).toContain('redis_error_total{operation="rate_limit.overage"} 1');
      expect(out).not.toContain('redis_oom_degraded_total');
    });
  });
});
