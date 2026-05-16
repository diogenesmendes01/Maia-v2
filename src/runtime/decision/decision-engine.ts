/**
 * P9b — Decision Engine (Camada 2 Hot Path orchestrator).
 *
 * Spec §3 + §6 + §8. Composes 7 sub-decisions and 2 PEPs (Early/Mid) into
 * the final DecisionPacket. The Late PEP (3/3) runs in Camada 5
 * (Guardrails) and appends to the same `policy_decisions` array via
 * PepAudit before persistence.
 *
 * Architecture lock (spec §1): PolicyDescriptorResolver is consumed via DI;
 * Decision Engine NEVER imports the resolver implementation directly.
 *
 * Budget: <400ms baseline. Spec §6.2 fallback behaviour: if budget is
 * exhausted, returns a minimal packet with `action_mode='ask_clarification'`
 * (or `'escalate'` if the tenant has sensitive context).
 */
import { BudgetTracker } from './budget-tracker.js';
import { PepAudit } from './pep-audit.js';
import {
  BudgetExhaustedError,
  type ActionDecider,
  type ActionMode,
  type AgentSelector,
  type BlockDecision,
  type ContinueDecision,
  type EarlyPep,
  type IntentClassifier,
  type LockdownReader,
  type MidPep,
  type MidPepOutput,
  type MetricsClient,
  type PolicyDescriptorResolver,
  type RequireDualApprovalDecision,
  type RiskScorer,
  type SkillSelector,
  type SubBudgetName,
  type WorkflowSelector,
} from './types.js';
import type {
  BaseContextPacket,
  DecisionPacket,
} from '../context-packet/types.js';
import { DEFAULT_CONTEXT_REQUIREMENTS } from '../context-packet/types.js';

const TOTAL_BUDGET_MS = 400;

export interface DecisionEngineInput {
  base: BaseContextPacket;
  signal?: AbortSignal;
}

export interface DecisionEngineResult {
  packet: DecisionPacket;
  block?: BlockDecision;
  fallback_applied?: 'legacy_route' | 'ask_clarification' | null;
}

export interface DecisionEngineDeps {
  resolver: PolicyDescriptorResolver;
  earlyPep: EarlyPep;
  midPep: MidPep;
  intentClassifier: IntentClassifier;
  riskScorer: RiskScorer;
  workflowSelector: WorkflowSelector;
  agentSelector: AgentSelector;
  skillSelector: SkillSelector;
  actionDecider: ActionDecider;
  lockdownReader: LockdownReader;
  metrics?: MetricsClient;
  clock?: () => number;
}

const EMPTY_TOOL_PERMS: DecisionPacket['tool_permissions'] = {
  allowed_tools: [],
  blocked_tools: [],
  requires_confirmation: [],
};

const DEFAULT_EVAL_PLAN: DecisionPacket['evaluation_plan'] = {
  validators: [],
  llm_judge_required: false,
  human_review_required: false,
};

export class DecisionEngine {
  constructor(private deps: DecisionEngineDeps) {}

