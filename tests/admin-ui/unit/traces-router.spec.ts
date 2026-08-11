/**
 * Issue #514 §7 — tracesRouter: the Trace Explorer is no longer a stub.
 *
 * Gates covered: tenant scoping (via `resolveTenantId` AND the repo argument),
 * cursor pagination, filter pass-through, redacted-by-default body, the
 * NOT_FOUND (never FORBIDDEN) answer for another tenant's trace, and the
 * privacy of the projection.
 */
import { describe, it, expect } from 'vitest';
import { TRPCError } from '@trpc/server';
import { tracesRouter } from '@/admin-ui/trpc/routers/traces.js';

const TRACE_ID = '3f1a9d2e-4c5b-4a7e-9f0d-1b2c3d4e5f60';
const CONVERSA_ID = '11111111-2222-4333-8444-555555555555';
const TURNO_ID = '99999999-8888-4777-8666-555555555555';

function envelopeRow(over: Record<string, unknown> = {}) {
  return {
    trace_id: TRACE_ID,
    tenant_id: 'tenant-A',
    agent_id: 'agent-a',
    conversa_id: CONVERSA_ID,
    turno_id: TURNO_ID,
    decision: 'allow',
    side_effect_level: 'medium',
    redaction_class: 'standard',
    body_status: 'persisted',
    body_persisted_at: new Date('2026-07-01T10:00:01Z'),
    created_at: new Date('2026-07-01T10:00:00Z'),
    ...over,
  };
}

function detailRow(over: Record<string, unknown> = {}) {
  return {
    ...envelopeRow(),
    policy_id: 'pol-1',
    envelope_hmac: 'c2lnbmF0dXJl',
    hmac_key_version: 1,
    // The repo recomputes this; the router only projects it.
    integrity: 'verified' as const,
    body_integrity: 'verified' as const,
    redacted_packet: {
      trace_id: TRACE_ID,
      tenant_id: 'tenant-A',
      policy_hooks: [{ hook_id: 'h1', outcome: 'allow', duration_ms: 3 }],
    },
    redaction_applied: 'standard_v1',
    bytes_redacted: 0,
    encrypted: false,
    body_available: true,
    ...over,
  };
}

function makeCtx(opts?: {
  role?: string;
  listResult?: { items: unknown[]; hasMore: boolean; nextCursor: string | null };
  detail?: Record<string, unknown> | null;
  grant?: unknown;
}) {
  const role = opts?.role ?? 'owner';
  const listCalls: Array<Record<string, unknown>> = [];
  const getCalls: Array<Record<string, unknown>> = [];

  const ctx = {
    session: { user: { id: 'user-1', role, tenant_id: 'tenant-A' } },
    userId: 'user-1',
    userRole: role,
    tenantId: 'tenant-A',
    repos: {
      runtimeTraceRepo: {
        async list(args: Record<string, unknown>) {
          listCalls.push(args);
          return (
            opts?.listResult ?? { items: [envelopeRow()], hasMore: false, nextCursor: null }
          );
        },
        async get(args: Record<string, unknown>) {
          getCalls.push(args);
          return opts?.detail === undefined ? detailRow() : opts.detail;
        },
      },
      debugSnapshotGrantsRepo: {
        async findActive() {
          return opts?.grant ?? null;
        },
      },
      adminAuditLogRepo: {
        async append(row: Record<string, unknown>) {
          return row;
        },
      },
    } as unknown as typeof import('@/db/repositories.js'),
    assertTenant: () => {},
    assertRole: (...roles: string[]) => {
      if (!roles.includes(role)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: `role ${role} not allowed` });
      }
    },
  };
  return { ctx, listCalls, getCalls };
}

