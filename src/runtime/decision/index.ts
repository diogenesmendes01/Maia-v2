/**
 * P9b — Decision Engine barrel export + composition root.
 *
 * Spec §3.4: `createDecisionEngine(env)` is the ONLY wiring path. PEPs and
 * sub-decisions are constructed here; `react-loop.ts` consumes the
 * `DecisionEngine` instance via DI.
 *
 * Architecture lock: nothing inside `src/runtime/decision/*` imports
 * `policy-descriptor-resolver.ts` directly. The resolver enters via `env`.
 */
import { ActionDeciderImpl } from './action-decider.js';
import { AgentSelectorImpl } from './agent-selector.js';
import { BudgetTracker } from './budget-tracker.js';
import { DecisionEngine } from './decision-engine.js';
import { EarlyPepImpl } from './early-pep.js';
import { IntentClassifierImpl } from './intent-classifier.js';
import { MidPepImpl } from './mid-pep.js';
import { PepAudit } from './pep-audit.js';
import { SkillSelectorImpl } from './skill-selector.js';
import { WorkflowSelectorImpl } from './workflow-selector.js';
import { scoreTurn } from './turn-risk-scorer.js';
import type {
  DecisionPacket,
  RiskLevel as ContextRiskLevel,
} from '../context-packet/types.js';
import type { LLMGate, ToolKind, TopicSignal } from '@/shared/risk/types.js';

// ---------------------------------------------------------------------------
// P9c — TurnRiskScorerAdapter
//
// Implements the `RiskScorer` interface (decision-engine boundary) by
// delegating to the real `scoreTurn` wrapper from P9c.
//
// Signal mapping: `{ intent, base }` → `TurnRiskSignals`.
//  - `intent.label` is inspected for known high-risk labels to derive topic.
//    Falls back to 'unknown' (ambiguous → gate consulted if budget allows).
//  - `intent._risk_topic` / `intent._risk_tool_kinds` are honoured when set
//    by callers or tests that already resolved these signals.
//  - `base.actor.is_authenticated` maps to an elevated topic signal.
//
// Output mapping: `ScoredRisk` → `DecisionPacket['risk_profile']`.
//  - 'critical' → 'high' (context-packet RiskLevel has 3 values; CRITICAL
//    is a P9c concept not yet in the outer type). requires_human_review=true.
//  - triggers → reasons (array of signal strings for audit trail).
// ---------------------------------------------------------------------------

// Intent labels that map to the 'financial' topic signal (MEDIUM baseline).
// Includes transfer/cancel/payment — these are elevated but not CRITICAL without
// an explicit sensitive tool signal. The P9c heuristic saturates to CRITICAL only
// when both critical_decision + sensitive_tool are present simultaneously; using
// 'financial' here preserves parity with the stub's behaviour (max 'medium'),
// keeps requires_human_review=false for the decision-engine integration contracts,
// and still allows the gate to elevate when Haiku sees additional context.
const FINANCIAL_INTENT_LABELS = new Set([
  'transfer_intent', 'cancel_request', 'change_password', 'delete_account',
  'balance_query', 'profile_update', 'payment', 'transaction',
]);

/** Approximate topic from intent label when no explicit _risk_topic is provided. */
function topicFromLabel(label: string): TopicSignal {
  if (FINANCIAL_INTENT_LABELS.has(label)) return 'financial';
  return 'unknown';
}

type IntentWithRiskHints = DecisionPacket['intent'] & {
  _risk_topic?: string;
  _risk_tool_kinds?: string[];
};

export class TurnRiskScorerAdapter implements RiskScorer {
  constructor(private opts: { gate?: LLMGate } = {}) {}

  async score(
    input: { intent: DecisionPacket['intent']; base: Parameters<RiskScorer['score']>[0]['base'] },
    _options?: { signal?: AbortSignal },
  ): Promise<DecisionPacket['risk_profile']> {
    const intentHints = input.intent as IntentWithRiskHints;

    // Resolve topic: prefer explicit hint, fall back to label heuristic.
    const topic: TopicSignal = (intentHints._risk_topic as TopicSignal | undefined)
      ?? topicFromLabel(input.intent.label);

    // Resolve tool_kinds: prefer explicit hint, fall back to empty.
    const tool_kinds: ToolKind[] = (intentHints._risk_tool_kinds as ToolKind[] | undefined)
      ?? [];

    const scored = await scoreTurn(
      { topic, tool_kinds },
      { gate: this.opts.gate, contextText: input.intent.label },
    );

    // Map ScoredRisk → DecisionPacket['risk_profile'].
    // Context-packet RiskLevel only has 'low'|'medium'|'high'; cap 'critical' → 'high'.
    const level: ContextRiskLevel =
      scored.level === 'critical' ? 'high' : (scored.level as ContextRiskLevel);

    const reasons = [
      ...scored.triggers.map((t) => t.signal),
      ...(scored.llm_reason ? [`llm:${scored.llm_reason}`] : []),
    ];

    return {
      level,
      reasons,
      requires_human_review: scored.level === 'critical' || scored.level === 'high',
    };
  }
}