  async run(input: DecisionEngineInput): Promise<DecisionEngineResult> {
    const clock = this.deps.clock ?? (() => Date.now());
    const tracker = new BudgetTracker(TOTAL_BUDGET_MS, clock);
    const audit = new PepAudit();

    try {
      // --- Step 0: resolve all applicable policies once (cached in P8e). ---
      const resolved_policies = await this.deps.resolver.resolveDescriptors({
        tenant_id: input.base.tenant_id,
        agent_id: input.base.agent_id,
        descriptors: ['*'],
        scope: { channel: input.base.channel.kind },
      });

      // --- Step 1: Early PEP. ---
      tracker.startSub('early_pep');
      const earlyResult = await this.deps.earlyPep.evaluate({
        base: input.base,
        resolved_policies,
      });
      tracker.endSub('early_pep');

      if ('decision' in earlyResult) {
        audit.recordFromBlock(earlyResult);
        this.recordPepMetrics('early', earlyResult.decision);
        const packet = this.buildMinimalPacket(
          input.base,
          'escalate',
          audit,
          earlyResult,
        );
        this.emitTotalMetrics(tracker, packet);
        return { packet, block: earlyResult };
      }
      audit.recordWarnings('early', earlyResult.warnings);
      this.recordPepMetrics('early', 'allow');

      this.checkBudget(tracker, 'early_pep');

      // --- Step 2: intent classifier. ---
      tracker.startSub('intent');
      const intent = await this.deps.intentClassifier.classify(input.base);
      tracker.endSub('intent');

      this.checkBudget(tracker, 'intent');

      // --- Step 3: risk scorer (stub in P9b; TODO P9c). ---
      tracker.startSub('risk');
      const risk = await this.deps.riskScorer.score({ intent, base: input.base });
      tracker.endSub('risk');

      this.checkBudget(tracker, 'risk');

      // --- Step 4: workflow selector. ---
      tracker.startSub('workflow');
      const workflow = await this.deps.workflowSelector.select(input.base, intent);
      tracker.endSub('workflow');

      this.checkBudget(tracker, 'workflow');

      // --- Step 5: agent selector (no-op in P9b). ---
      tracker.startSub('agent');
      const agent = await this.deps.agentSelector.select(input.base);
      tracker.endSub('agent');

      this.checkBudget(tracker, 'agent');

      // --- Step 6: skill selector. ---
      tracker.startSub('skill');
      const skill = await this.deps.skillSelector.select(
        input.base,
        intent,
        workflow.workflow_id,
      );
      tracker.endSub('skill');

      this.checkBudget(tracker, 'skill');

      // --- Step 7: Mid PEP. ---
      tracker.startSub('mid_pep');
      const midResult: MidPepOutput = await this.deps.midPep.evaluate({
        base: input.base,
        intent,
        risk_profile: risk,
        ...(skill.selected_skill_id !== undefined
          ? { selected_skill_id: skill.selected_skill_id }
          : {}),
        candidate_skill_ids: skill.candidate_skill_ids,
        ...(workflow.workflow_id !== undefined
          ? { workflow_id: workflow.workflow_id }
          : {}),
        tool_permissions_preview: EMPTY_TOOL_PERMS,
        resolved_policies,
      });
      tracker.endSub('mid_pep');

      if ('decision' in midResult) {
        if (midResult.decision === 'block' || midResult.decision === 'escalate') {
          audit.recordFromBlock(midResult as BlockDecision);
          this.recordPepMetrics('mid', midResult.decision);
          const targetAction: ActionMode =
            midResult.decision === 'escalate' ? 'escalate' : 'ask_clarification';
          const packet = this.buildMinimalPacket(
            input.base,
            targetAction,
            audit,
            midResult as BlockDecision,
          );
          this.emitTotalMetrics(tracker, packet);
          return { packet, block: midResult as BlockDecision };
        }
        if (midResult.decision === 'require_dual_approval') {
          audit.recordFromDualApproval(
            midResult as RequireDualApprovalDecision,
          );
          this.recordPepMetrics('mid', 'require_dual_approval');
          const packet = this.buildMinimalPacket(
            input.base,
            'escalate',
            audit,
            undefined,
            `require_dual_approval:${(midResult as RequireDualApprovalDecision).approval_class}`,
          );
          this.emitTotalMetrics(tracker, packet);
          return { packet };
        }
      }
      audit.recordWarnings('mid', (midResult as ContinueDecision).warnings ?? []);
      this.recordPepMetrics('mid', 'allow');

      this.checkBudget(tracker, 'mid_pep');

      // --- Step 8: action decider. ---
      tracker.startSub('action');
      const decision = await this.deps.actionDecider.decide({
        base: input.base,
        intent,
        risk,
        workflow,
        skill,
        midPepOutcome: midResult,
        earlyWarnings: (earlyResult as ContinueDecision).warnings ?? [],
      });
      tracker.endSub('action');

      const packet: DecisionPacket = {
        trace_id: input.base.trace_id,
        intent,
        risk_profile: risk,
        routing: {
          ...(workflow.workflow_id !== undefined
            ? { workflow_id: workflow.workflow_id }
            : {}),
          agent_id: agent.agent_id,
          ...(skill.selected_skill_id !== undefined
            ? { selected_skill_id: skill.selected_skill_id }
            : {}),
          candidate_skill_ids: skill.candidate_skill_ids,
        },
        action_mode: decision.action_mode,
        tool_permissions: decision.tool_permissions,
        context_requirements: decision.context_requirements,
        evaluation_plan: decision.evaluation_plan,
        policy_decisions: audit.toArray(),
        rationale: decision.rationale,
      };

      this.emitTotalMetrics(tracker, packet);
      return { packet };
    } catch (err) {
      if (err instanceof BudgetExhaustedError || tracker.exhausted()) {
        return this.budgetFallback(input.base, tracker, audit, err);
      }
      throw err;
    }
  }

