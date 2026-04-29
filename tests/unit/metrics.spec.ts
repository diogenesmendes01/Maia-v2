import { describe, it, expect, beforeEach } from 'vitest';
import {
  incCounter,
  observeHistogram,
  renderPrometheus,
  setGaugeProvider,
  _resetForTests,
} from '../../src/lib/metrics.js';

describe('metrics — Prometheus exposition', () => {
  beforeEach(() => {
    _resetForTests();
  });

  it('counters render with labels sorted', async () => {
    incCounter('maia_llm_calls_total', { model: 'sonnet', provider: 'anthropic', status: 'ok' });
    incCounter('maia_llm_calls_total', { model: 'sonnet', provider: 'anthropic', status: 'ok' });
    incCounter('maia_llm_calls_total', { model: 'haiku', provider: 'anthropic', status: 'ok' });
    const out = await renderPrometheus();
    expect(out).toContain(
      'maia_llm_calls_total{model="sonnet",provider="anthropic",status="ok"} 2',
    );
    expect(out).toContain(
      'maia_llm_calls_total{model="haiku",provider="anthropic",status="ok"} 1',
    );
  });

  it('gauges read from provider on each scrape', async () => {
    let value = 0;
    setGaugeProvider('maia_redis_connected', () => value);
    expect(await renderPrometheus()).toContain('maia_redis_connected 0');
    value = 1;
    expect(await renderPrometheus()).toContain('maia_redis_connected 1');
  });

  it('histograms accumulate sum and count', async () => {
    observeHistogram('maia_llm_latency_ms', 30, { provider: 'a' });
    observeHistogram('maia_llm_latency_ms', 200, { provider: 'a' });
    const out = await renderPrometheus();
    expect(out).toContain('maia_llm_latency_ms_sum{provider="a"} 230');
    expect(out).toContain('maia_llm_latency_ms_count{provider="a"} 2');
  });

  it('histograms render valid Prometheus format with labels', async () => {
    observeHistogram('maia_llm_latency_ms', 30, { model: 'sonnet', provider: 'anthropic' });
    observeHistogram('maia_llm_latency_ms', 200, { model: 'sonnet', provider: 'anthropic' });
    const out = await renderPrometheus();
    // _bucket suffix must be appended to the metric NAME (before `{`), not
    // injected into the label set. Regression guard for the prior bug where
    // the output was `maia_llm_latency_ms{...}_bucket,le="50"} 1`.
    expect(out).toContain(
      'maia_llm_latency_ms_bucket{model="sonnet",provider="anthropic",le="50"} 1',
    );
    expect(out).toContain(
      'maia_llm_latency_ms_bucket{model="sonnet",provider="anthropic",le="250"} 2',
    );
    expect(out).toContain(
      'maia_llm_latency_ms_bucket{model="sonnet",provider="anthropic",le="+Inf"} 2',
    );
    expect(out).toContain('maia_llm_latency_ms_sum{model="sonnet",provider="anthropic"} 230');
    expect(out).toContain('maia_llm_latency_ms_count{model="sonnet",provider="anthropic"} 2');
    expect(out).not.toMatch(/"_bucket/);
    expect(out).not.toMatch(/_bucket,le=/);
  });

  it('histograms without labels render in valid format', async () => {
    observeHistogram('maia_op_ms', 10);
    observeHistogram('maia_op_ms', 75);
    const out = await renderPrometheus();
    expect(out).toContain('maia_op_ms_bucket{le="50"} 1');
    expect(out).toContain('maia_op_ms_bucket{le="100"} 2');
    expect(out).toContain('maia_op_ms_sum 85');
    expect(out).toContain('maia_op_ms_count 2');
  });
});