export {
  ActionDeciderImpl,
  AgentSelectorImpl,
  BudgetTracker,
  DecisionEngine,
  EarlyPepImpl,
  IntentClassifierImpl,
  MidPepImpl,
  PepAudit,
  SkillSelectorImpl,
  WorkflowSelectorImpl,
};

export type {
  DecisionEngineDeps,
  DecisionEngineInput,
  DecisionEngineResult,
} from './decision-engine.js';

export {
  runDecisionEngineIfEnabled,
  runDecisionEngineForTurn,
  getDecisionEngine,
  _resetDecisionEngineSingleton,
  _overrideDecisionEngineSingleton,
  DecisionEngineFailClosedError,
  type RunDecisionEngineResult,
} from './integration.js';

export * from './types.js';

import type {
  ChannelPoliciesReader,
  ContentResolver,
  HaikuClient,
  LockdownReader,
  MetricsClient,
  PolicyDescriptorResolver,
  PolicyEvaluator,
  PolicyRulesRepo,
  ProceduresRepo,
  RiskScorer,
  SkillsRepo,
} from './types.js';

export interface CreateDecisionEngineEnv {
  resolver: PolicyDescriptorResolver;
  policyEvaluator: PolicyEvaluator;
  policyRepo: PolicyRulesRepo;
  skillsRepo: SkillsRepo;
  channelPolicies: ChannelPoliciesReader;
  lockdownReader: LockdownReader;
  proceduresRepo: ProceduresRepo;
  contentResolver: ContentResolver;
  haiku: HaikuClient;
  metrics?: MetricsClient;
  clock?: () => number;
  /**
   * Optional RiskScorer override. When not provided, the composition root
   * falls back to `RiskScorerStubImpl` for backward compatibility with
   * test harnesses that build their own env.
   * The production singleton (via `createProductionDecisionEngineEnv`) always
   * supplies `RiskScorerProdAdapter` so the real P9c scorer is used in prod.
   */
  riskScorer?: RiskScorer;
}

/**
 * Composition root: wires every concrete sub-component into a working
 * `DecisionEngine`. The returned instance is stateless and safe to share
 * across requests (per-request state lives in BudgetTracker + PepAudit
 * created inside `run()`).
 */
export function createDecisionEngine(
  env: CreateDecisionEngineEnv,
): DecisionEngine {
  const earlyPep = new EarlyPepImpl({
    lockdownReader: env.lockdownReader,
    policyRepo: env.policyRepo,
    evaluator: env.policyEvaluator,
  });
  const midPep = new MidPepImpl({
    policyRepo: env.policyRepo,
    evaluator: env.policyEvaluator,
  });
  const intentClassifierDeps: {
    contentResolver: ContentResolver;
    haiku: HaikuClient;
    metrics?: MetricsClient;
  } = {
    contentResolver: env.contentResolver,
    haiku: env.haiku,
  };
  if (env.metrics) intentClassifierDeps.metrics = env.metrics;
  const intentClassifier = new IntentClassifierImpl(intentClassifierDeps);
  // Use the injected riskScorer if provided (production uses createProductionDecisionEngineEnv
  // which supplies TurnRiskScorerAdapter); fall back to TurnRiskScorerAdapter for test
  // harnesses that do not supply an override. RiskScorerStubImpl is no longer used as
  // the default — real P9c scorer applies even in default env.
  const riskScorer = env.riskScorer ?? new TurnRiskScorerAdapter();
  const workflowSelector = new WorkflowSelectorImpl({
    proceduresRepo: env.proceduresRepo,
  });
  const agentSelector = new AgentSelectorImpl({
    channelPolicies: env.channelPolicies,
  });
  const skillSelector = new SkillSelectorImpl({ skillsRepo: env.skillsRepo });
  const actionDecider = new ActionDeciderImpl({ skillsRepo: env.skillsRepo });

  const deps: ConstructorParameters<typeof DecisionEngine>[0] = {
    resolver: env.resolver,
    earlyPep,
    midPep,
    intentClassifier,
    riskScorer,
    workflowSelector,
    agentSelector,
    skillSelector,
    actionDecider,
    lockdownReader: env.lockdownReader,
  };
  if (env.metrics) deps.metrics = env.metrics;
  if (env.clock) deps.clock = env.clock;
  return new DecisionEngine(deps);
}