  private checkBudget(tracker: BudgetTracker, step: SubBudgetName): void {
    if (tracker.exhausted()) {
      throw new BudgetExhaustedError(step, tracker.elapsed());
    }
  }

  private async budgetFallback(
    base: BaseContextPacket,
    tracker: BudgetTracker,
    audit: PepAudit,
    err: unknown,
  ): Promise<DecisionEngineResult> {
    const failedStep =
      err instanceof BudgetExhaustedError ? err.step : 'unknown';
    const sensitive = await this.safeSensitiveCheck(base.tenant_id);
    const action_mode: ActionMode = sensitive ? 'escalate' : 'ask_clarification';

    this.deps.metrics?.increment('decision_engine.budget_fallback', {
      failed_step: failedStep,
    });

    const packet = this.buildMinimalPacket(
      base,
      action_mode,
      audit,
      undefined,
      `budget_fallback:${failedStep}`,
    );
    this.emitTotalMetrics(tracker, packet);
    return {
      packet,
      fallback_applied: action_mode === 'escalate' ? null : 'ask_clarification',
    };
  }

  private async safeSensitiveCheck(tenant_id: string): Promise<boolean> {
    try {
      return await this.deps.lockdownReader.tenantHasSensitiveContext(tenant_id);
    } catch {
      // Fail-closed: if unable to check, assume sensitive.
      return true;
    }
  }

  private buildMinimalPacket(
    base: BaseContextPacket,
    action_mode: ActionMode,
    audit: PepAudit,
    block?: BlockDecision,
    rationale?: string,
  ): DecisionPacket {
    return {
      trace_id: base.trace_id,
      intent: { label: block ? 'blocked' : 'unknown', confidence: 0 },
      risk_profile: { level: 'low', reasons: [], requires_human_review: false },
      routing: { agent_id: base.agent_id, candidate_skill_ids: [] },
      action_mode,
      tool_permissions: EMPTY_TOOL_PERMS,
      context_requirements: DEFAULT_CONTEXT_REQUIREMENTS,
      evaluation_plan: {
        ...DEFAULT_EVAL_PLAN,
        human_review_required: action_mode === 'escalate',
      },
      policy_decisions: audit.toArray(),
      rationale: rationale ?? block?.reason ?? 'fallback',
    };
  }

  private emitTotalMetrics(
    tracker: BudgetTracker,
    packet: DecisionPacket,
  ): void {
    if (!this.deps.metrics) return;
    this.deps.metrics.recordHistogram(
      'decision_engine.duration_ms',
      tracker.elapsed(),
    );
    for (const [step, duration] of Object.entries(tracker.snapshot())) {
      this.deps.metrics.recordHistogram(
        'decision_engine.sub_duration_ms',
        duration,
        { step },
      );
    }
    this.deps.metrics.increment('decision_engine.packet_emitted', {
      action_mode: packet.action_mode,
    });
  }

  private recordPepMetrics(pep: string, decision: string): void {
    if (!this.deps.metrics) return;
    this.deps.metrics.increment('decision_engine.pep_evaluated', {
      pep,
      decision,
    });
  }
}