describe('traces.listTraces', () => {
  it('is no longer a stub — it returns rows from the repo', async () => {
    const { ctx } = makeCtx();
    const res = await tracesRouter.createCaller(ctx).listTraces({ limit: 50 });
    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.id).toBe(TRACE_ID);
    expect(res.items[0]!.trace_id).toBe(TRACE_ID);
  });

  it('scopes the repo query by the SESSION tenant', async () => {
    const { ctx, listCalls } = makeCtx();
    await tracesRouter.createCaller(ctx).listTraces({ limit: 10 });
    expect(listCalls[0]!.tenantId).toBe('tenant-A');
  });

  it('refuses a non-founder asking for another tenant', async () => {
    const { ctx } = makeCtx({ role: 'owner' });
    await expect(
      tracesRouter.createCaller(ctx).listTraces({ tenantId: 'tenant-B', limit: 10 }),
    ).rejects.toThrowError(/FORBIDDEN|tenant/i);
  });

  it('lets a founder scope to another tenant explicitly', async () => {
    const { ctx, listCalls } = makeCtx({ role: 'founder' });
    await tracesRouter.createCaller(ctx).listTraces({ tenantId: 'tenant-B', limit: 10 });
    expect(listCalls[0]!.tenantId).toBe('tenant-B');
  });

  it('passes every filter through to the repo', async () => {
    const { ctx, listCalls } = makeCtx();
    const fromDate = new Date('2026-07-01T00:00:00Z');
    const toDate = new Date('2026-07-02T00:00:00Z');
    await tracesRouter.createCaller(ctx).listTraces({
      agentId: 'agent-a',
      conversaId: CONVERSA_ID,
      fromDate,
      toDate,
      decision: 'deny',
      sideEffectOnly: true,
      bodyStatus: 'orphaned',
      limit: 25,
      cursor: 'abc',
    });
    expect(listCalls[0]).toMatchObject({
      agentId: 'agent-a',
      conversaId: CONVERSA_ID,
      fromDate,
      toDate,
      decision: 'deny',
      sideEffectOnly: true,
      bodyStatus: 'orphaned',
      limit: 25,
      cursor: 'abc',
    });
  });

  it('surfaces the pagination cursor', async () => {
    const { ctx } = makeCtx({
      listResult: { items: [envelopeRow()], hasMore: true, nextCursor: 'next-page' },
    });
    const res = await tracesRouter.createCaller(ctx).listTraces({ limit: 1 });
    expect(res.hasMore).toBe(true);
    expect(res.nextCursor).toBe('next-page');
  });

  it('rejects an out-of-range limit (Zod)', async () => {
    const { ctx } = makeCtx();
    await expect(
      tracesRouter.createCaller(ctx).listTraces({ limit: 5000 }),
    ).rejects.toThrow();
  });

  it('rejects an unknown decision value (Zod)', async () => {
    const { ctx } = makeCtx();
    await expect(
      // @ts-expect-error — deliberately outside the enum
      tracesRouter.createCaller(ctx).listTraces({ limit: 10, decision: 'whatever' }),
    ).rejects.toThrow();
  });

  it('exposes the body lifecycle so pending/orphaned is visible', async () => {
    const { ctx } = makeCtx({
      listResult: {
        items: [envelopeRow({ body_status: 'orphaned', body_persisted_at: null })],
        hasMore: false,
        nextCursor: null,
      },
    });
    const res = await tracesRouter.createCaller(ctx).listTraces({ limit: 10 });
    expect(res.items[0]!.body_status).toBe('orphaned');
  });

  it('never projects the envelope signature into the list', async () => {
    const { ctx } = makeCtx();
    const res = await tracesRouter.createCaller(ctx).listTraces({ limit: 10 });
    expect(JSON.stringify(res)).not.toContain('envelope_hmac');
  });
});

