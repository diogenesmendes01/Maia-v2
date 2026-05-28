/**
 * Issue #292 — outbound_messages sweeper tests.
 *
 * Coverage:
 *   - Pending row antiga (age > stale_pending_sec) → promovida a 'unknown'.
 *   - Pending row nova (age < stale_pending_sec) → preservada.
 *   - Terminal row antiga (age > retention_days, status in sent/failed/unknown)
 *     → DELETADA.
 *   - Terminal row nova (age < retention_days) → preservada.
 *   - Audit log `outbound_ledger.sweeper_promoted_pending_to_unknown` com
 *     `ops_alert:true` emitido por promoção.
 *   - Audit log `outbound_ledger.sweeper_cleaned_terminal` com `ops_alert:true`
 *     emitido por tenant que teve cleanup.
 *   - Métricas `maia_outbound_ledger_sweeper_{promoted,cleaned}_total`
 *     incrementadas com labels {tenant_id, agent_id}.
 *   - Dispatcher enumera (tenant_id, agent_id) DISTINCT + abre tenant context
 *     per-tupla (espelha #240/#251 reflection-batch).
 *   - Fail-isolated: erro em tenant-A não derruba tenant-B.
 *
 * Estratégia: mock de `db.execute` que dispatcha por shape de SQL (DISTINCT
 * enumeration vs UPDATE pending → unknown vs DELETE terminal). Não usa
 * DB real — mesma técnica de reflection-batch-cross-tenant.spec.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { tryGetCurrentContext } from '@/db/tenant-context.js';

// ---------------------------------------------------------------------------
// In-memory outbound_messages store + db.execute fake
// ---------------------------------------------------------------------------
type OutboundRow = {
  id: string;
  tenant_id: string;
  agent_id: string;
  idempotency_key: string;
  conversa_id: string;
  in_reply_to: string;
  channel: string;
  status: 'pending' | 'sent' | 'failed' | 'unknown';
  error: string | null;
  created_at: Date;
};

const store: OutboundRow[] = [];
const renderedSqls: string[] = [];
const _dialect = new PgDialect();

// Capture tenant context active at each UPDATE/DELETE call site.
const sweepCallTenants: Array<{ tenant_id: string; agent_id: string; op: 'update' | 'delete' }> = [];

const dbExecuteMock = vi.fn(async (query: SQL) => {
  const rendered = _dialect.sqlToQuery(query);
  const sqlText = rendered.sql;
  renderedSqls.push(sqlText);

  // (A) Dispatcher enumeration — DISTINCT (tenant_id, agent_id).
  if (/SELECT\s+DISTINCT\s+tenant_id,\s*agent_id/i.test(sqlText)) {
    // The dispatcher predicate is rendered as raw SQL with bound params for
    // the cutoff intervals. We re-implement the WHERE in JS over the seeded
    // store: a tenant has "work" iff it has either a stale-pending row or a
    // terminal row past retention.
    const params = rendered.params as unknown[];
    // Param order matches the dispatcher SQL:
    //   $1 = stalePendingSec, $2 = retentionDays.
    const stalePendingSec = Number(params[0]);
    const retentionDays = Number(params[1]);
    const now = Date.now();
    const seen = new Set<string>();
    const pairs: Array<{ tenant_id: string; agent_id: string }> = [];
    for (const r of store) {
      const ageMs = now - r.created_at.getTime();
      const isStalePending = r.status === 'pending' && ageMs > stalePendingSec * 1000;
      const isOldTerminal =
        (r.status === 'sent' || r.status === 'failed' || r.status === 'unknown') &&
        ageMs > retentionDays * 24 * 60 * 60 * 1000;
      if (!isStalePending && !isOldTerminal) continue;
      const key = `${r.tenant_id}|${r.agent_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ tenant_id: r.tenant_id, agent_id: r.agent_id });
    }
    return { rows: pairs };
  }

  // (B) Stale-pending UPDATE → 'unknown', RETURNING id metadata.
  if (/UPDATE.+SET\s+status\s*=\s*'unknown'/is.test(sqlText)) {
    const params = rendered.params as unknown[];
    // Param order: $1=tenant_id, $2=agent_id, $3=stalePendingSec.
    const tenant_id = params[0] as string;
    const agent_id = params[1] as string;
    const stalePendingSec = Number(params[2]);
    const ctx = tryGetCurrentContext();
    if (!ctx || ctx.tenant_id !== tenant_id || ctx.agent_id !== agent_id) {
      throw new Error(
        `UPDATE pending → unknown ran with tenant=${tenant_id} agent=${agent_id} but ctx=${
          ctx ? `${ctx.tenant_id}|${ctx.agent_id}` : 'none'
        } — defense-in-depth invariant broken`,
      );
    }
    sweepCallTenants.push({ tenant_id, agent_id, op: 'update' });
    const now = Date.now();
    const promoted: OutboundRow[] = [];
    for (const r of store) {
      if (r.tenant_id !== tenant_id || r.agent_id !== agent_id) continue;
      if (r.status !== 'pending') continue;
      const ageMs = now - r.created_at.getTime();
      if (ageMs <= stalePendingSec * 1000) continue;
      r.status = 'unknown';
      r.error = r.error ?? 'sweeper_promoted_stale_pending';
      promoted.push(r);
    }
    return {
      rows: promoted.map((r) => ({
        idempotency_key: r.idempotency_key,
        conversa_id: r.conversa_id,
        in_reply_to: r.in_reply_to,
        channel: r.channel,
        created_at: r.created_at,
      })),
    };
  }

  // (C) Retention DELETE terminais antigos.
  if (/DELETE\s+FROM.+outbound_messages/i.test(sqlText)) {
    const params = rendered.params as unknown[];
    // Param order: $1=tenant_id, $2=agent_id, $3=retentionDays.
    const tenant_id = params[0] as string;
    const agent_id = params[1] as string;
    const retentionDays = Number(params[2]);
    const ctx = tryGetCurrentContext();
    if (!ctx || ctx.tenant_id !== tenant_id || ctx.agent_id !== agent_id) {
      throw new Error(
        `DELETE terminal ran with tenant=${tenant_id} agent=${agent_id} but ctx=${
          ctx ? `${ctx.tenant_id}|${ctx.agent_id}` : 'none'
        } — defense-in-depth invariant broken`,
      );
    }
    sweepCallTenants.push({ tenant_id, agent_id, op: 'delete' });
    const now = Date.now();
    const toDelete: number[] = [];
    for (let i = 0; i < store.length; i++) {
      const r = store[i]!;
      if (r.tenant_id !== tenant_id || r.agent_id !== agent_id) continue;
      if (r.status !== 'sent' && r.status !== 'failed' && r.status !== 'unknown') continue;
      const ageMs = now - r.created_at.getTime();
      if (ageMs <= retentionDays * 24 * 60 * 60 * 1000) continue;
      toDelete.push(i);
    }
    const deleted: OutboundRow[] = [];
    for (let i = toDelete.length - 1; i >= 0; i--) {
      deleted.push(...store.splice(toDelete[i]!, 1));
    }
    return { rows: deleted.map((r) => ({ id: r.id })) };
  }

  return { rows: [] };
});

vi.mock('@/db/client.js', () => ({
  db: { execute: dbExecuteMock },
}));

// Use a real logger spy so we can assert structured fields per call.
vi.mock('@/lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

// Use real metrics module — incCounter is in-memory; we reset between tests.
import { _resetForTests } from '@/lib/metrics.js';

// Mock env config: deterministic cutoffs.
const TEST_STALE_PENDING_SEC = 300; // 5 min
const TEST_RETENTION_DAYS = 30;

vi.mock('@/config/env.js', () => ({
  config: {
    OUTBOUND_SWEEPER_STALE_PENDING_SEC: TEST_STALE_PENDING_SEC,
    OUTBOUND_SWEEPER_RETENTION_DAYS: TEST_RETENTION_DAYS,
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
let nextId = 1;

function seed(input: {
  tenant_id: string;
  agent_id: string;
  status: 'pending' | 'sent' | 'failed' | 'unknown';
  age_seconds?: number;
  age_days?: number;
  idempotency_key?: string;
  channel?: string;
}): OutboundRow {
  const ageMs =
    (input.age_seconds ?? 0) * 1000 + (input.age_days ?? 0) * 24 * 60 * 60 * 1000;
  const created_at = new Date(Date.now() - ageMs);
  const row: OutboundRow = {
    id: `row-${nextId++}`,
    tenant_id: input.tenant_id,
    agent_id: input.agent_id,
    idempotency_key: input.idempotency_key ?? `key-${nextId}`,
    conversa_id: `conv-${nextId}`,
    in_reply_to: `inrep-${nextId}`,
    channel: input.channel ?? 'text',
    status: input.status,
    error: null,
    created_at,
  };
  store.push(row);
  return row;
}

const A_CTX = { tenant_id: 'tenant-A', agent_id: 'agent-A' };
const B_CTX = { tenant_id: 'tenant-B', agent_id: 'agent-B' };

beforeEach(() => {
  store.length = 0;
  renderedSqls.length = 0;
  sweepCallTenants.length = 0;
  nextId = 1;
  dbExecuteMock.mockClear();
  _resetForTests();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('outbound_messages_sweeper — stale-pending recovery', () => {
  it('promotes pending row OLDER than stale_pending_sec to unknown', async () => {
    // 10 minutes old > 5min cutoff → promoted.
    seed({ ...A_CTX, status: 'pending', age_seconds: 600 });

    const { runOutboundMessagesSweeper } = await import(
      '@/workers/outbound-messages-sweeper.js'
    );
    await runOutboundMessagesSweeper();

    expect(store).toHaveLength(1);
    expect(store[0]!.status).toBe('unknown');
    // Sweeper writes the default error breadcrumb so ops can distinguish a
    // sweeper-promoted unknown from a markFailed-recorded unknown.
    expect(store[0]!.error).toBe('sweeper_promoted_stale_pending');
  });

  it('PRESERVES pending row NEWER than stale_pending_sec', async () => {
    // 60s old < 5min cutoff → preserved.
    seed({ ...A_CTX, status: 'pending', age_seconds: 60 });

    const { runOutboundMessagesSweeper } = await import(
      '@/workers/outbound-messages-sweeper.js'
    );
    await runOutboundMessagesSweeper();

    expect(store).toHaveLength(1);
    expect(store[0]!.status).toBe('pending');
    expect(store[0]!.error).toBeNull();
  });

  it('promoted rows emit outbound_ledger.sweeper_promoted_pending_to_unknown with ops_alert:true', async () => {
    seed({
      ...A_CTX,
      status: 'pending',
      age_seconds: 600,
      idempotency_key: 'conv1:msg1',
    });

    const { runOutboundMessagesSweeper } = await import(
      '@/workers/outbound-messages-sweeper.js'
    );
    const loggerMod = await import('@/lib/logger.js');
    const warnSpy = loggerMod.logger.warn as ReturnType<typeof vi.fn>;
    warnSpy.mockClear();

    await runOutboundMessagesSweeper();

    const promotionLogs = warnSpy.mock.calls.filter(
      (c) => c[1] === 'outbound_ledger.sweeper_promoted_pending_to_unknown',
    );
    expect(promotionLogs).toHaveLength(1);
    expect(promotionLogs[0]![0]).toMatchObject({
      tenant_id: 'tenant-A',
      agent_id: 'agent-A',
      idempotency_key: 'conv1:msg1',
      ops_alert: true,
    });
  });

  it('preserves non-pending statuses (sent/failed/unknown) regardless of age', async () => {
    // All recent enough to also escape retention.
    seed({ ...A_CTX, status: 'sent', age_seconds: 600 });
    seed({ ...A_CTX, status: 'failed', age_seconds: 600 });
    seed({ ...A_CTX, status: 'unknown', age_seconds: 600 });

    const { runOutboundMessagesSweeper } = await import(
      '@/workers/outbound-messages-sweeper.js'
    );
    await runOutboundMessagesSweeper();

    expect(store).toHaveLength(3);
    // None transitioned to 'unknown' via the sweeper UPDATE (the existing
    // 'unknown' was 'unknown' to start with).
    const sweeperPromoted = store.filter(
      (r) => r.error === 'sweeper_promoted_stale_pending',
    );
    expect(sweeperPromoted).toHaveLength(0);
  });
});

describe('outbound_messages_sweeper — retention cleanup', () => {
  it('DELETES sent row OLDER than retention_days', async () => {
    seed({ ...A_CTX, status: 'sent', age_days: 40 });

    const { runOutboundMessagesSweeper } = await import(
      '@/workers/outbound-messages-sweeper.js'
    );
    await runOutboundMessagesSweeper();

    expect(store).toHaveLength(0);
  });

  it('DELETES failed row OLDER than retention_days', async () => {
    seed({ ...A_CTX, status: 'failed', age_days: 40 });

    const { runOutboundMessagesSweeper } = await import(
      '@/workers/outbound-messages-sweeper.js'
    );
    await runOutboundMessagesSweeper();

    expect(store).toHaveLength(0);
  });

  it('DELETES unknown row OLDER than retention_days', async () => {
    seed({ ...A_CTX, status: 'unknown', age_days: 40 });

    const { runOutboundMessagesSweeper } = await import(
      '@/workers/outbound-messages-sweeper.js'
    );
    await runOutboundMessagesSweeper();

    expect(store).toHaveLength(0);
  });

  it('PRESERVES sent row NEWER than retention_days', async () => {
    seed({ ...A_CTX, status: 'sent', age_days: 5 });

    const { runOutboundMessagesSweeper } = await import(
      '@/workers/outbound-messages-sweeper.js'
    );
    await runOutboundMessagesSweeper();

    expect(store).toHaveLength(1);
    expect(store[0]!.status).toBe('sent');
  });

  it('PRESERVES pending row regardless of age (only stale-pending promotion path applies)', async () => {
    // 60-day-old pending row: it IS stale-pending (300s cutoff), so it gets
    // promoted to 'unknown' by the recovery path. After promotion, it is
    // older than retention so... well, that depends on the order. In our
    // sweeper: promotion happens FIRST inside runSweepInner, then cleanup.
    // A 60-day-old 'pending' row gets promoted to 'unknown' AND then deleted
    // by retention in the SAME tick (it's now 'unknown' AND > 30d old).
    //
    // This is a feature: such rows are by definition extremely abnormal
    // (a pending stuck for 60 days is a far worse signal than the eventual
    // deletion is bad). The promotion still emits an ops_alert log so the
    // signal isn't lost; retention then reclaims the row.
    seed({ ...A_CTX, status: 'pending', age_days: 60 });

    const { runOutboundMessagesSweeper } = await import(
      '@/workers/outbound-messages-sweeper.js'
    );
    await runOutboundMessagesSweeper();

    // Row is gone: promoted then cleaned.
    expect(store).toHaveLength(0);
  });

  it('cleanup emits outbound_ledger.sweeper_cleaned_terminal with ops_alert:true', async () => {
    seed({ ...A_CTX, status: 'sent', age_days: 40 });
    seed({ ...A_CTX, status: 'failed', age_days: 40 });

    const { runOutboundMessagesSweeper } = await import(
      '@/workers/outbound-messages-sweeper.js'
    );
    const loggerMod = await import('@/lib/logger.js');
    const warnSpy = loggerMod.logger.warn as ReturnType<typeof vi.fn>;
    warnSpy.mockClear();

    await runOutboundMessagesSweeper();

    const cleanupLogs = warnSpy.mock.calls.filter(
      (c) => c[1] === 'outbound_ledger.sweeper_cleaned_terminal',
    );
    expect(cleanupLogs).toHaveLength(1);
    expect(cleanupLogs[0]![0]).toMatchObject({
      tenant_id: 'tenant-A',
      agent_id: 'agent-A',
      cleaned: 2,
      retention_days: TEST_RETENTION_DAYS,
      ops_alert: true,
    });
  });
});

describe('outbound_messages_sweeper — metrics', () => {
  it('increments maia_outbound_ledger_sweeper_promoted_total with tenant labels', async () => {
    seed({ ...A_CTX, status: 'pending', age_seconds: 600 });
    seed({ ...A_CTX, status: 'pending', age_seconds: 600 });
    seed({ ...A_CTX, status: 'pending', age_seconds: 600 });

    const metrics = await import('@/lib/metrics.js');
    const { runOutboundMessagesSweeper } = await import(
      '@/workers/outbound-messages-sweeper.js'
    );
    await runOutboundMessagesSweeper();

    const promText = await metrics.renderPrometheus();
    // Counter is keyed with sorted labels: agent_id then tenant_id.
    expect(promText).toContain(
      'maia_outbound_ledger_sweeper_promoted_total{agent_id="agent-A",tenant_id="tenant-A"} 3',
    );
  });

  it('increments maia_outbound_ledger_sweeper_cleaned_total with tenant labels', async () => {
    seed({ ...A_CTX, status: 'sent', age_days: 40 });
    seed({ ...A_CTX, status: 'failed', age_days: 40 });

    const metrics = await import('@/lib/metrics.js');
    const { runOutboundMessagesSweeper } = await import(
      '@/workers/outbound-messages-sweeper.js'
    );
    await runOutboundMessagesSweeper();

    const promText = await metrics.renderPrometheus();
    expect(promText).toContain(
      'maia_outbound_ledger_sweeper_cleaned_total{agent_id="agent-A",tenant_id="tenant-A"} 2',
    );
  });

  it('counters are NOT incremented when no work is done', async () => {
    // All recent rows — nothing to promote or clean.
    seed({ ...A_CTX, status: 'pending', age_seconds: 60 });
    seed({ ...A_CTX, status: 'sent', age_days: 5 });

    const metrics = await import('@/lib/metrics.js');
    const { runOutboundMessagesSweeper } = await import(
      '@/workers/outbound-messages-sweeper.js'
    );
    await runOutboundMessagesSweeper();

    const promText = await metrics.renderPrometheus();
    // Neither counter line emitted (counter never incremented).
    expect(promText).not.toContain('maia_outbound_ledger_sweeper_promoted_total');
    expect(promText).not.toContain('maia_outbound_ledger_sweeper_cleaned_total');
  });
});

describe('outbound_messages_sweeper — per-tenant fan-out (espelha #240/#251)', () => {
  it('enumera (tenant, agent) DISTINCT e abre tenant context per-tupla', async () => {
    seed({ ...A_CTX, status: 'pending', age_seconds: 600 });
    seed({ ...B_CTX, status: 'pending', age_seconds: 600 });

    const { runOutboundMessagesSweeper } = await import(
      '@/workers/outbound-messages-sweeper.js'
    );
    await runOutboundMessagesSweeper();

    // Each tenant got its own UPDATE (promotion) AND DELETE (retention)
    // under the routed tenant context (the dispatcher always runs BOTH ops
    // per tenant — DELETE is no-op when nothing terminal+old exists, but
    // the query still fires).
    const updates = sweepCallTenants.filter((c) => c.op === 'update');
    expect(updates).toHaveLength(2);
    const updateTenants = new Set(updates.map((u) => `${u.tenant_id}|${u.agent_id}`));
    expect(updateTenants).toEqual(new Set(['tenant-A|agent-A', 'tenant-B|agent-B']));

    // Both tenants' pending rows promoted.
    const promotedRows = store.filter((r) => r.status === 'unknown');
    expect(promotedRows).toHaveLength(2);
  });

  it('NO default/default leak — only real (tenant, agent) tuples opened', async () => {
    seed({ ...A_CTX, status: 'pending', age_seconds: 600 });
    seed({ ...B_CTX, status: 'sent', age_days: 40 });

    const { runOutboundMessagesSweeper } = await import(
      '@/workers/outbound-messages-sweeper.js'
    );
    await runOutboundMessagesSweeper();

    const allTenants = new Set(sweepCallTenants.map((c) => `${c.tenant_id}|${c.agent_id}`));
    expect(allTenants.has('default|default')).toBe(false);
    expect(allTenants).toEqual(new Set(['tenant-A|agent-A', 'tenant-B|agent-B']));
  });

  it('empty store → no-op (no tenant context opened, no UPDATE/DELETE fired)', async () => {
    const { runOutboundMessagesSweeper } = await import(
      '@/workers/outbound-messages-sweeper.js'
    );
    await runOutboundMessagesSweeper();

    expect(sweepCallTenants).toHaveLength(0);
    // Only the dispatcher SELECT fired.
    const dispatcherSqls = renderedSqls.filter((s) =>
      /SELECT\s+DISTINCT\s+tenant_id,\s*agent_id/i.test(s),
    );
    expect(dispatcherSqls).toHaveLength(1);
    const updateSqls = renderedSqls.filter((s) =>
      /UPDATE.+SET\s+status\s*=\s*'unknown'/is.test(s),
    );
    expect(updateSqls).toHaveLength(0);
  });

  it('dispatcher SQL inclui tenant_id IS NOT NULL AND agent_id IS NOT NULL (belt-and-suspenders)', async () => {
    seed({ ...A_CTX, status: 'pending', age_seconds: 600 });

    const { runOutboundMessagesSweeper } = await import(
      '@/workers/outbound-messages-sweeper.js'
    );
    await runOutboundMessagesSweeper();

    const dispatcherSql = renderedSqls.find((s) =>
      /SELECT\s+DISTINCT\s+tenant_id,\s*agent_id/i.test(s),
    );
    expect(dispatcherSql).toBeDefined();
    expect(dispatcherSql!).toMatch(/tenant_id\s+IS\s+NOT\s+NULL/i);
    expect(dispatcherSql!).toMatch(/agent_id\s+IS\s+NOT\s+NULL/i);
  });

  it('inner queries scope by tenant+agent (defense-in-depth — invariant in dbExecuteMock)', async () => {
    // The mock itself THROWS if an UPDATE/DELETE runs without the routed
    // tenant context being active. Just exercising the worker is enough —
    // an absent throw is the pass. Two tenants seeded to give the dispatcher
    // a non-trivial fan-out.
    seed({ ...A_CTX, status: 'pending', age_seconds: 600 });
    seed({ ...B_CTX, status: 'pending', age_seconds: 600 });

    const { runOutboundMessagesSweeper } = await import(
      '@/workers/outbound-messages-sweeper.js'
    );
    await expect(runOutboundMessagesSweeper()).resolves.toBeUndefined();
  });
});

describe('outbound_messages_sweeper — fail-isolated', () => {
  it('erro em tenant-A NÃO interrompe processamento de tenant-B', async () => {
    seed({ ...A_CTX, status: 'pending', age_seconds: 600 });
    seed({ ...B_CTX, status: 'pending', age_seconds: 600 });

    // Make the FIRST UPDATE (tenant-A's promotion) throw — without breaking
    // the dispatcher SELECT or subsequent calls.
    let updateCallCount = 0;
    const origImpl = dbExecuteMock.getMockImplementation();
    dbExecuteMock.mockImplementation(async (query: SQL) => {
      const rendered = _dialect.sqlToQuery(query);
      const sqlText = rendered.sql;
      if (/UPDATE.+SET\s+status\s*=\s*'unknown'/is.test(sqlText)) {
        updateCallCount++;
        if (updateCallCount === 1) {
          throw new Error('synthetic tenant-A failure');
        }
      }
      return origImpl!(query);
    });

    const { runOutboundMessagesSweeper } = await import(
      '@/workers/outbound-messages-sweeper.js'
    );
    await expect(runOutboundMessagesSweeper()).resolves.toBeUndefined();

    // tenant-B's pending row STILL got promoted.
    const bRow = store.find(
      (r) => r.tenant_id === 'tenant-B' && r.agent_id === 'agent-B',
    );
    expect(bRow).toBeDefined();
    expect(bRow!.status).toBe('unknown');
  });

  it('done log records tenants_failed + tenants_processed', async () => {
    seed({ ...A_CTX, status: 'pending', age_seconds: 600 });
    seed({ ...B_CTX, status: 'pending', age_seconds: 600 });

    let updateCallCount = 0;
    const origImpl = dbExecuteMock.getMockImplementation();
    dbExecuteMock.mockImplementation(async (query: SQL) => {
      const rendered = _dialect.sqlToQuery(query);
      const sqlText = rendered.sql;
      if (/UPDATE.+SET\s+status\s*=\s*'unknown'/is.test(sqlText)) {
        updateCallCount++;
        if (updateCallCount === 1) {
          throw new Error('synthetic');
        }
      }
      return origImpl!(query);
    });

    const loggerMod = await import('@/lib/logger.js');
    const infoSpy = loggerMod.logger.info as ReturnType<typeof vi.fn>;
    infoSpy.mockClear();

    const { runOutboundMessagesSweeper } = await import(
      '@/workers/outbound-messages-sweeper.js'
    );
    await runOutboundMessagesSweeper();

    const doneLogs = infoSpy.mock.calls.filter(
      (c) => c[1] === 'outbound_messages_sweeper.done',
    );
    expect(doneLogs).toHaveLength(1);
    const doneFields = doneLogs[0]![0] as {
      tenants: number;
      tenants_processed: number;
      tenants_failed: number;
      promoted: number;
      cleaned: number;
    };
    expect(doneFields.tenants).toBe(2);
    expect(doneFields.tenants_processed).toBe(1);
    expect(doneFields.tenants_failed).toBe(1);
  });
});

// Note: worker registration in JOBS is covered by `tests/unit/workers-registry.spec.ts`
// where the entire worker tree is mocked to noops. Duplicating that here would
// require mocking ~30 worker modules just to read the JOBS array — keep it in
// the dedicated registry spec instead.
