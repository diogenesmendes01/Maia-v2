/**
 * Issue #512 review round 1, P1 (`src/index.ts:260`) — the ORDER of the
 * shutdown sequence is itself a contract.
 *
 * Two properties this locks:
 *   1. `stop_accepting_work` is FIRST — nothing that could begin new work
 *      (cron ticks, BullMQ fetches) survives past step one, and it runs before
 *      anything starts closing.
 *   2. `bullmq` drains BEFORE `line_sessions`/`baileys` — an in-flight turn
 *      must still be able to send its reply. The original sequence closed the
 *      sockets first, so an active job could reach an outbound send with the
 *      transport already gone.
 *
 * The sequence is asserted through the same `registerShutdownSequence()` the
 * process uses, with the resource modules stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { calls } = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/gateway/queue.js', () => ({
  pauseQueueWorkers: vi.fn(async () => void calls.push('pause_queue')),
  shutdownQueue: vi.fn(async () => void calls.push('bullmq_close')),
  awaitQueueReady: vi.fn(async () => undefined),
  startAgentWorker: vi.fn(),
  startUnroutedReplayWorker: vi.fn(),
  agentQueue: { getWaitingCount: vi.fn(async () => 0) },
}));
vi.mock('../../../src/workers/index.js', () => ({
  startWorkers: vi.fn(),
  haltWorkerScheduling: vi.fn(async () => void calls.push('halt_cron')),
  drainWorkers: vi.fn(async () => {
    calls.push('drain_cron');
    return { drained: [], pending: [] };
  }),
}));
vi.mock('../../../src/gateway/line-sessions.js', () => ({
  shutdownLineSessions: vi.fn(async () => void calls.push('line_sessions')),
  startAdditionalLineSessions: vi.fn(async () => undefined),
}));
vi.mock('../../../src/gateway/baileys.js', () => ({
  shutdownBaileys: vi.fn(async () => void calls.push('baileys')),
  startBaileys: vi.fn(async () => undefined),
  isBaileysConnected: () => true,
  getLastDisconnectAt: () => null,
}));
vi.mock('../../../src/lib/healthcheck.js', () => ({
  shutdownPools: vi.fn(async () => void calls.push('pools')),
}));
vi.mock('../../../src/agent/turn-context/cache.js', () => ({
  stopTurnContextCacheInvalidationSubscriber: vi.fn(
    async () => void calls.push('turn_context_subscriber'),
  ),
}));
vi.mock('../../../src/lib/llm/cache-invalidation.js', () => ({
  stopLLMSettingsInvalidationSubscriber: vi.fn(
    async () => void calls.push('llm_settings_subscriber'),
  ),
}));
vi.mock('../../../src/governance/audit.js', () => ({
  audit: vi.fn(async () => void calls.push('audit_stop')),
}));
import { lifecycle } from '../../../src/runtime/lifecycle/controller.js';
import { registerShutdownSequence } from '../../../src/runtime/lifecycle/shutdown-sequence.js';

beforeEach(() => {
  calls.length = 0;
  lifecycle._resetForTests();
});

describe('shutdown sequence order', () => {
  it('halts every producer of new work in the FIRST step, before anything closes', async () => {
    registerShutdownSequence();
    await lifecycle.shutdown({ signal: 'SIGTERM' });

    const firstCloseIdx = Math.min(
      calls.indexOf('bullmq_close'),
      calls.indexOf('line_sessions'),
      calls.indexOf('baileys'),
      calls.indexOf('pools'),
    );
    expect(calls.indexOf('halt_cron')).toBeLessThan(firstCloseIdx);
    expect(calls.indexOf('pause_queue')).toBeLessThan(firstCloseIdx);
    // …and before the cron drain even begins waiting.
    expect(calls.indexOf('pause_queue')).toBeLessThan(calls.indexOf('drain_cron'));
  });

  it('drains BullMQ BEFORE closing the WhatsApp transport (an active turn can still reply)', async () => {
    registerShutdownSequence();
    await lifecycle.shutdown({ signal: 'SIGTERM' });

    expect(calls.indexOf('bullmq_close')).toBeLessThan(calls.indexOf('line_sessions'));
    expect(calls.indexOf('bullmq_close')).toBeLessThan(calls.indexOf('baileys'));
  });

  it('closes the pools LAST, after every consumer', async () => {
    registerShutdownSequence();
    await lifecycle.shutdown({ signal: 'SIGTERM' });

    expect(calls.at(-1)).toBe('pools');
    for (const earlier of [
      'bullmq_close',
      'drain_cron',
      'turn_context_subscriber',
      'llm_settings_subscriber',
      'line_sessions',
      'baileys',
      'audit_stop',
    ]) {
      expect(calls.indexOf(earlier)).toBeLessThan(calls.indexOf('pools'));
      expect(calls.indexOf(earlier)).toBeGreaterThanOrEqual(0);
    }
  });

  it('closes the turn-context subscriber AFTER every reader of the cache (#511)', async () => {
    // It owns a SEPARATE ioredis connection, so `pools` does not cover it —
    // leaving it open kept the event loop alive after a clean drain and fired
    // the exit backstop on every deploy. But it must close only once the turns,
    // the crons and the post-turn tasks that READ the cache are done.
    registerShutdownSequence();
    await lifecycle.shutdown({ signal: 'SIGTERM' });

    const subIdx = calls.indexOf('turn_context_subscriber');
    expect(subIdx).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('drain_cron')).toBeLessThan(subIdx);
    expect(calls.indexOf('bullmq_close')).toBeLessThan(subIdx);
    expect(subIdx).toBeLessThan(calls.indexOf('pools'));
  });

  it('closes the LLM settings subscriber AFTER every caller of the gateway (#508)', async () => {
    // Mesma forma e mesma razão do subscriber da #511: ioredis PRÓPRIA, que o
    // `pools` não alcança. Um socket desses deixado aberto mantém o event loop
    // vivo depois de um drain limpo e faz todo deploy reportar shutdown
    // forçado. Fecha só depois que turnos, crons e tarefas de fundo — que são
    // quem chama o LLM — já drenaram.
    registerShutdownSequence();
    await lifecycle.shutdown({ signal: 'SIGTERM' });

    const subIdx = calls.indexOf('llm_settings_subscriber');
    expect(subIdx).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('drain_cron')).toBeLessThan(subIdx);
    expect(calls.indexOf('bullmq_close')).toBeLessThan(subIdx);
    expect(subIdx).toBeLessThan(calls.indexOf('pools'));
  });

  it('produces a clean drain end-to-end', async () => {
    registerShutdownSequence();
    const out = await lifecycle.shutdown({ signal: 'SIGTERM' });
    expect(out.result).toBe('clean');
    expect(out.undrained).toEqual([]);
    expect(out.drained[0]).toBe('stop_accepting_work');
  });
});
