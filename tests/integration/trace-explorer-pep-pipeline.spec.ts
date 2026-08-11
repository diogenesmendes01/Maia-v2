/**
 * Issue #514 review round 1 [P2] — PEP decisions must actually reach the
 * Trace Explorer.
 *
 * The bug: `toContextStub` built the persisted body WITHOUT `policy_hooks`,
 * while the Explorer reads `redacted_packet.policy_hooks` exclusively. The
 * hooks existed on the DecisionStub (the envelope), but the envelope is not
 * what the detail page renders — so the page said "nenhuma decisão PEP" even
 * for turns where policy fired.
 *
 * A unit test on either end would have missed it: `toContextStub` had nothing
 * to assert, and the router mapped an array it was handed. So this spec runs
 * the WHOLE pipeline with the real implementations at each hop:
 *
 *   toContextStub → redactPacket (real allowlist) → repo projection →
 *   tracesRouter.getTrace
 *
 * The redaction step is the one that matters: it is what silently dropped a
 * wrongly-shaped hook. Anything not on `POLICY_HOOK_ALLOWED` disappears on
 * write, which is exactly how this produced an empty array in production.
 */
import { describe, it, expect } from 'vitest';
import { TRPCError } from '@trpc/server';
import { toContextStub } from '@/observability/turn-trace.js';
import { redactPacket } from '@/control-plane/runtime-trace/lib/redaction.js';
import { tracesRouter } from '@/admin-ui/trpc/routers/traces.js';
import type { BaseContextPacket, DecisionPacket } from '@/runtime/context-packet/types.js';

const TRACE_ID = '3f1a9d2e-4c5b-4a7e-9f0d-1b2c3d4e5f60';
const CONVERSA_ID = '11111111-2222-4333-8444-555555555555';
const TURNO_ID = '99999999-8888-4777-8666-555555555555';

function baseFixture(): BaseContextPacket {
  return {
    trace_id: TRACE_ID,
    tenant_id: 'tenant-A',
    agent_id: 'agent-a',
    session_id: CONVERSA_ID,
    conversation_id: CONVERSA_ID,
    channel: { id: 'ch-1', kind: 'whatsapp', is_locked_down: false },
    actor: { user_id: null, pessoa_id: 'p1', role: 'end_user', is_authenticated: true },
    input: {
      kind: 'text',
      content_ref: TURNO_ID,
      content_hmac: 'deadbeef',
      received_at: '2026-07-01T10:00:00.000Z',
    },
    active_procedure_execution_id: null,
    feature_flags_snapshot: {},
    entered_at_ms: Date.now(),
    active_sensitive_memory_count: 0,
  } as BaseContextPacket;
}

/** Three PEPs fired, with free text that must NOT survive. */
function packetFixture(): DecisionPacket {
  return {
    trace_id: TRACE_ID,
    intent: { label: 'transferencia', confidence: 0.9 },
    risk_profile: { level: 'high', reasons: ['valor alto'], requires_human_review: true },
    routing: { agent_id: 'agent-a', candidate_skill_ids: [] },
    action_mode: 'call_tool',
    tool_permissions: { allowed_tools: ['transfer'], blocked_tools: [], requires_confirmation: [] },
    context_requirements: {} as DecisionPacket['context_requirements'],
    evaluation_plan: { validators: [], llm_judge_required: false, human_review_required: true },
    policy_decisions: [
      {
        pep: 'early',
        policy_id: 'pol-early',
        rule_descriptor: 'lockdown.check',
        decision: 'allow',
        reason: 'sem lockdown ativo',
      },
      {
        pep: 'mid',
        policy_id: 'pol-mid',
        rule_descriptor: 'limite.transferencia',
        decision: 'require_dual_approval',
        reason: 'cliente disse "meu telefone é +55 11 99999-9999"',
      },
      {
        pep: 'late',
        policy_id: 'pol-late',
        rule_descriptor: 'egress.check',
        decision: 'block',
        reason: 'destino fora da allowlist do cliente Fulano de Tal',
      },
    ],
    rationale: 'sensitive rationale that must never be persisted',
  } as DecisionPacket;
}

/**
 * Run the real write-side pipeline and return what the body writer would have
 * persisted into `runtime_trace_bodies.packet`.
 */
function persistedBody(): Record<string, unknown> {
  const stub = toContextStub({ base: baseFixture(), packet: packetFixture() });
  const { packet } = redactPacket(stub, 'standard');
  return packet as Record<string, unknown>;
}

