/**
 * #360 — Composition-root default fallback for `riskScorer`.
 *
 * Guards the root cause of the #358 P9b Cenário 9 flake: when a caller builds
 * its own `CreateDecisionEngineEnv` and OMITS `riskScorer`, the composition
 * root MUST fall back to the deterministic `RiskScorerStubImpl` — NOT to the
 * live `haikuRiskGate` (a real `anthropic.messages.create()` round-trip).
 *
 * The previous fallback (`new TurnRiskScorerAdapter()` with no gate) resolved
 * to the live Haiku gate. A `transfer_intent` turn maps to the `financial`
 * topic, whose heuristic level is an *ambiguous* MEDIUM — exactly the case
 * `scorer.applyGate` consults the LLM for. Under the engine's 400ms budget
 * that network call is the documented footgun #358 had to deflake.
 *
 * This spec spies on the Anthropic SDK directly (same hoisted-mock pattern as
 * `tests/unit/risk-llm-gate.spec.ts`) and asserts the SDK is NEVER constructed
 * or called when `riskScorer` is omitted, and that the resolved `risk_profile`
 * matches the stub's deterministic output.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Spy on the Anthropic SDK exactly as `risk-llm-gate.spec.ts` does. If the
// composition root ever falls back to the live gate, `anthropicCreateMock`
// (and the `Anthropic` constructor) will be invoked — and these tests fail.
const { anthropicCreateMock, anthropicCtorMock, recordMock } = vi.hoisted(() => ({
  anthropicCreateMock: vi.fn(),
  anthropicCtorMock: vi.fn(),
  recordMock: vi.fn(async () => {}),
}));

vi.mock('@anthropic-ai/sdk', () => {
  const Anthropic = vi.fn(function (this: unknown, ...args: unknown[]) {
    anthropicCtorMock(...args);
    return { messages: { create: anthropicCreateMock } };
  });
  return { default: Anthropic };
});

// The live gate wraps its call in `runCognitiveModule`, which persists to
// cognitive_module_log. Mock the repo so a regression doesn't hit the DB AND
// so we can assert the gate's audit path was never entered.
vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
    '@/db/repositories.js',
  );
  return {
    ...actual,
    cognitiveModuleLogRepo: {
      record: recordMock,
      recentByModule: vi.fn(async () => []),
    },
  };
});

import { runDecisionEngineIfEnabled } from '@/runtime/decision/integration.ts';
import type { CreateDecisionEngineEnv } from '@/runtime/decision/index.js';
import type {
  ChannelPoliciesReader,
  ContentResolver,
  HaikuClient,
  LockdownReader,
  PolicyDescriptorResolver,
  PolicyEvaluator,
  PolicyRulesRepo,
  ProceduresRepo,
  SkillsRepo,
} from '@/runtime/decision/types.js';
import type { BaseContextPacket } from '@/runtime/context-packet/types.js';

function mkBase(): BaseContextPacket {
  return {
    trace_id: 't_360_1',
    tenant_id: 'tn_360',
    agent_id: 'ag1',
    channel: { id: 'ch1', kind: 'whatsapp', is_locked_down: false },
    actor: { id: 'a1', is_authenticated: true },
    input: { content_ref: 'cref', received_at: new Date() },
  } as unknown as BaseContextPacket;
}

/**
 * Builds a minimal env that OMITS `riskScorer`. `contentResolver.text`
 * returns a transfer phrase so the rules-first intent classifier resolves
 * `transfer_intent` deterministically (no Haiku call on the intent step
 * either — the `haiku.classify` mock stays untouched).
 */
function mkEnvOmittingRiskScorer(): CreateDecisionEngineEnv {
  const resolver: PolicyDescriptorResolver = {
    resolveDescriptors: vi.fn().mockResolvedValue([]),
  };
  const policyEvaluator: PolicyEvaluator = {
    evaluate: vi.fn().mockResolvedValue({ action: 'allow', reason: 'ok' }),
  };
  const policyRepo: PolicyRulesRepo = {
    getBody: vi.fn().mockResolvedValue(null),
    getBodySync: vi.fn().mockReturnValue(null),
  };
  const skillsRepo: SkillsRepo = {
    findActive: vi.fn().mockResolvedValue([]),
    find: vi.fn().mockResolvedValue(null),
  };
  const channelPolicies: ChannelPoliciesReader = {
    getForChannel: vi.fn().mockResolvedValue({
      channel_id: 'ch1',
      tenant_id: 'tn_360',
      default_agent_id: 'ag1',
    }),
  };
  const lockdownReader: LockdownReader = {
    isChannelLockedDown: vi.fn().mockResolvedValue(false),
    isTenantInGlobalLockdown: vi.fn().mockResolvedValue(false),
    tenantHasSensitiveContext: vi.fn().mockResolvedValue(false),
  };
  const proceduresRepo: ProceduresRepo = {
    findExecution: vi.fn().mockResolvedValue(null),
  };
  const contentResolver: ContentResolver = {
    // Matches HEURISTIC_INTENTS `transfer_intent` regex → deterministic intent,
    // no LLM classifier call.
    text: vi.fn().mockResolvedValue('transferir 100 reais'),
  };
  const haiku: HaikuClient = {
    classify: vi.fn().mockResolvedValue({ label: 'unknown', confidence: 0.5 }),
  };
  // NOTE: `riskScorer` intentionally omitted — this is the whole point.
  return {
    resolver,
    policyEvaluator,
    policyRepo,
    skillsRepo,
    channelPolicies,
    lockdownReader,
    proceduresRepo,
    contentResolver,
    haiku,
  };
}

describe('#360 — createDecisionEngine default riskScorer fallback', () => {
  beforeEach(() => {
    anthropicCreateMock.mockReset();
    anthropicCtorMock.mockReset();
    recordMock.mockClear();
  });

  it('does NOT invoke any LLM gate when riskScorer is omitted (high-risk intent)', async () => {
    const r = await runDecisionEngineIfEnabled(mkBase(), mkEnvOmittingRiskScorer());

    // The engine must have actually run the risk step (not short-circuited).
    expect(r.engine_ran).toBe(true);
    expect(r.result?.packet.intent.label).toBe('transfer_intent');

    // Core guard (#358 root cause): the live Haiku gate must never be reached.
    expect(anthropicCtorMock).not.toHaveBeenCalled();
    expect(anthropicCreateMock).not.toHaveBeenCalled();
    // ...and therefore the gate's cognitive_module_log audit path is untouched.
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('resolves risk_profile from the deterministic stub levels', async () => {
    const r = await runDecisionEngineIfEnabled(mkBase(), mkEnvOmittingRiskScorer());

    const risk = r.result?.packet.risk_profile;
    expect(risk).toBeDefined();
    // RiskScorerStubImpl: high-risk intent (transfer) on an authenticated actor
    // → 'medium', reason 'high_risk_intent:transfer_intent', no human review.
    // (The live TurnRiskScorerAdapter would instead emit gate-derived reasons.)
    expect(risk?.level).toBe('medium');
    expect(risk?.reasons).toContain('high_risk_intent:transfer_intent');
    expect(risk?.requires_human_review).toBe(false);
  });
});
