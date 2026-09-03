/**
 * Issue #507 — o prazo que o `TurnExecutionContext` carrega tem de ser o
 * horizonte VIGENTE da lease, não uma fotografia do começo da tentativa.
 *
 * ─── Por que este arquivo existe ────────────────────────────────────────────
 *
 * `TurnLease.context()` é chamado UMA vez, logo depois do claim, e o objeto
 * resultante vive no `AsyncLocalStorage` pelo turno inteiro. O heartbeat, em
 * paralelo, EMPURRA `lease_expires_at` a cada renovação bem-sucedida.
 *
 * Enquanto ninguém lia `deadline`, o campo era dado morto e a distinção não
 * aparecia. A #507 passou a lê-lo no dispatcher para recusar uma ferramenta sem
 * orçamento — e aí um `Date` congelado vira defeito: um turno mais longo que o
 * TTL inicial (60 s por padrão) veria prazo negativo com a lease VIVA e
 * renovada, e toda ferramenta seria recusada com `turn_deadline_exceeded`.
 *
 * Isso é o mesmo tipo de mentira que a issue fecha, só que na outra direção:
 * afirmar que o tempo acabou quando ele não acabou.
 *
 * O teste não observa o getter (isso seria testar a sintaxe); observa o
 * COMPORTAMENTO: renovação real do heartbeat → o prazo lido depois é maior que
 * o lido antes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { repo } = vi.hoisted(() => ({
  repo: {
    renovacoes: 0,
    proximoVencimento: new Date(),
  },
}));

vi.mock('@/db/repositories/turn-repos.js', () => ({
  agentTurnsRepo: {
    renewTurnLease: vi.fn(async () => {
      repo.renovacoes += 1;
      return {
        ok: true as const,
        lease_expires_at: repo.proximoVencimento,
        heartbeat_at: new Date(),
      };
    }),
  },
}));
vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('@/runtime/turns/stream-promotion.js', () => ({
  signalStreamPromotion: vi.fn(async () => undefined),
}));

import { TurnLease } from '@/runtime/turns/lease.js';
import type { TurnClaim } from '@/runtime/turns/claim.js';

const TTL_MS = 60_000;
const HEARTBEAT_MS = 15_000;

function claim(lease_expires_at: Date): TurnClaim {
  return {
    turn_id: 'turno-1',
    tenant_id: 'primary',
    agent_id: 'primary',
    attempt: 1,
    claim_token: 'claim-1',
    worker_id: 'worker-1',
    claimed_at: new Date(),
    lease_expires_at,
    status: 'running',
    state_version: 1,
  } as TurnClaim;
}

beforeEach(() => {
  vi.useFakeTimers();
  repo.renovacoes = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('#507 — o `deadline` do contexto acompanha a renovação da lease', () => {
  it('depois de uma renovação real do heartbeat, o prazo do contexto AVANÇA', async () => {
    const inicial = new Date(Date.now() + TTL_MS);
    const lease = new TurnLease(claim(inicial), {
      ttl_ms: TTL_MS,
      heartbeat_ms: HEARTBEAT_MS,
    });
    try {
      // O contexto é criado UMA vez, como em `src/agent/core.ts`.
      const ctx = lease.context();
      expect(ctx.deadline.getTime()).toBe(inicial.getTime());

      // O heartbeat renova e o horizonte anda para frente.
      const renovado = new Date(inicial.getTime() + TTL_MS);
      repo.proximoVencimento = renovado;
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      expect(repo.renovacoes, 'o heartbeat precisa ter batido').toBeGreaterThan(0);

      // O MESMO objeto de contexto, sem ser recriado, já enxerga o prazo novo.
      expect(ctx.deadline.getTime()).toBe(renovado.getTime());
    } finally {
      lease.stop();
    }
  });

  it('um deadline EXPLÍCITO do caller vence a lease e não se move', () => {
    // O orçamento global do turno (outra fatia da #507) entra por aqui. Quando
    // o caller dita o prazo, ele é a autoridade — a lease não pode esticá-lo.
    const inicial = new Date(Date.now() + TTL_MS);
    const lease = new TurnLease(claim(inicial), {
      ttl_ms: TTL_MS,
      heartbeat_ms: HEARTBEAT_MS,
    });
    try {
      const doCaller = new Date(Date.now() + 5_000);
      const ctx = lease.context(doCaller);
      expect(ctx.deadline.getTime()).toBe(doCaller.getTime());
    } finally {
      lease.stop();
    }
  });
});
