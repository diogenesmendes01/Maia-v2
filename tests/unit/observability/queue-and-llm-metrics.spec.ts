/**
 * Issue #514 §5 — gauges de profundidade/idade de fila.
 *
 * Os contadores de falha de LLM sairam daqui: o gateway governado da #508
 * (src/lib/llm/telemetry.ts) emite maia_llm_calls_total em TODO desfecho, de um
 * unico ponto. Um segundo emissor dobraria a contagem em cada falha.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Queue } from 'bullmq';
import { registerQueueGauges, _TRACKED_STATES } from '../../../src/observability/queue-metrics.js';
import { _resetLabelGuardForTests } from '../../../src/observability/labels.js';
import { renderPrometheus, _resetForTests } from '../../../src/lib/metrics.js';

function fakeQueue(over: Partial<Record<string, unknown>> = {}): Queue {
  return {
    getJobCounts: vi.fn().mockResolvedValue({
      waiting: 12,
      active: 1,
      delayed: 3,
      failed: 0,
      paused: 0,
    }),
    getJobs: vi.fn().mockResolvedValue([{ timestamp: Date.now() - 4000 }]),
    ...over,
  } as unknown as Queue;
}

describe('issue #514 §5 — queue gauges', () => {
  beforeEach(() => {
    _resetForTests();
    _resetLabelGuardForTests();
  });

  it('exposes depth for every tracked state, labelled by queue', async () => {
    registerQueueGauges(fakeQueue(), 'agent');
    const out = await renderPrometheus();
    expect(out).toContain('maia_queue_depth{queue="agent",state="waiting"} 12');
    expect(out).toContain('maia_queue_depth{queue="agent",state="active"} 1');
    expect(out).toContain('maia_queue_depth{queue="agent",state="delayed"} 3');
    expect(out).toContain('maia_queue_depth{queue="agent",state="failed"} 0');
  });

  it('covers exactly the states the SLO alerts reference', () => {
    expect([..._TRACKED_STATES]).toEqual(['waiting', 'active', 'delayed', 'failed', 'paused']);
  });

  it('exposes the oldest WAITING job age', async () => {
    registerQueueGauges(fakeQueue(), 'agent');
    const out = await renderPrometheus();
    const m = out.match(/maia_queue_oldest_job_age_ms\{queue="agent"\} (\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(4000);
  });

  it('asks Redis for ONE job, not the whole backlog', async () => {
    const q = fakeQueue();
    registerQueueGauges(q, 'agent');
    await renderPrometheus();
    expect(q.getJobs).toHaveBeenCalledWith(['waiting'], 0, 0, true);
  });

  it('reports 0 age for an empty queue', async () => {
    registerQueueGauges(fakeQueue({ getJobs: vi.fn().mockResolvedValue([]) }), 'agent');
    const out = await renderPrometheus();
    expect(out).toContain('maia_queue_oldest_job_age_ms{queue="agent"} 0');
  });

  it('renders NaN — not a healthy 0 — when Redis is unreachable', async () => {
    registerQueueGauges(
      fakeQueue({
        getJobCounts: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        getJobs: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      }),
      'agent',
    );
    const out = await renderPrometheus();
    expect(out).toContain('maia_queue_depth{queue="agent",state="waiting"} NaN');
    expect(out).toContain('maia_queue_oldest_job_age_ms{queue="agent"} NaN');
    expect(out).not.toContain('maia_queue_depth{queue="agent",state="waiting"} 0');
  });

  it('a state Redis omitted is NaN, not 0', async () => {
    registerQueueGauges(fakeQueue({ getJobCounts: vi.fn().mockResolvedValue({ waiting: 5 }) }), 'q');
    const out = await renderPrometheus();
    expect(out).toContain('maia_queue_depth{queue="q",state="waiting"} 5');
    expect(out).toContain('maia_queue_depth{queue="q",state="active"} NaN');
  });

  it('keeps queues separated', async () => {
    registerQueueGauges(fakeQueue(), 'agent');
    registerQueueGauges(fakeQueue({ getJobCounts: vi.fn().mockResolvedValue({ waiting: 99 }) }), 'unrouted-replay');
    const out = await renderPrometheus();
    expect(out).toContain('maia_queue_depth{queue="agent",state="waiting"} 12');
    expect(out).toContain('maia_queue_depth{queue="unrouted-replay",state="waiting"} 99');
  });
});
