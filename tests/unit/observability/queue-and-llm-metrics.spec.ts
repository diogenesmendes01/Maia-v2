/**
 * Issue #514 §5 — queue depth/age gauges and the missing LLM error counter.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Queue } from 'bullmq';
import { registerQueueGauges, _TRACKED_STATES } from '../../../src/observability/queue-metrics.js';
import {
  classifyLlmError,
  recordLlmFailure,
  recordLlmRetry,
  recordLlmFallback,
} from '../../../src/observability/llm-metrics.js';
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

describe('issue #514 §5 — LLM failure counters', () => {
  beforeEach(() => {
    _resetForTests();
    _resetLabelGuardForTests();
  });

  describe('classification uses structure, never the message text', () => {
    it.each([
      [{ status: 429 }, 'rate_limit'],
      [{ status: 401 }, 'auth'],
      [{ status: 403 }, 'auth'],
      [{ status: 408 }, 'timeout'],
      [{ status: 504 }, 'timeout'],
      [{ status: 529 }, 'overloaded'],
      [{ status: 503 }, 'overloaded'],
      [{ status: 400 }, 'bad_request'],
      [{ status: 500 }, 'provider_error'],
      [{ name: 'AbortError' }, 'aborted'],
      [{ code: 'ABORT_ERR' }, 'aborted'],
      [{ code: 'ETIMEDOUT' }, 'timeout'],
      [{}, 'transport'],
    ])('%o ⇒ %s', (err, expected) => {
      expect(classifyLlmError(err)).toBe(expected);
    });

    it('ignores a message that would otherwise match a keyword', () => {
      // If classification read the text, this would be mis-binned as
      // rate_limit — and worse, the text could carry user content.
      expect(classifyLlmError({ message: 'rate limit exceeded', status: 500 })).toBe(
        'provider_error',
      );
    });

    it('handles null/undefined without throwing', () => {
      expect(classifyLlmError(null)).toBe('transport');
      expect(classifyLlmError(undefined)).toBe('transport');
    });
  });

  it('emits the maia_llm_calls_total{status="error"} series the runbook references', async () => {
    recordLlmFailure({ provider: 'anthropic', model: 'sonnet', tier: 'main' }, { status: 429 });
    const out = await renderPrometheus();
    expect(out).toContain('status="error"');
    expect(out).toContain('reason="rate_limit"');
    expect(out).toContain('model="sonnet"');
    expect(out).toContain('provider="anthropic"');
    expect(out).toContain('tier="main"');
  });

  it('separates retry from error from fallback', async () => {
    recordLlmFailure({ provider: 'anthropic', model: 'sonnet' }, { status: 500 });
    recordLlmRetry({ provider: 'anthropic', model: 'sonnet' }, 'provider_error');
    recordLlmFallback({ provider: 'anthropic', model: 'haiku' });
    const out = await renderPrometheus();
    expect(out).toContain('status="error"');
    expect(out).toContain('status="retry"');
    expect(out).toContain('status="fallback"');
  });

  it('never puts the raw provider message in a label', async () => {
    recordLlmFailure(
      { provider: 'anthropic', model: 'sonnet' },
      { status: 400, message: 'invalid request: "meu telefone é +55 11 99999-9999"' },
    );
    const out = await renderPrometheus();
    expect(out).not.toContain('99999');
    expect(out).not.toContain('telefone');
  });

  it('returns the classified reason so the caller can reuse it', () => {
    expect(recordLlmFailure({ provider: 'p', model: 'm' }, { status: 429 })).toBe('rate_limit');
  });
});
