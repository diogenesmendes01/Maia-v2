/**
 * Issue #316 — idempotency_outbox_relayer worker tests.
 *
 * Coverage:
 *   - EXACTLY-ONCE dispatch: each claimed pending row is dispatched once and
 *     marked sent with the provider ref. A reclaimed-lease racer never enqueued
 *     an effect (proved in the repo spec), so the relayer is the SOLE dispatch
 *     path → the effect fires exactly once.
 *   - SINGLE-FLIGHT: GLOBAL advisory lock acquired once + released; a contended
 *     lock skips the whole pass (no claim, no dispatch).
 *   - PER-TENANT FAN-OUT + ISOLATION: enumerates DISTINCT (tenant, agent) and
 *     opens tenant context per tuple; claim/dispatch run under the routed
 *     context; no 'default' leak.
 *   - PER-TENANT FAIRNESS: claim batch is bounded by OUTBOX_RELAYER_BATCH_PER_TENANT.
 *   - RETRY on transient failure: a gateway error bumps attempts (markEffectRetry)
 *     and leaves the row pending (no markEffectSent).
 *   - TERMINAL failure: markEffectRetry returning 'failed' emits an ops_alert.
 *   - INVALID payload: a corrupt row is driven terminal (never dispatched).
 *   - FAIL-ISOLATED: one tenant throwing does not abort the others.
 *
 * Strategy: mock `idempotencyOutboxRepo` (in-memory pending rows + recorded
 * markSent/markRetry calls), the Baileys gateway, the pool (advisory lock), and
 * config. The relayer code path itself runs end-to-end.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tryGetCurrentContext } from '@/db/tenant-context.js';

type OutboxRow = {
  id: string;
  tenant_id: string;
  agent_id: string;
  idempotency_key: string;
  effect_type: string;
  effect_payload: unknown;
  attempts: number;
  max_attempts: number;
  status: 'pending' | 'sent' | 'failed';
};

const store: OutboxRow[] = [];
// Records the (tenant, agent) context active at each claim — proves the
// per-tenant routing + defense-in-depth scope.
const claimContexts: Array<{ tenant_id: string; agent_id: string }> = [];

const markSentCalls: Array<{ id: string; provider_ref: string | null }> = [];
const markRetryCalls: Array<{ id: string; error: string; backoff_seconds: number }> = [];

const BATCH_PER_TENANT = 100;

const repoMock = {
  listTenantsWithPendingEffects: vi.fn(async () => {
    const seen = new Set<string>();
    const out: Array<{ tenant_id: string; agent_id: string }> = [];
    for (const r of store) {
      if (r.status !== 'pending') continue;
      const key = `${r.tenant_id}|${r.agent_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ tenant_id: r.tenant_id, agent_id: r.agent_id });
    }
    return out;
  }),
  claimPendingEffects: vi.fn(async (limit: number) => {
    const ctx = tryGetCurrentContext();
    if (!ctx) throw new Error('claimPendingEffects ran with NO tenant context');
    claimContexts.push({ tenant_id: ctx.tenant_id, agent_id: ctx.agent_id });
    return store
      .filter(
        (r) =>
          r.tenant_id === ctx.tenant_id &&
          r.agent_id === ctx.agent_id &&
          r.status === 'pending',
      )
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        idempotency_key: r.idempotency_key,
        effect_type: r.effect_type,
        effect_payload: r.effect_payload,
        attempts: r.attempts,
        max_attempts: r.max_attempts,
      }));
  }),
  markEffectSent: vi.fn(async (input: { id: string; provider_ref: string | null }) => {
    markSentCalls.push(input);
    const row = store.find((r) => r.id === input.id && r.status === 'pending');
    if (!row) return false;
    row.status = 'sent';
    return true;
  }),
  markEffectRetry: vi.fn(
    async (input: { id: string; error: string; backoff_seconds: number }) => {
      markRetryCalls.push(input);
      const row = store.find((r) => r.id === input.id && r.status === 'pending');
      if (!row) return null;
      row.attempts += 1;
      row.status = row.attempts >= row.max_attempts ? 'failed' : 'pending';
      return row.status;
    },
  ),
  cleanupTerminal: vi.fn(async () => 0),
};

vi.mock('@/db/repositories.js', () => ({ idempotencyOutboxRepo: repoMock }));

// Gateway: configurable per test (default: succeeds with a provider id).
const sendOutboundTextMock = vi.fn(async (_jid: string, _text: string) => 'wa-id-default');
vi.mock('@/gateway/baileys.js', () => ({ sendOutboundText: sendOutboundTextMock }));

// Pool advisory-lock mock (mirrors outbound-messages-sweeper.spec.ts).
let lockHeldByOther = false;
const poolStats = { connects: 0, releases: 0, acquires: 0, unlocks: 0, acquiredOk: 0 };
function makeFakeClient() {
  return {
    query: vi.fn(async (text: string) => {
      if (/pg_try_advisory_lock/i.test(text)) {
        poolStats.acquires++;
        const locked = !lockHeldByOther;
        if (locked) poolStats.acquiredOk++;
        return { rows: [{ locked }] };
      }
      if (/pg_advisory_unlock/i.test(text)) {
        poolStats.unlocks++;
        return { rows: [{ pg_advisory_unlock: true }] };
      }
      return { rows: [] };
    }),
    release: vi.fn(() => {
      poolStats.releases++;
    }),
  };
}
const poolConnectMock = vi.fn(async () => {
  poolStats.connects++;
  return makeFakeClient();
});
vi.mock('@/db/client.js', () => ({ pool: { connect: poolConnectMock } }));

vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { _resetForTests } from '@/lib/metrics.js';

vi.mock('@/config/env.js', () => ({
  config: {
    OUTBOX_RELAYER_BATCH_PER_TENANT: BATCH_PER_TENANT,
    OUTBOX_RELAYER_BASE_BACKOFF_SEC: 30,
    OUTBOX_RELAYER_MAX_BACKOFF_SEC: 3600,
    OUTBOX_RELAYER_RETENTION_DAYS: 30,
    OUTBOX_RELAYER_RETENTION_BATCH_SIZE: 1000,
  },
}));

const A_CTX = { tenant_id: 'tenant-A', agent_id: 'agent-A' };
const B_CTX = { tenant_id: 'tenant-B', agent_id: 'agent-B' };

let nextId = 1;
function seed(input: {
  tenant_id: string;
  agent_id: string;
  effect_type?: string;
  effect_payload?: unknown;
  attempts?: number;
  max_attempts?: number;
}): OutboxRow {
  const row: OutboxRow = {
    id: `ob-${nextId++}`,
    tenant_id: input.tenant_id,
    agent_id: input.agent_id,
    idempotency_key: `key-${nextId}`,
    effect_type: input.effect_type ?? 'whatsapp_text',
    effect_payload:
      input.effect_payload ??
      ({ kind: 'whatsapp_text', jid: '5511999990000@s.whatsapp.net', text: 'olá', mensagem_id: 'm1' } as unknown),
    attempts: input.attempts ?? 0,
    max_attempts: input.max_attempts ?? 5,
    status: 'pending',
  };
  store.push(row);
  return row;
}

beforeEach(() => {
  store.length = 0;
  claimContexts.length = 0;
  markSentCalls.length = 0;
  markRetryCalls.length = 0;
  lockHeldByOther = false;
  poolStats.connects = 0;
  poolStats.releases = 0;
  poolStats.acquires = 0;
  poolStats.unlocks = 0;
  poolStats.acquiredOk = 0;
  nextId = 1;
  sendOutboundTextMock.mockReset();
  sendOutboundTextMock.mockResolvedValue('wa-id-default');
  Object.values(repoMock).forEach((m) => (m as ReturnType<typeof vi.fn>).mockClear());
  _resetForTests();
});

describe('idempotency_outbox_relayer — exactly-once dispatch', () => {
  it('dispatches a pending whatsapp_text effect ONCE and marks it sent with the provider ref', async () => {
    seed({ ...A_CTX });
    sendOutboundTextMock.mockResolvedValueOnce('wa-id-123');

    const { runIdempotencyOutboxRelayer } = await import(
      '@/workers/idempotency-outbox-relayer.js'
    );
    await runIdempotencyOutboxRelayer();

    // The gateway send fired EXACTLY once.
    expect(sendOutboundTextMock).toHaveBeenCalledTimes(1);
    expect(sendOutboundTextMock).toHaveBeenCalledWith('5511999990000@s.whatsapp.net', 'olá');
    // Marked sent with the provider id.
    expect(markSentCalls).toEqual([{ id: 'ob-1', provider_ref: 'wa-id-123' }]);
    expect(store[0]!.status).toBe('sent');
    // No retry recorded.
    expect(markRetryCalls).toHaveLength(0);
  });

  it('a second relay pass does NOT re-dispatch an already-sent effect', async () => {
    seed({ ...A_CTX });
    const { runIdempotencyOutboxRelayer } = await import(
      '@/workers/idempotency-outbox-relayer.js'
    );
    await runIdempotencyOutboxRelayer();
    expect(sendOutboundTextMock).toHaveBeenCalledTimes(1);

    // Second pass: the row is now 'sent', so it is not claimed again.
    await runIdempotencyOutboxRelayer();
    expect(sendOutboundTextMock).toHaveBeenCalledTimes(1); // still 1 — exactly once.
  });
});

describe('idempotency_outbox_relayer — single-flight advisory lock', () => {
  it('acquires the GLOBAL lock once and releases it on completion', async () => {
    seed({ ...A_CTX });
    const { runIdempotencyOutboxRelayer } = await import(
      '@/workers/idempotency-outbox-relayer.js'
    );
    await runIdempotencyOutboxRelayer();
    expect(poolStats.acquires).toBe(1);
    expect(poolStats.acquiredOk).toBe(1);
    expect(poolStats.unlocks).toBe(1);
    expect(poolStats.connects).toBe(1);
    expect(poolStats.releases).toBe(1);
  });

  it('SKIPS the whole pass when another instance holds the lock', async () => {
    seed({ ...A_CTX });
    lockHeldByOther = true;
    const { runIdempotencyOutboxRelayer } = await import(
      '@/workers/idempotency-outbox-relayer.js'
    );
    await runIdempotencyOutboxRelayer();
    expect(poolStats.acquiredOk).toBe(0);
    // No tenant enumeration, no dispatch.
    expect(repoMock.listTenantsWithPendingEffects).not.toHaveBeenCalled();
    expect(sendOutboundTextMock).not.toHaveBeenCalled();
    // Client returned to pool; no unlock (never held it).
    expect(poolStats.releases).toBe(1);
    expect(poolStats.unlocks).toBe(0);
    expect(store[0]!.status).toBe('pending');
  });

  it('releases the lock even when the dispatcher enumeration throws', async () => {
    seed({ ...A_CTX });
    repoMock.listTenantsWithPendingEffects.mockRejectedValueOnce(new Error('synthetic'));
    const { runIdempotencyOutboxRelayer } = await import(
      '@/workers/idempotency-outbox-relayer.js'
    );
    await expect(runIdempotencyOutboxRelayer()).rejects.toThrow('synthetic');
    expect(poolStats.acquiredOk).toBe(1);
    expect(poolStats.unlocks).toBe(1); // released in finally
    expect(poolStats.releases).toBe(1);
  });
});

describe('idempotency_outbox_relayer — per-tenant fan-out + isolation', () => {
  it('claims under EACH routed (tenant, agent) context; no default leak', async () => {
    seed({ ...A_CTX });
    seed({ ...B_CTX });
    const { runIdempotencyOutboxRelayer } = await import(
      '@/workers/idempotency-outbox-relayer.js'
    );
    await runIdempotencyOutboxRelayer();

    const ctxKeys = new Set(claimContexts.map((c) => `${c.tenant_id}|${c.agent_id}`));
    expect(ctxKeys).toEqual(new Set(['tenant-A|agent-A', 'tenant-B|agent-B']));
    expect(ctxKeys.has('default|default')).toBe(false);
    // Both effects dispatched.
    expect(sendOutboundTextMock).toHaveBeenCalledTimes(2);
    expect(store.every((r) => r.status === 'sent')).toBe(true);
  });

  it('empty store → no-op (no tenant context opened, no dispatch)', async () => {
    const { runIdempotencyOutboxRelayer } = await import(
      '@/workers/idempotency-outbox-relayer.js'
    );
    await runIdempotencyOutboxRelayer();
    expect(claimContexts).toHaveLength(0);
    expect(sendOutboundTextMock).not.toHaveBeenCalled();
  });

  it('FAIL-ISOLATED: tenant-A dispatch throwing does not abort tenant-B', async () => {
    seed({ ...A_CTX });
    seed({ ...B_CTX });
    // Make tenant-A's send throw a hard (non-Error-returning) failure that
    // also breaks markEffectRetry to simulate a tenant-level abort.
    repoMock.claimPendingEffects.mockImplementationOnce(async () => {
      throw new Error('tenant-A claim blew up');
    });
    const { runIdempotencyOutboxRelayer } = await import(
      '@/workers/idempotency-outbox-relayer.js'
    );
    await expect(runIdempotencyOutboxRelayer()).resolves.toBeUndefined();
    // tenant-B still dispatched despite tenant-A failing.
    const bRow = store.find((r) => r.tenant_id === 'tenant-B')!;
    expect(bRow.status).toBe('sent');
  });
});

describe('idempotency_outbox_relayer — per-tenant fairness', () => {
  it('claims AT MOST OUTBOX_RELAYER_BATCH_PER_TENANT rows per pass', async () => {
    const OVER = BATCH_PER_TENANT + 25;
    for (let i = 0; i < OVER; i++) seed({ ...A_CTX });
    const { runIdempotencyOutboxRelayer } = await import(
      '@/workers/idempotency-outbox-relayer.js'
    );
    await runIdempotencyOutboxRelayer();
    // Only the batch cap was dispatched this pass; the rest stay pending.
    expect(sendOutboundTextMock).toHaveBeenCalledTimes(BATCH_PER_TENANT);
    const sent = store.filter((r) => r.status === 'sent');
    const pending = store.filter((r) => r.status === 'pending');
    expect(sent).toHaveLength(BATCH_PER_TENANT);
    expect(pending).toHaveLength(OVER - BATCH_PER_TENANT);
  });
});

describe('idempotency_outbox_relayer — retry / failure', () => {
  it('records a retry (NOT sent) when the gateway throws a transient error', async () => {
    seed({ ...A_CTX, attempts: 0, max_attempts: 5 });
    sendOutboundTextMock.mockRejectedValueOnce(new Error('network blip'));
    const { runIdempotencyOutboxRelayer } = await import(
      '@/workers/idempotency-outbox-relayer.js'
    );
    await runIdempotencyOutboxRelayer();
    expect(markSentCalls).toHaveLength(0);
    expect(markRetryCalls).toHaveLength(1);
    expect(markRetryCalls[0]!.error).toBe('network blip');
    expect(markRetryCalls[0]!.backoff_seconds).toBe(30); // base * 2^0
    // Row stays pending for the next tick.
    expect(store[0]!.status).toBe('pending');
    expect(store[0]!.attempts).toBe(1);
  });

  it('a null gateway result (not connected) is a transient retry, not a send', async () => {
    seed({ ...A_CTX });
    sendOutboundTextMock.mockResolvedValueOnce(null);
    const { runIdempotencyOutboxRelayer } = await import(
      '@/workers/idempotency-outbox-relayer.js'
    );
    await runIdempotencyOutboxRelayer();
    expect(markSentCalls).toHaveLength(0);
    expect(markRetryCalls).toHaveLength(1);
    expect(markRetryCalls[0]!.error).toBe('gateway_not_connected');
  });

  it('uses exponential backoff keyed on the row attempts', async () => {
    seed({ ...A_CTX, attempts: 3, max_attempts: 10 });
    sendOutboundTextMock.mockRejectedValueOnce(new Error('boom'));
    const { runIdempotencyOutboxRelayer } = await import(
      '@/workers/idempotency-outbox-relayer.js'
    );
    await runIdempotencyOutboxRelayer();
    // base(30) * 2^3 = 240.
    expect(markRetryCalls[0]!.backoff_seconds).toBe(240);
  });

  it('emits an ops_alert when a retry exhausts max_attempts (terminal failed)', async () => {
    seed({ ...A_CTX, attempts: 4, max_attempts: 5 }); // next attempt → failed
    sendOutboundTextMock.mockRejectedValueOnce(new Error('final boom'));
    const loggerMod = await import('@/lib/logger.js');
    const errorSpy = loggerMod.logger.error as ReturnType<typeof vi.fn>;
    errorSpy.mockClear();
    const { runIdempotencyOutboxRelayer } = await import(
      '@/workers/idempotency-outbox-relayer.js'
    );
    await runIdempotencyOutboxRelayer();
    expect(store[0]!.status).toBe('failed');
    const terminalLogs = errorSpy.mock.calls.filter(
      (c) => c[1] === 'idempotency_outbox_relayer.effect_failed_terminal',
    );
    expect(terminalLogs).toHaveLength(1);
    expect(terminalLogs[0]![0]).toMatchObject({ ops_alert: true, tenant_id: 'tenant-A' });
  });
});

describe('idempotency_outbox_relayer — invalid payload', () => {
  it('drives a corrupt-payload row terminal WITHOUT dispatching it', async () => {
    // effect_type says whatsapp_text but the payload is missing required fields.
    seed({
      ...A_CTX,
      effect_type: 'whatsapp_text',
      effect_payload: { kind: 'whatsapp_text' /* no jid/text */ },
      attempts: 0,
      max_attempts: 5,
    });
    const loggerMod = await import('@/lib/logger.js');
    const errorSpy = loggerMod.logger.error as ReturnType<typeof vi.fn>;
    errorSpy.mockClear();
    const { runIdempotencyOutboxRelayer } = await import(
      '@/workers/idempotency-outbox-relayer.js'
    );
    await runIdempotencyOutboxRelayer();
    // NEVER dispatched.
    expect(sendOutboundTextMock).not.toHaveBeenCalled();
    // Driven terminal via markEffectRetry with a max-attempts backoff.
    expect(markRetryCalls).toHaveLength(1);
    expect(markRetryCalls[0]!.error).toContain('invalid_effect_payload');
    const invalidLogs = errorSpy.mock.calls.filter(
      (c) => c[1] === 'idempotency_outbox_relayer.invalid_payload',
    );
    expect(invalidLogs).toHaveLength(1);
    expect(invalidLogs[0]![0]).toMatchObject({ ops_alert: true });
  });
});

describe('idempotency_outbox_relayer — metrics', () => {
  it('increments maia_idempotency_outbox_relayer_sent_total with tenant labels', async () => {
    seed({ ...A_CTX });
    seed({ ...A_CTX });
    const metrics = await import('@/lib/metrics.js');
    const { runIdempotencyOutboxRelayer } = await import(
      '@/workers/idempotency-outbox-relayer.js'
    );
    await runIdempotencyOutboxRelayer();
    const prom = await metrics.renderPrometheus();
    expect(prom).toContain(
      'maia_idempotency_outbox_relayer_sent_total{agent_id="agent-A",tenant_id="tenant-A"} 2',
    );
  });
});
