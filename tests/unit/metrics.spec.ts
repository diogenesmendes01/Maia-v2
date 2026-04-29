import { describe, it, expect, beforeEach } from 'vitest';

describe('metrics — Prometheus exposition', () => {
  beforeEach(() => {
    // Each spec re-imports a fresh module to reset in-memory state.
    delete (globalThis as Record<string, unknown>).__metricsModule;
  });

  it('counters render with labels sorted', async () => {
    const { incCounter, renderPrometheus } = await freshImport();
    incCounter('maia_llm_calls_total', { model: 'sonnet', provider: 'anthropic', status: 'ok' });
    incCounter('maia_llm_calls_total', { model: 'sonnet', provider: 'anthropic', status: 'ok' });
    incCounter('maia_llm_calls_total', { model: 'haiku', provider: 'anthropic', status: 'ok' });
    const out = await renderPrometheus();
    expect(out).toContain('maia_llm_calls_total{model="sonnet",provider="anthropic",status="ok"} 2');
    expect(out).toContain('maia_llm_calls_total{model="haiku",provider="anthropic",status="ok"} 1');
  });

  it('gauges read from provider on each scrape', async () => {
    const { setGaugeProvider, renderPrometheus } = await freshImport();
    let value = 0;
    setGaugeProvider('maia_redis_connected', () => value);
    expect(await renderPrometheus()).toContain('maia_redis_connected 0');
    value = 1;
    expect(await renderPrometheus()).toContain('maia_redis_connected 1');
  });

  it('histograms accumulate sum and count', async () => {
    const { observeHistogram, renderPrometheus } = await freshImport();
    observeHistogram('maia_llm_latency_ms', 30, { provider: 'a' });
    observeHistogram('maia_llm_latency_ms', 200, { provider: 'a' });
    const out = await renderPrometheus();
    expect(out).toContain('maia_llm_latency_ms_sum');
    expect(out).toMatch(/maia_llm_latency_ms_count[^\n]* 2/);
  });
});

async function freshImport(): Promise<typeof import('../../src/lib/metrics.js')> {
  // Vitest caches module instances; force a re-import by appending a query.
  return (await import(`../../src/lib/metrics.js?_=${Math.random()}`)) as typeof import(
    '../../src/lib/metrics.js'
  );
}