function makeCtx(redacted_packet: unknown) {
  return {
    session: { user: { id: 'user-1', role: 'owner', tenant_id: 'tenant-A' } },
    userId: 'user-1',
    userRole: 'owner',
    tenantId: 'tenant-A',
    repos: {
      runtimeTraceRepo: {
        async list() {
          return { items: [], hasMore: false, nextCursor: null };
        },
        // Mirrors the real repo projection: the body goes through untouched.
        async get() {
          return {
            trace_id: TRACE_ID,
            tenant_id: 'tenant-A',
            agent_id: 'agent-a',
            conversa_id: CONVERSA_ID,
            turno_id: TURNO_ID,
            policy_id: 'pol-mid',
            decision: 'deny',
            side_effect_level: 'high',
            redaction_class: 'standard',
            envelope_hmac: 'sig',
            hmac_key_version: 1,
            integrity: 'verified' as const,
            body_status: 'persisted',
            body_persisted_at: new Date(),
            created_at: new Date(),
            redacted_packet,
            redaction_applied: 'standard_v1',
            bytes_redacted: 0,
            encrypted: false,
            body_available: true,
          };
        },
      },
      debugSnapshotGrantsRepo: { async findActive() { return null; } },
      adminAuditLogRepo: { async append(r: unknown) { return r; } },
    } as unknown as typeof import('@/db/repositories.js'),
    assertTenant: () => {},
    assertRole: (...roles: string[]) => {
      if (!roles.includes('owner')) throw new TRPCError({ code: 'FORBIDDEN' });
    },
  };
}

describe('issue #514 [P2] — PEP decisions survive writer → redaction → repo → router', () => {
  it('the persisted body CARRIES policy_hooks (it did not before)', () => {
    const body = persistedBody();
    expect(Array.isArray(body.policy_hooks)).toBe(true);
    expect(body.policy_hooks).toHaveLength(3);
  });

  it('real redaction keeps the hooks and drops nothing unknown', () => {
    const body = persistedBody();
    // A hook shaped with keys outside `POLICY_HOOK_ALLOWED` would arrive as an
    // array of EMPTY objects — present but useless. Assert the fields survive.
    const hooks = body.policy_hooks as Array<Record<string, unknown>>;
    expect(hooks[0]).toMatchObject({ hook_name: 'early', outcome: 'allow' });
    expect(hooks[1]).toMatchObject({ hook_name: 'mid', outcome: 'require_dual_approval' });
    expect(hooks[2]).toMatchObject({ hook_name: 'late', outcome: 'block' });
    expect(body._redaction_dropped_unknown_count ?? 0).toBe(0);
  });

  it('the free-text reason and rationale never reach the persisted body', () => {
    const serialized = JSON.stringify(persistedBody());
    expect(serialized).not.toContain('99999-9999');
    expect(serialized).not.toContain('Fulano de Tal');
    expect(serialized).not.toContain('sensitive rationale');
    expect(serialized).not.toContain('limite.transferencia');
    expect(serialized).not.toContain('egress.check');
  });

  it('the Explorer renders all three PEP decisions', async () => {
    const ctx = makeCtx(persistedBody());
    const res = await tracesRouter.createCaller(ctx).getTrace({ traceId: TRACE_ID });

    expect(res.pep_decisions).toHaveLength(3);
    expect(res.pep_decisions.map((d) => d.decision)).toEqual([
      'allow',
      'require_dual_approval',
      'block',
    ]);
    expect(res.pep_decisions.map((d) => d.pep)).toEqual(['early', 'mid', 'late']);
  });

  it('policy_refs list every policy that participated', async () => {
    const ctx = makeCtx(persistedBody());
    const res = await tracesRouter.createCaller(ctx).getTrace({ traceId: TRACE_ID });
    expect(res.policy_refs).toEqual(
      expect.arrayContaining(['pol-early', 'pol-mid', 'pol-late']),
    );
    // De-duplicated: `trace.policy_id` is also `pol-mid`.
    expect(res.policy_refs.filter((p) => p === 'pol-mid')).toHaveLength(1);
  });

  it('what the operator SEES carries no free text either', async () => {
    const ctx = makeCtx(persistedBody());
    const res = await tracesRouter.createCaller(ctx).getTrace({ traceId: TRACE_ID });
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('99999-9999');
    expect(serialized).not.toContain('Fulano de Tal');
    expect(serialized).not.toContain('sensitive rationale');
  });

  it('a turn with no policy decisions still yields an empty list, not a crash', async () => {
    const stub = toContextStub({
      base: baseFixture(),
      packet: { ...packetFixture(), policy_decisions: [] } as DecisionPacket,
    });
    const { packet } = redactPacket(stub, 'standard');
    const ctx = makeCtx(packet);
    const res = await tracesRouter.createCaller(ctx).getTrace({ traceId: TRACE_ID });
    expect(res.pep_decisions).toEqual([]);
  });

  it('a body still pending yields an empty list, not a crash', async () => {
    const ctx = makeCtx(null);
    const res = await tracesRouter.createCaller(ctx).getTrace({ traceId: TRACE_ID });
    expect(res.pep_decisions).toEqual([]);
  });
});
