/**
 * Review PR #496 (alto 2) — contrato de custom jobId do BullMQ para o replay
 * de inbound não-roteado.
 *
 * BullMQ reserva ':' em custom ids (separador de keys no Redis). A versão
 * instalada (5.x) só deixa passar ids com EXATAMENTE 3 segmentos por uma
 * exceção de compat marcada como deprecada no fonte ("TODO: replace this
 * check in next breaking check with include(':')") — o formato antigo
 * `unrouted:<line>:<wid>` funcionava por acidente e quebraria no próximo
 * major. O id agora é um digest determinístico do par (linha, wid): mesmo
 * par ⇒ mesmo id (idempotência de re-arm), sem caractere reservado.
 */
import { describe, it, expect, vi } from 'vitest';

// Stub BullMQ/ioredis: importar `queue.ts` instancia Queue/IORedis no load.
vi.mock('bullmq', () => {
  class FakeQueue {
    add = vi.fn(async () => undefined);
    close = vi.fn(async () => undefined);
  }
  class FakeWorker {
    on = vi.fn();
    close = vi.fn(async () => undefined);
  }
  return { Queue: FakeQueue, Worker: FakeWorker };
});
vi.mock('ioredis', () => {
  class FakeRedis {
    on() {
      return this;
    }
    quit = vi.fn(async () => undefined);
  }
  return { default: FakeRedis };
});
vi.mock('@/config/env.js', () => ({ config: { REDIS_URL: 'redis://localhost:6379' } }));
vi.mock('@/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/db/repositories.js', () => ({ dlqRepo: { add: vi.fn() } }));
vi.mock('@/governance/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/alerts.js', () => ({ sendAlert: vi.fn(async () => undefined) }));

import { unroutedReplayJobId, enqueueUnroutedReplay, unroutedQueue } from '@/gateway/queue.js';

describe('unroutedReplayJobId', () => {
  it('é estável, determinístico e NUNCA contém ":" (reservado pelo BullMQ)', () => {
    const a = unroutedReplayJobId('+5511900001111', 'WID-1');
    const b = unroutedReplayJobId('+5511900001111', 'WID-1');
    expect(a).toBe(b); // idempotência do re-arm depende da estabilidade
    expect(a).not.toContain(':');
    expect(a).toMatch(/^unrouted-[0-9a-f]{40}$/);
    // Pares distintos ⇒ ids distintos (linha OU wid diferente).
    expect(unroutedReplayJobId('+5511900002222', 'WID-1')).not.toBe(a);
    expect(unroutedReplayJobId('+5511900001111', 'WID-2')).not.toBe(a);
  });

  it('enqueueUnroutedReplay arma o job com o digest como jobId', async () => {
    await enqueueUnroutedReplay({
      unrouted_id: 'u-1',
      line_external_id: '+5511900001111',
      whatsapp_message_id: 'WID-1',
    });
    const add = (unroutedQueue as unknown as { add: ReturnType<typeof vi.fn> }).add;
    const [, data, opts] = add.mock.calls[0]!;
    expect(data).toEqual({ unrouted_id: 'u-1' });
    expect((opts as { jobId: string }).jobId).toBe(
      unroutedReplayJobId('+5511900001111', 'WID-1'),
    );
    expect((opts as { jobId: string }).jobId).not.toContain(':');
  });
});