describe('traces.getTrace', () => {
  it('returns the redacted body and the envelope metadata', async () => {
    const { ctx } = makeCtx();
    const res = await tracesRouter.createCaller(ctx).getTrace({ traceId: TRACE_ID });
    expect(res.trace_id).toBe(TRACE_ID);
    expect(res.decision).toBe('allow');
    expect(res.body_status).toBe('persisted');
    expect(res.redacted_packet).toMatchObject({ tenant_id: 'tenant-A' });
  });

  it('scopes the repo lookup by tenant — no post-filter', async () => {
    const { ctx, getCalls } = makeCtx();
    await tracesRouter.createCaller(ctx).getTrace({ traceId: TRACE_ID });
    expect(getCalls[0]).toEqual({ tenantId: 'tenant-A', traceId: TRACE_ID });
  });

  it("answers NOT_FOUND — not FORBIDDEN — for another tenant's trace", async () => {
    // FORBIDDEN would confirm the id exists somewhere: an existence oracle is
    // itself a cross-tenant leak.
    const { ctx } = makeCtx({ detail: null });
    let thrown: unknown;
    try {
      await tracesRouter.createCaller(ctx).getTrace({ traceId: TRACE_ID });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(TRPCError);
    expect((thrown as TRPCError).code).toBe('NOT_FOUND');
  });

  it('reports integrity without handing out the signature', async () => {
    const { ctx } = makeCtx();
    const res = await tracesRouter.createCaller(ctx).getTrace({ traceId: TRACE_ID });
    expect(res.envelope_integrity).toBe('verified');
    expect(res.envelope_signed).toBe(true);
    expect(res.hmac_key_version).toBe(1);
    expect(JSON.stringify(res)).not.toContain('c2lnbmF0dXJl');
  });

  it('a TAMPERED envelope is never reported as signed [P2]', async () => {
    // The regression this guards: the old implementation returned
    // `envelope_signed: envelope_hmac.length > 0`, so this exact row — a
    // non-empty but non-verifying signature — was shown to the operator as
    // signed during an incident.
    const { ctx } = makeCtx({ detail: detailRow({ integrity: 'invalid' }) });
    const res = await tracesRouter.createCaller(ctx).getTrace({ traceId: TRACE_ID });
    expect(res.envelope_integrity).toBe('invalid');
    expect(res.envelope_signed).toBe(false);
  });

  it('surfaces the BODY integrity too [round 2 P2]', async () => {
    // `packet_hmac` was persisted and never read back — same gap the envelope
    // check closed one round earlier.
    const { ctx } = makeCtx();
    const res = await tracesRouter.createCaller(ctx).getTrace({ traceId: TRACE_ID });
    expect(res.body_integrity).toBe('verified');
  });

  it('a tampered BODY is reported as invalid', async () => {
    const { ctx } = makeCtx({ detail: detailRow({ body_integrity: 'invalid' }) });
    const res = await tracesRouter.createCaller(ctx).getTrace({ traceId: TRACE_ID });
    expect(res.body_integrity).toBe('invalid');
    // The envelope can be intact while the body is not — they are separate
    // signatures over separate rows.
    expect(res.envelope_integrity).toBe('verified');
  });

  it('a pending body is `absent`, not `invalid`', async () => {
    const { ctx } = makeCtx({
      detail: detailRow({
        body_integrity: 'absent',
        body_status: 'pending',
        body_available: false,
        redacted_packet: null,
      }),
    });
    const res = await tracesRouter.createCaller(ctx).getTrace({ traceId: TRACE_ID });
    expect(res.body_integrity).toBe('absent');
  });

  it('an unverifiable envelope is `unknown`, not `invalid`', async () => {
    // Key rotated out / reader without the secret. Crying tampering here would
    // make every rotation look like an incident.
    const { ctx } = makeCtx({ detail: detailRow({ integrity: 'unknown' }) });
    const res = await tracesRouter.createCaller(ctx).getTrace({ traceId: TRACE_ID });
    expect(res.envelope_integrity).toBe('unknown');
    expect(res.envelope_signed).toBe(false);
  });

  it('derives PEP decisions from the redacted hooks only', async () => {
    const { ctx } = makeCtx();
    const res = await tracesRouter.createCaller(ctx).getTrace({ traceId: TRACE_ID });
    expect(res.pep_decisions).toHaveLength(1);
    expect(res.pep_decisions[0]!.decision).toBe('allow');
  });

  it('tolerates a body that has not been persisted yet', async () => {
    const { ctx } = makeCtx({
      detail: detailRow({
        redacted_packet: null,
        body_status: 'pending',
        body_persisted_at: null,
        body_available: false,
      }),
    });
    const res = await tracesRouter.createCaller(ctx).getTrace({ traceId: TRACE_ID });
    expect(res.redacted_packet).toBeNull();
    expect(res.pep_decisions).toEqual([]);
    expect(res.body_available).toBe(false);
  });

  it('does not hand out an encrypted body — that stays behind the grant flow', async () => {
    const { ctx } = makeCtx({
      detail: detailRow({ encrypted: true, redacted_packet: null }),
    });
    const res = await tracesRouter.createCaller(ctx).getTrace({ traceId: TRACE_ID });
    expect(res.body_encrypted).toBe(true);
    expect(res.redacted_packet).toBeNull();
  });

  it('reports whether a full-snapshot grant is active without widening it', async () => {
    const { ctx: noGrant } = makeCtx();
    expect(
      (await tracesRouter.createCaller(noGrant).getTrace({ traceId: TRACE_ID }))
        .full_snapshot_available,
    ).toBe(false);

    const { ctx: withGrant } = makeCtx({ grant: { id: 'g1' } });
    expect(
      (await tracesRouter.createCaller(withGrant).getTrace({ traceId: TRACE_ID }))
        .full_snapshot_available,
    ).toBe(true);
  });

  it('rejects a non-UUID traceId (Zod)', async () => {
    const { ctx } = makeCtx();
    await expect(
      tracesRouter.createCaller(ctx).getTrace({ traceId: 'not-a-uuid' }),
    ).rejects.toThrow();
  });
});
