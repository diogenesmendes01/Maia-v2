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
  /** Age (days) of a terminal row; used by the retention mocks. 0 = fresh. */
  terminal_age_days?: number;
};

const store: OutboxRow[] = [];
// Records the (tenant, agent) context active at each claim — proves the
// per-tenant routing + defense-in-depth scope.
const claimContexts: Array<{ tenant_id: string; agent_id: string }> = [];

const markSentCalls: Array<{ id: string; provider_ref: string | null }> = [];
const markRetryCalls: Array<{ id: string; error: string; backoff_seconds: number }> = [];
const markFailedCalls: Array<{ id: string; error: string }> = [];

const BATCH_PER_TENANT = 100;

// Terminal rows older than this many days are considered past the retention
// window by the listTenantsWithWork / cleanupTerminal mocks. Rows carry an
// optional `terminal_age_days` (default 0 = fresh) so a test can seed an
// IDLE tenant whose ONLY rows are AGED terminal rows (the #326 blocker proof).
const RETENTION_DAYS = 30;

const repoMock = {
  // Mirrors the real listTenantsWithWork: a tenant is enumerated when it has
  // EITHER a dispatchable pending row OR a terminal row past the retention
  // window. The terminal-row arm is the #326 blocker fix — it makes retention
  // reach an idle tenant that has ONLY aged terminal rows (no pending).
  listTenantsWithWork: vi.fn(async (retentionDays: number) => {
    const seen = new Set<string>();
    const out: Array<{ tenant_id: string; agent_id: string }> = [];
    for (const r of store) {
      const isPending = r.status === 'pending';
      const isAgedTerminal =
        (r.status === 'sent' || r.status === 'failed') &&
        (r.terminal_age_days ?? 0) > retentionDays;
      if (!isPending && !isAgedTerminal) continue;
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
        // #327: the real claim SELECTs tenant_id + agent_id onto the row so the
        // relayer derives the dedup key from PERSISTED row fields (not ALS).
        // The mock mirrors that — tests assert the key is row-derived.
        tenant_id: r.tenant_id,
        agent_id: r.agent_id,
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
  // Force-terminal (#326 note (b)): flip a pending row straight to 'failed'
  // WITHOUT touching the retry budget. CAS on status='pending'.
  markEffectFailed: vi.fn(async (input: { id: string; error: string }) => {
    markFailedCalls.push(input);
    const row = store.find((r) => r.id === input.id && r.status === 'pending');
    if (!row) return false;
    row.status = 'failed';
    return true;
  }),
  // Bounded retention DELETE for the CURRENT (tenant, agent): removes aged
  // terminal rows in batches. Returns the count deleted this call so the
  // relayer's batch loop terminates when a short batch drains the backlog.
  cleanupTerminal: vi.fn(async (input: { olderThanDays: number; batchSize: number }) => {
    const ctx = tryGetCurrentContext();
    if (!ctx) throw new Error('cleanupTerminal ran with NO tenant context');
    const victims = store
      .filter(
        (r) =>
          r.tenant_id === ctx.tenant_id &&
          r.agent_id === ctx.agent_id &&
          (r.status === 'sent' || r.status === 'failed') &&
          (r.terminal_age_days ?? 0) > input.olderThanDays,
      )
      .slice(0, input.batchSize);
    for (const v of victims) {
      const idx = store.indexOf(v);
      if (idx >= 0) store.splice(idx, 1);
    }
    return victims.length;
  }),
};

vi.mock('@/db/repositories.js', () => ({ idempotencyOutboxRepo: repoMock }));

// Gateway: configurable per test (default: succeeds with a provider id). The
// third arg (`opts`) carries the #327 provider-side dedup key (`messageId`).
// Fase 0 (spec roteamento §1.6): o relayer envia pela fronteira LineOutput —
// o mock cobre `forCurrentAgentChannel(null)` devolvendo uma line cujo
// sendText é o spy (mesmas asserções de antes, agora na fronteira).
const sendOutboundTextMock = vi.fn(
  async (
    _jid: string,
    _text: string,
    _opts?: { quoted?: unknown; view_once?: boolean; messageId?: string },
  ) => 'wa-id-default',
);
vi.mock('@/gateway/line-output.js', () => ({
  forCurrentAgentChannel: vi.fn(async () => ({
    scope: { tenant_id: 't', agent_id: 'a', channel_id: 'ch-1' },
    sendText: sendOutboundTextMock,
    isConnected: () => true,
  })),
}));

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
  status?: 'pending' | 'sent' | 'failed';
  terminal_age_days?: number;
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
    status: input.status ?? 'pending',
    terminal_age_days: input.terminal_age_days,
  };
  store.push(row);
  return row;
}

beforeEach(() => {
  store.length = 0;
  claimContexts.length = 0;
  markSentCalls.length = 0;
  markRetryCalls.length = 0;
  markFailedCalls.length = 0;
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

    // The gateway send fired EXACTLY once, with the jid + text and a #327
    // provider-side dedup key (`messageId`) derived from the row identity.
    expect(sendOutboundTextMock).toHaveBeenCalledTimes(1);
    expect(sendOutboundTextMock).toHaveBeenCalledWith(
      '5511999990000@s.whatsapp.net',
      'olá',
      expect.objectContaining({ messageId: expect.stringMatching(/^3EB0[0-9A-F]{18}$/) }),
    );
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

describe('idempotency_outbox_relayer — #327 provider-side dedup key', () => {
  it('passes the deterministic dedup key derived from the row identity on the send', async () => {
    const row = seed({ ...A_CTX });
    const { deriveProviderDedupKey } = await import(
      '@/governance/idempotency-effects.js'
    );
    const expectedKey = deriveProviderDedupKey(
      { kind: 'whatsapp_text', jid: '5511999990000@s.whatsapp.net', text: 'olá', mensagem_id: 'm1' },
      { tenant_id: row.tenant_id, agent_id: row.agent_id, idempotency_key: row.idempotency_key },
    );
    const { runIdempotencyOutboxRelayer } = await import(
      '@/workers/idempotency-outbox-relayer.js'
    );
    await runIdempotencyOutboxRelayer();

    expect(sendOutboundTextMock).toHaveBeenCalledTimes(1);
    const [, , opts] = sendOutboundTextMock.mock.calls[0]!;
    // The relayer passed EXACTLY the key the derivation produces for this
    // row's identity — proving the wiring (identity → key → send) is correct.
    expect(opts?.messageId).toBe(expectedKey);
    // …and it is a valid WhatsApp message-id shape (3EB0 + 18 uppercase hex).
    expect(opts?.messageId).toMatch(/^3EB0[0-9A-F]{18}$/);
  });

  it('derives the key from the ROW identity, NOT the ambient ALS context (key is ALS-independent)', async () => {
    // BLOCKER (Codex #331): the dedup key must come from the PERSISTED row, never
    // the async-local context. If the ambient ALS tenant/agent ever diverges from
    // the row being dispatched (e.g. a crash-recovered re-dispatch under a stale
    // context), an ALS-derived key would differ from the original send's key and
    // the transport could not dedup → the whole exactly-once guarantee collapses.
    //
    // We force that divergence: the relayer runs under ALS context tenant-A
    // (the enumerated tuple), but the CLAIMED ROW carries a DIFFERENT identity
    // (tenant-ROW/agent-ROW). The dispatched messageId MUST equal the key for the
    // ROW's identity — and MUST NOT equal the key the ALS context would produce.
    seed({ ...A_CTX });
    const ROW_IDENTITY = {
      tenant_id: 'tenant-ROW',
      agent_id: 'agent-ROW',
      idempotency_key: 'ik-row-only',
    };
    repoMock.claimPendingEffects.mockImplementationOnce(async () => {
      const ctx = tryGetCurrentContext();
      if (!ctx) throw new Error('claimPendingEffects ran with NO tenant context');
      claimContexts.push({ tenant_id: ctx.tenant_id, agent_id: ctx.agent_id });
      // Row identity intentionally DIFFERS from the ambient ALS context (ctx is
      // tenant-A/agent-A). Proves the key is computed off the row, not ctx.
      return [
        {
          id: 'ob-divergent',
          tenant_id: ROW_IDENTITY.tenant_id,
          agent_id: ROW_IDENTITY.agent_id,
          idempotency_key: ROW_IDENTITY.idempotency_key,
          effect_type: 'whatsapp_text',
          effect_payload: {
            kind: 'whatsapp_text',
            jid: '5511999990000@s.whatsapp.net',
            text: 'olá',
            mensagem_id: 'm1',
          },
          attempts: 0,
          max_attempts: 5,
        },
      ];
    });

    const { deriveProviderDedupKey } = await import(
      '@/governance/idempotency-effects.js'
    );
    const effect = {
      kind: 'whatsapp_text' as const,
      jid: '5511999990000@s.whatsapp.net',
      text: 'olá',
      mensagem_id: 'm1',
    };
    const keyFromRow = deriveProviderDedupKey(effect, ROW_IDENTITY);
    const keyFromAls = deriveProviderDedupKey(effect, {
      ...A_CTX,
      idempotency_key: ROW_IDENTITY.idempotency_key,
    });
    // Sanity: the two identities genuinely produce DIFFERENT keys, so the assert
    // below is meaningful (it can actually distinguish row-derived from ALS).
    expect(keyFromRow).not.toBe(keyFromAls);

    const { runIdempotencyOutboxRelayer } = await import(
      '@/workers/idempotency-outbox-relayer.js'
    );
    await runIdempotencyOutboxRelayer();

    expect(sendOutboundTextMock).toHaveBeenCalledTimes(1);
    const [, , opts] = sendOutboundTextMock.mock.calls[0]!;
    // The send carried the ROW-derived key — ALS did NOT influence it.
    expect(opts?.messageId).toBe(keyFromRow);
    expect(opts?.messageId).not.toBe(keyFromAls);
  });

  it('a CRASH-WINDOW re-dispatch sends with the SAME provider dedup key (deterministic)', async () => {
    // Simulate the irreducible #316 crash window: the gateway send SUCCEEDS but
    // the process crashes BEFORE markEffectSent persists. We model that by
    // letting the FIRST pass send, then forcing markEffectSent to no-op (row
    // stays 'pending'), so the SECOND pass re-claims and re-dispatches the SAME
    // row. The #327 contract: both sends carry the IDENTICAL provider id, so a
    // dedup-aware transport drops the duplicate (exactly-once end-to-end).
    seed({ ...A_CTX });

    // First pass: send succeeds, but markEffectSent "didn't persist" (crash).
    repoMock.markEffectSent.mockImplementationOnce(async (input) => {
      markSentCalls.push(input);
      return false; // row remains 'pending' — as if the crash lost the write.
    });

    const { runIdempotencyOutboxRelayer } = await import(
      '@/workers/idempotency-outbox-relayer.js'
    );
    await runIdempotencyOutboxRelayer();
    // Row is still pending (the markEffectSent no-op'd).
    expect(store[0]!.status).toBe('pending');

    // Second pass (next tick): re-claims the still-pending row and re-dispatches.
    await runIdempotencyOutboxRelayer();

    // The SAME effect was dispatched twice (the at-least-once tail)…
    expect(sendOutboundTextMock).toHaveBeenCalledTimes(2);
    const firstKey = sendOutboundTextMock.mock.calls[0]![2]?.messageId;
    const secondKey = sendOutboundTextMock.mock.calls[1]![2]?.messageId;
    // …BUT both carry the IDENTICAL provider-side dedup key, so the transport
    // dedups the second send → the user sees the message exactly once.
    expect(firstKey).toBeDefined();
    expect(firstKey).toBe(secondKey);
  });

  it('derives DIFFERENT keys for DIFFERENT tenants with the same idempotency_key (tenant isolation)', async () => {
    // Tenant isolation is inviolable: the dedup key folds tenant_id+agent_id
    // into the hash so two tenants computing the same idempotency_key get
    // DIFFERENT provider ids — the key can never be a cross-tenant correlation
    // handle, and one tenant's send can never dedup another's.
    const { deriveProviderDedupKey } = await import(
      '@/governance/idempotency-effects.js'
    );
    const effect = {
      kind: 'whatsapp_text' as const,
      jid: '5511999990000@s.whatsapp.net',
      text: 'olá',
      mensagem_id: 'm1',
    };
    const keyA = deriveProviderDedupKey(effect, {
      tenant_id: 'tenant-A',
      agent_id: 'agent-A',
      idempotency_key: 'same-key',
    });
    const keyB = deriveProviderDedupKey(effect, {
      tenant_id: 'tenant-B',
      agent_id: 'agent-B',
      idempotency_key: 'same-key',
    });
    expect(keyA).not.toBe(keyB);
    expect(keyA).toMatch(/^3EB0[0-9A-F]{18}$/);
    expect(keyB).toMatch(/^3EB0[0-9A-F]{18}$/);
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
    expect(repoMock.listTenantsWithWork).not.toHaveBeenCalled();
    expect(sendOutboundTextMock).not.toHaveBeenCalled();
    // Client returned to pool; no unlock (never held it).
    expect(poolStats.releases).toBe(1);
    expect(poolStats.unlocks).toBe(0);
    expect(store[0]!.status).toBe('pending');
  });

  it('releases the lock even when the dispatcher enumeration throws', async () => {
    seed({ ...A_CTX });
    repoMock.listTenantsWithWork.mockRejectedValueOnce(new Error('synthetic'));
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
  it('FORCE-TERMINALS a corrupt-payload row in one step WITHOUT dispatching or burning retries', async () => {
    // effect_type says whatsapp_text but the payload is missing required fields.
    // max_attempts=5 with attempts=0: under the OLD increment-only path the row
    // would stay 'pending' for 4 more pointless ticks. The force-terminal path
    // flips it to 'failed' immediately (markEffectFailed, NOT markEffectRetry).
    const row = seed({
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
    // Driven terminal via markEffectFailed (one step) — NOT via the retry path,
    // and NOT consuming the attempt budget.
    expect(markRetryCalls).toHaveLength(0);
    expect(markFailedCalls).toHaveLength(1);
    expect(markFailedCalls[0]!.id).toBe(row.id);
    expect(markFailedCalls[0]!.error).toContain('invalid_effect_payload');
    // Row is terminal 'failed' with attempts UNTOUCHED (no wasted retries).
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(0);
    const invalidLogs = errorSpy.mock.calls.filter(
      (c) => c[1] === 'idempotency_outbox_relayer.invalid_payload',
    );
    expect(invalidLogs).toHaveLength(1);
    expect(invalidLogs[0]![0]).toMatchObject({ ops_alert: true, final_status: 'failed' });
  });
});

describe('idempotency_outbox_relayer — retention reaches idle tenants (#326 blocker)', () => {
  it('cleans up an IDLE tenant whose outbox has ONLY aged terminal rows (no pending)', async () => {
    // tenant-A is IDLE: its only rows are aged terminal rows (no pending, no
    // ready). Under the OLD pending-only enumeration this tenant was never
    // visited → its terminal rows accumulated without bound. The fix enumerates
    // it via the terminal-retention arm of listTenantsWithWork.
    seed({ ...A_CTX, status: 'sent', terminal_age_days: 90 });
    seed({ ...A_CTX, status: 'failed', terminal_age_days: 90 });

    const { runIdempotencyOutboxRelayer } = await import(
      '@/workers/idempotency-outbox-relayer.js'
    );
    await runIdempotencyOutboxRelayer();

    // The tenant WAS enumerated (terminal-row arm), context opened, cleanup ran.
    expect(repoMock.cleanupTerminal).toHaveBeenCalled();
    const cleanupCtxKeys = new Set(claimContexts.map((c) => `${c.tenant_id}|${c.agent_id}`));
    expect(cleanupCtxKeys.has('tenant-A|agent-A')).toBe(true);
    // No dispatch happened (no pending rows).
    expect(sendOutboundTextMock).not.toHaveBeenCalled();
    // The aged terminal rows were deleted (retention reached the idle tenant).
    expect(store.filter((r) => r.tenant_id === 'tenant-A')).toHaveLength(0);
  });

  it('enumerates a terminal-only tenant ALONGSIDE a pending tenant and drains both', async () => {
    // tenant-A: idle (aged terminal only). tenant-B: an active pending row.
    seed({ ...A_CTX, status: 'sent', terminal_age_days: 60 });
    seed({ ...B_CTX });

    const { runIdempotencyOutboxRelayer } = await import(
      '@/workers/idempotency-outbox-relayer.js'
    );
    await runIdempotencyOutboxRelayer();

    const ctxKeys = new Set(claimContexts.map((c) => `${c.tenant_id}|${c.agent_id}`));
    // BOTH tenants enumerated — A for retention, B for dispatch.
    expect(ctxKeys).toEqual(new Set(['tenant-A|agent-A', 'tenant-B|agent-B']));
    // A's aged terminal row deleted; B's pending row dispatched.
    expect(store.filter((r) => r.tenant_id === 'tenant-A')).toHaveLength(0);
    const bRow = store.find((r) => r.tenant_id === 'tenant-B')!;
    expect(bRow.status).toBe('sent');
  });

  it('does NOT enumerate a tenant whose terminal rows are still within retention', async () => {
    // FRESH terminal rows (age 0) are NOT past the 30-day window → no work →
    // the tenant is not enumerated (no wasted context / cleanup pass).
    seed({ ...A_CTX, status: 'sent', terminal_age_days: 0 });

    const { runIdempotencyOutboxRelayer } = await import(
      '@/workers/idempotency-outbox-relayer.js'
    );
    await runIdempotencyOutboxRelayer();

    expect(claimContexts).toHaveLength(0);
    expect(repoMock.cleanupTerminal).not.toHaveBeenCalled();
    // The fresh terminal row is retained.
    expect(store.filter((r) => r.tenant_id === 'tenant-A')).toHaveLength(1);
  });

  it('passes the configured retention window to listTenantsWithWork', async () => {
    seed({ ...A_CTX });
    const { runIdempotencyOutboxRelayer } = await import(
      '@/workers/idempotency-outbox-relayer.js'
    );
    await runIdempotencyOutboxRelayer();
    expect(repoMock.listTenantsWithWork).toHaveBeenCalledWith(RETENTION_DAYS);
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
