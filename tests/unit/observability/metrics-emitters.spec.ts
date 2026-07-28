import { describe, it, expect, beforeEach } from 'vitest';
import { counter, histogram, gauge, gaugeName } from '../../../src/observability/metrics.js';
import { _resetLabelGuardForTests } from '../../../src/observability/labels.js';
import { METRIC } from '../../../src/observability/taxonomy.js';
import { renderPrometheus, _resetForTests } from '../../../src/lib/metrics.js';
import { runWithTenantContext } from '../../../src/db/tenant-context.js';

describe('issue #514 — sanitized metric emitters', () => {
  beforeEach(() => {
    _resetForTests();
    _resetLabelGuardForTests();
    delete process.env.MAIA_STRICT_METRIC_LABELS;
  });

  it('auto-attaches tenant_id + agent_id from ALS', async () => {
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'a1' }, async () => {
      counter(METRIC.TURN_STARTED, { origin: 'queue' });
    });
    const out = await renderPrometheus();
    expect(out).toContain(
      'maia_turn_started_total{agent_id="a1",origin="queue",tenant_id="acme"} 1',
    );
  });

  it('falls back to the sanctioned `system` attribution outside ALS', async () => {
    counter(METRIC.WORKER_RUN, { worker: 'trace_body_writer', status: 'ok' });
    const out = await renderPrometheus();
    expect(out).toContain('tenant_id="system"');
    expect(out).toContain('agent_id="system"');
    // Never the rejected 'default' literal (AGENTS.md §4.8).
    expect(out).not.toContain('tenant_id="default"');
  });

  it('lets an explicit tenant label win over ALS (per-tenant workers)', async () => {
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'a1' }, async () => {
      counter(METRIC.TURN_COMPLETED, { tenant_id: 'other', agent_id: 'a2', outcome: 'completed' });
    });
    const out = await renderPrometheus();
    expect(out).toContain('tenant_id="other"');
    expect(out).not.toContain('tenant_id="acme"');
  });

  it('strips PII labels before they reach the registry', async () => {
    counter(METRIC.OUTBOUND_SEND, {
      status: 'ok',
      // Any of these would be an incident if they landed in Prometheus.
      telefone: '5511999999999',
      remote_jid: '5511999999999@s.whatsapp.net',
      trace_id: '3f1a9d2e-4c5b-4a7e-9f0d-1b2c3d4e5f60',
      conversa_id: 'c-1',
    } as Record<string, string>);
    const out = await renderPrometheus();
    expect(out).toContain('maia_outbound_send_total{');
    expect(out).not.toContain('5511999999999');
    expect(out).not.toContain('s.whatsapp.net');
    expect(out).not.toContain('3f1a9d2e');
    expect(out).not.toContain('conversa_id');
  });

  it('counts each rejected label on the self-health counter', async () => {
    counter(METRIC.TURN_COMPLETED, { telefone: '5511999999999' } as Record<string, string>);
    const out = await renderPrometheus();
    expect(out).toMatch(
      /maia_metric_label_rejected_total\{metric="maia_turn_completed_total",reason="key_forbidden"\} 1/,
    );
  });

  it('records histogram samples with sanitized labels', async () => {
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'a1' }, async () => {
      histogram(METRIC.QUEUE_WAIT_MS, 120, { queue: 'agent' });
      histogram(METRIC.QUEUE_WAIT_MS, 380, { queue: 'agent' });
    });
    const out = await renderPrometheus();
    expect(out).toContain(
      'maia_queue_wait_ms_sum{agent_id="a1",queue="agent",tenant_id="acme"} 500',
    );
    expect(out).toContain(
      'maia_queue_wait_ms_count{agent_id="a1",queue="agent",tenant_id="acme"} 2',
    );
  });

  it('ignores non-finite histogram samples instead of poisoning the sum', async () => {
    histogram(METRIC.TURN_DURATION_MS, Number.NaN);
    histogram(METRIC.TURN_DURATION_MS, Number.POSITIVE_INFINITY);
    const out = await renderPrometheus();
    expect(out).not.toContain('maia_turn_duration_ms_count');
  });

  it('renders gauges with sorted labels baked into the series name', async () => {
    gauge(METRIC.QUEUE_DEPTH, () => 7, { queue: 'agent', state: 'waiting' });
    const out = await renderPrometheus();
    expect(out).toContain('maia_queue_depth{queue="agent",state="waiting"} 7');
  });

  it('a failing gauge provider renders NaN, not a healthy 0', async () => {
    gauge(METRIC.QUEUE_OLDEST_JOB_AGE_MS, () => {
      throw new Error('redis down');
    }, { queue: 'agent' });
    const out = await renderPrometheus();
    expect(out).toContain('maia_queue_oldest_job_age_ms{queue="agent"} NaN');
  });

  it('gaugeName sorts keys deterministically', () => {
    expect(gaugeName('m', { b: '2', a: '1' })).toBe('m{a="1",b="2"}');
    expect(gaugeName('m', {})).toBe('m');
  });

  it('never throws even when the label bag is hostile', () => {
    expect(() =>
      counter(METRIC.TURN_COMPLETED, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        get status(): string {
          throw new Error('boom');
        },
      } as any),
    ).not.toThrow();
  });
});
