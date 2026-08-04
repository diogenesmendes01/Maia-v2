import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Issue #535 §2 — the three scrape-time families (pg pool, WhatsApp session,
 * scheduler lag).
 *
 * The property under test in almost every case is the SAME one, because it is
 * the one that keeps costing incidents: **an unreadable source renders NaN,
 * never 0**. A dashboard showing a healthy zero for a dead collector is worse
 * than one showing a gap, and #514 wrote an alert (`MaiaQueueMetricsAbsent`)
 * specifically so the gap is actionable.
 */
import {
  registerDbPoolGauges,
  registerSchedulerLagGauges,
  registerWhatsAppSessionGauges,
  _resetSchedulerLagForTests,
  _SCHEDULER_QUEUES,
  type PoolStats,
  type SchedulerLagEntry,
} from '../../../src/observability/runtime-collectors.js';
import { _resetForTests, renderPrometheus } from '../../../src/lib/metrics.js';
import { _resetLabelGuardForTests } from '../../../src/observability/labels.js';

beforeEach(() => {
  _resetForTests();
  _resetLabelGuardForTests();
  _resetSchedulerLagForTests();
});

/** Read one gauge series out of the exposition text. */
async function series(name: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const line of (await renderPrometheus()).split('\n')) {
    if (!line.startsWith(name)) continue;
    const i = line.lastIndexOf(' ');
    out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

describe('issue #535 — pg pool gauges', () => {
  it('exposes the four states of one pool under one metric name', async () => {
    const pool: PoolStats = {
      totalCount: 8,
      idleCount: 2,
      waitingCount: 3,
      options: { max: 10 },
    };
    registerDbPoolGauges(pool);
    const s = await series('maia_db_pool');
    expect(s['maia_db_pool{state="total"}']).toBe('8');
    expect(s['maia_db_pool{state="idle"}']).toBe('2');
    expect(s['maia_db_pool{state="waiting"}']).toBe('3');
    // `max` is exported so an alert can express saturation as a RATIO without
    // the alert author having to know the deployment's configured ceiling.
    expect(s['maia_db_pool{state="max"}']).toBe('10');
  });

  it('reports NaN — not 0 — when the pool cannot report a value', async () => {
    registerDbPoolGauges({
      totalCount: Number.NaN,
      idleCount: 1,
      waitingCount: 0,
      options: {},
    });
    const s = await series('maia_db_pool');
    expect(s['maia_db_pool{state="total"}']).toBe('NaN');
    expect(s['maia_db_pool{state="max"}']).toBe('NaN');
  });

  it('carries no tenant label — one pool serves every tenant', async () => {
    registerDbPoolGauges({ totalCount: 1, idleCount: 1, waitingCount: 0, options: { max: 2 } });
    const s = await series('maia_db_pool');
    for (const key of Object.keys(s)) expect(key).not.toContain('tenant_id');
  });
});

describe('issue #535 — WhatsApp session gauges', () => {
  it('exposes presence as a PAIR so "down" and "blind" are distinguishable', async () => {
    // With a single 0/1 gauge, "0" and "the scrape failed" render identically.
    registerWhatsAppSessionGauges({ connected: () => true, lastDisconnectAt: () => null });
    const s = await series('maia_whatsapp_sessions');
    expect(s['maia_whatsapp_sessions{state="connected"}']).toBe('1');
    expect(s['maia_whatsapp_sessions{state="disconnected"}']).toBe('0');
  });

  it('inverts the pair when the socket is down', async () => {
    registerWhatsAppSessionGauges({ connected: () => false, lastDisconnectAt: () => null });
    const s = await series('maia_whatsapp_sessions');
    expect(s['maia_whatsapp_sessions{state="connected"}']).toBe('0');
    expect(s['maia_whatsapp_sessions{state="disconnected"}']).toBe('1');
  });

  it('ages from the last disconnect — the flapping signal', async () => {
    const at = new Date(Date.now() - 90_000);
    registerWhatsAppSessionGauges({ connected: () => true, lastDisconnectAt: () => at });
    const s = await series('maia_whatsapp_session_age_seconds');
    expect(Number(s['maia_whatsapp_session_age_seconds'])).toBeGreaterThanOrEqual(89);
  });

  it('reports NaN before the first disconnect, not a misleading 0', async () => {
    // 0 would read as "just dropped" on a socket that has never dropped.
    registerWhatsAppSessionGauges({ connected: () => true, lastDisconnectAt: () => null });
    const s = await series('maia_whatsapp_session_age_seconds');
    expect(s['maia_whatsapp_session_age_seconds']).toBe('NaN');
  });
});

describe('issue #535 — scheduler lag gauges', () => {
  const snapshot = (rows: SchedulerLagEntry[]) => vi.fn(async () => rows);

  it('exposes lag and backlog per queue', async () => {
    registerSchedulerLagGauges(
      snapshot([
        { queue: 'occurrences', backlog: 4, lag_ms: 12_000 },
        { queue: 'outbox', backlog: 0, lag_ms: 0 },
      ]),
    );
    const lag = await series('maia_scheduler_lag_ms');
    const backlog = await series('maia_scheduler_backlog');
    expect(lag['maia_scheduler_lag_ms{queue="occurrences"}']).toBe('12000');
    expect(backlog['maia_scheduler_backlog{queue="occurrences"}']).toBe('4');
    expect(lag['maia_scheduler_lag_ms{queue="outbox"}']).toBe('0');
  });

  it('registers a FIXED queue set so the label can never grow', () => {
    expect([..._SCHEDULER_QUEUES]).toEqual(['occurrences', 'outbox']);
  });

  it('shares one query across the providers of a single scrape', async () => {
    // Four providers × one query each would be four queries per scrape, at
    // whatever rate Prometheus is configured for.
    const source = snapshot([{ queue: 'occurrences', backlog: 1, lag_ms: 1 }]);
    registerSchedulerLagGauges(source);
    await renderPrometheus();
    expect(source).toHaveBeenCalledTimes(1);
  });

  it('reports NaN when the refresh fails — stale lag is worse than no lag', async () => {
    // Deliberately different from turn-state-collector.ts, which keeps serving
    // its last snapshot: a stale LAG says "the backlog is fine" using numbers
    // from before the incident. A stale turn COUNT is merely old.
    registerSchedulerLagGauges(async () => {
      throw new Error('pg down');
    });
    const lag = await series('maia_scheduler_lag_ms');
    expect(lag['maia_scheduler_lag_ms{queue="occurrences"}']).toBe('NaN');
  });

  it('a queue absent from the snapshot is a genuine zero, not NaN', async () => {
    // "No due rows" is expressed by the query returning no row for that queue.
    registerSchedulerLagGauges(snapshot([{ queue: 'occurrences', backlog: 2, lag_ms: 5 }]));
    const lag = await series('maia_scheduler_lag_ms');
    expect(lag['maia_scheduler_lag_ms{queue="outbox"}']).toBe('0');
  });

  it('carries no tenant label — the scope lives in the aggregate query', async () => {
    registerSchedulerLagGauges(snapshot([{ queue: 'outbox', backlog: 1, lag_ms: 1 }]));
    const lag = await series('maia_scheduler_lag_ms');
    for (const key of Object.keys(lag)) expect(key).not.toContain('tenant_id');
  });
});
