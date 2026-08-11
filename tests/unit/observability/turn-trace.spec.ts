/**
 * Issue #514 §4 — the durable runtime trace connected to the hot path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const traceMock = vi.fn();
vi.mock('@/control-plane/runtime-trace/index.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/control-plane/runtime-trace/index.js')
  >();
  return { ...actual, trace: traceMock };
});

/**
 * Issue #515 — the rollout gate now comes from the typed config loader. Every
 * other key stays real (the runtime-trace import graph boots the DB client and
 * the HMAC module), so we override exactly one property.
 */
const cfg = vi.hoisted(() => ({ traceEnabled: false }));
vi.mock('@/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/env.js')>();
  return {
    ...actual,
    config: new Proxy(actual.config, {
      get: (target, prop, receiver) =>
        prop === 'FEATURE_RUNTIME_TRACE_V1'
          ? cfg.traceEnabled
          : Reflect.get(target, prop, receiver),
    }),
  };
});

const {
  traceTurnDecision,
  toDecisionStub,
  toContextStub,
  sideEffectLevelFor,
  decisionFor,
  riskScoreFor,
  runtimeTraceHotPathEnabled,
  MandatoryTraceEnvelopeError,
} = await import('@/observability/turn-trace.js');
const { renderPrometheus, _resetForTests } = await import('@/lib/metrics.js');
const { _resetLabelGuardForTests } = await import('@/observability/labels.js');
const { redactPacket } = await import('@/control-plane/runtime-trace/lib/redaction.js');

import type { BaseContextPacket, DecisionPacket } from '@/runtime/context-packet/types.js';

const TRACE_ID = '3f1a9d2e-4c5b-4a7e-9f0d-1b2c3d4e5f60';
const CONVERSA_ID = '11111111-2222-4333-8444-555555555555';
const TURNO_ID = '99999999-8888-4777-8666-555555555555';

function baseFixture(over: Partial<BaseContextPacket> = {}): BaseContextPacket {
  return {
    trace_id: TRACE_ID,
    tenant_id: 'acme',
    agent_id: 'a1',
    session_id: CONVERSA_ID,
    conversation_id: CONVERSA_ID,
    channel: { id: 'ch-1', kind: 'whatsapp', is_locked_down: false },
    actor: { user_id: null, pessoa_id: 'p1', role: 'end_user', is_authenticated: true },
    input: {
      kind: 'text',
      content_ref: TURNO_ID,
      content_hmac: 'abc123',
      received_at: '2026-07-01T10:00:00.000Z',
    },
    active_procedure_execution_id: null,
    feature_flags_snapshot: {},
    entered_at_ms: Date.now(),
    active_sensitive_memory_count: 0,
    ...over,
  } as BaseContextPacket;
}

function packetFixture(over: Partial<DecisionPacket> = {}): DecisionPacket {
  return {
    trace_id: TRACE_ID,
    intent: { label: 'consulta', confidence: 0.8 },
    risk_profile: { level: 'low', reasons: [], requires_human_review: false },
    routing: { agent_id: 'a1', candidate_skill_ids: [] },
    action_mode: 'respond',
    tool_permissions: { allowed_tools: [], blocked_tools: [], requires_confirmation: [] },
    context_requirements: {} as DecisionPacket['context_requirements'],
    evaluation_plan: { validators: [], llm_judge_required: false, human_review_required: false },
    policy_decisions: [],
    rationale: '',
    ...over,
  } as DecisionPacket;
}

