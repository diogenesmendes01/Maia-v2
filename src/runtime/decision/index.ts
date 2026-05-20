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
import { RiskScorerStubImpl } from './risk-scorer.js';
import { SkillSelectorImpl } from './skill-selector.js';
import { WorkflowSelectorImpl } from './workflow-selector.js';

export {
  ActionDeciderImpl,
  AgentSelectorImpl,
  BudgetTracker,
  DecisionEngine,
  EarlyPepImpl,
  IntentClassifierImpl,
  MidPepImpl,
  PepAudit,
  RiskScorerStubImpl,
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
  // Use the injected riskScorer if provided (production uses RiskScorerProdAdapter
  // via createProductionDecisionEngineEnv); fall back to stub for test harnesses
  // that do not supply an override.
  const riskScorer = env.riskScorer ?? new RiskScorerStubImpl();
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