describe('issue #514 — runtime trace on the hot path', () => {
  beforeEach(() => {
    traceMock.mockReset();
    traceMock.mockResolvedValue({
      trace_id: TRACE_ID,
      envelope_hmac: 'sig',
      hmac_key_version: 1,
      side_effect_level: 'low',
      decision: 'allow',
      policy_id: null,
      redaction_class: 'standard',
      sync_latency_ms: 1,
    });
    _resetForTests();
    _resetLabelGuardForTests();
    cfg.traceEnabled = false;
  });

  describe('rollout gate', () => {
    it('is OFF by default — the hot path is unchanged', async () => {
      expect(runtimeTraceHotPathEnabled()).toBe(false);
      const env = await traceTurnDecision({ base: baseFixture(), packet: packetFixture() });
      expect(env).toBeNull();
      expect(traceMock).not.toHaveBeenCalled();
    });

    it('traces the turn once the contract flag is on', async () => {
      // #515: the value comes from the typed loader and is resolved at BOOT,
      // so flipping it needs a restart (contract: restartRequired: true).
      cfg.traceEnabled = true;
      expect(runtimeTraceHotPathEnabled()).toBe(true);
      await traceTurnDecision({ base: baseFixture(), packet: packetFixture() });
      expect(traceMock).toHaveBeenCalledTimes(1);
    });

    it('counts the skip so coverage is measurable, not assumed', async () => {
      await traceTurnDecision({ base: baseFixture(), packet: packetFixture() });
      const out = await renderPrometheus();
      expect(out).toContain('maia_runtime_trace_coverage_total');
      expect(out).toContain('result="skipped"');
      expect(out).toContain('reason="disabled"');
    });
  });

  describe('decision mapping', () => {
    it('no block ⇒ allow', () => {
      expect(decisionFor(null)).toBe('allow');
    });
    it('block ⇒ deny, escalate ⇒ escalate', () => {
      expect(decisionFor({ decision: 'block' })).toBe('deny');
      expect(decisionFor({ decision: 'escalate' })).toBe('escalate');
    });

    it('risk score is deterministic (AGENTS.md §4.5 — never LLM-declared)', () => {
      expect(riskScoreFor('low')).toBe(riskScoreFor('low'));
      expect(riskScoreFor('low')).toBeLessThan(riskScoreFor('medium'));
      expect(riskScoreFor('medium')).toBeLessThan(riskScoreFor('high'));
    });

    it('effect-capable action modes require an envelope', () => {
      const lowRisk = { risk_profile: { level: 'low' as const } };
      expect(sideEffectLevelFor({ ...lowRisk, action_mode: 'call_tool' }, false)).toBe('medium');
      expect(sideEffectLevelFor({ ...lowRisk, action_mode: 'execute_skill' }, false)).toBe('medium');
      expect(
        sideEffectLevelFor(
          { risk_profile: { level: 'high' }, action_mode: 'call_tool' },
          false,
        ),
      ).toBe('high');
    });

    it('read-only modes stay best-effort', () => {
      const lowRisk = { risk_profile: { level: 'low' as const } };
      expect(sideEffectLevelFor({ ...lowRisk, action_mode: 'respond' }, false)).toBe('low');
      expect(sideEffectLevelFor({ ...lowRisk, action_mode: 'ask_clarification' }, false)).toBe('low');
    });

    it('a governance block is itself mandatory evidence', () => {
      expect(
        sideEffectLevelFor({ risk_profile: { level: 'low' }, action_mode: 'respond' }, true),
      ).toBe('medium');
    });

    it('forwards PEP verdicts as enums, never the operator free-text reason', () => {
      const stub = toDecisionStub({
        base: baseFixture(),
        packet: packetFixture({
          policy_decisions: [
            {
              pep: 'mid',
              policy_id: 'pol-1',
              rule_descriptor: 'd',
              decision: 'block',
              reason: 'user said "my card is 4111 1111 1111 1111"',
            },
          ],
        }),
      });
      expect(stub.policy_hooks).toEqual([{ hook: 'mid', policy_id: 'pol-1', effect: 'block' }]);
      expect(JSON.stringify(stub)).not.toContain('4111');
    });
  });

  describe('privacy of the body packet', () => {
    it('carries no message text, media, phone or person name', () => {
      const stub = toContextStub({
        base: baseFixture(),
        packet: packetFixture(),
      });
      const serialized = JSON.stringify(stub);
      expect(serialized).not.toContain('text');
      expect(serialized).not.toContain('media_refs');
      expect(serialized).not.toContain('telefone');
      expect(stub.request).toEqual({ direction: 'inbound' });
    });

    it('every key survives redaction — nothing is silently dropped', () => {
      const stub = toContextStub({ base: baseFixture(), packet: packetFixture() });
      const { packet } = redactPacket(stub, 'standard');
      const redacted = packet as Record<string, unknown>;
      // A non-zero drop count would mean we put a key outside the allowlist on
      // the packet, i.e. the evidence trail is quietly losing fields.
      expect(redacted._redaction_dropped_unknown_count ?? 0).toBe(0);
    });

    it('drops non-UUID conversa/turno ids rather than breaking the UUID column', () => {
      const stub = toContextStub({
        base: baseFixture({
          conversation_id: 'conv_1750000000_ab',
          input: {
            kind: 'text',
            content_ref: 'input:123:deadbeef',
            content_hmac: 'x',
            received_at: '2026-07-01T10:00:00.000Z',
          },
        } as Partial<BaseContextPacket>),
        packet: packetFixture(),
      });
      expect(stub.conversa_id).toBeNull();
      expect(stub.turno_id).toBeNull();
    });

    it('skips entirely when the trace id is not UUID-shaped', async () => {
      cfg.traceEnabled = true;
      const env = await traceTurnDecision({
        base: baseFixture({ trace_id: 'not-a-uuid' }),
        packet: packetFixture(),
      });
      expect(env).toBeNull();
      expect(traceMock).not.toHaveBeenCalled();
      const out = await renderPrometheus();
      expect(out).toContain('reason="trace_id_shape"');
    });
  });

  describe('failure semantics', () => {
    beforeEach(() => {
      cfg.traceEnabled = true;
    });

    it('throws a TYPED error when a MANDATORY envelope cannot be written', async () => {
      // Review round 1 [P1]: a RAW rethrow is not enough — `agent/core.ts` only
      // blocks on typed errors, so a raw DB error let the turn continue to
      // ReAct. The type is the contract; the caller-level proof lives in
      // `tests/unit/agent-core-trace-envelope-fail-closed.spec.ts`.
      const cause = new Error('db down');
      traceMock.mockRejectedValue(cause);
      let thrown: unknown;
      try {
        await traceTurnDecision({
          base: baseFixture(),
          // call_tool ⇒ side_effect_level medium ⇒ envelope required
          packet: packetFixture({ action_mode: 'call_tool' }),
        });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(MandatoryTraceEnvelopeError);
      const err = thrown as InstanceType<typeof MandatoryTraceEnvelopeError>;
      expect(err.code).toBe('MANDATORY_TRACE_ENVELOPE_FAILED');
      expect(err.tenant_id).toBe('acme');
      expect(err.side_effect_level).toBe('medium');
      // The original failure is preserved for the incident log.
      expect(err.cause_error).toBe(cause);
    });

    it('swallows the failure when the envelope is NOT required', async () => {
      traceMock.mockRejectedValue(new Error('db down'));
      const env = await traceTurnDecision({
        base: baseFixture(),
        packet: packetFixture({ action_mode: 'respond' }),
      });
      expect(env).toBeNull();
    });

    it('counts both outcomes with a bounded `required` label', async () => {
      traceMock.mockRejectedValue(new Error('db down'));
      await traceTurnDecision({ base: baseFixture(), packet: packetFixture() }).catch(() => {});
      const out = await renderPrometheus();
      expect(out).toContain('result="failed"');
      expect(out).toContain('required="false"');
    });

    it('records the written envelope with tenant attribution', async () => {
      await traceTurnDecision({ base: baseFixture(), packet: packetFixture() });
      const out = await renderPrometheus();
      expect(out).toContain('result="written"');
      expect(out).toContain('tenant_id="acme"');
      expect(out).toContain('agent_id="a1"');
      // No high-cardinality id leaked into a label.
      expect(out).not.toContain(TRACE_ID);
      expect(out).not.toContain(CONVERSA_ID);
    });

    it('passes tenant + agent through to the envelope writer unchanged', async () => {
      await traceTurnDecision({ base: baseFixture(), packet: packetFixture() });
      expect(traceMock).toHaveBeenCalledWith(
        expect.objectContaining({
          trace_id: TRACE_ID,
          tenant_id: 'acme',
          agent_id: 'a1',
          conversa_id: CONVERSA_ID,
          turno_id: TURNO_ID,
          redaction_class: 'standard',
        }),
      );
    });
  });
});
