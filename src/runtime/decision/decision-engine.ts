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
 *
 * Codex review #103: deadline enforcement is no longer "best effort". Every
 * awaited dependency is wrapped in a budget-derived deadline AND receives a
 * shared `AbortSignal`. A slow/hung resolver, classifier, repo, or PEP
 * evaluator can no longer pin the hot path past 400ms.
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
  /**
   * Optional caller-supplied AbortSignal. Aborting it short-circuits the
   * current step and the engine returns its standard budget fallback.
   */
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

/**
 * Wraps a promise in a deadline. Resolves with the original value if it
 * settles in time, otherwise rejects with `BudgetExhaustedError`.
 *
 * Uses a real setTimeout in production and the test-injected clock for
 * elapsed-time decisions in BudgetTracker; the two are decoupled on purpose
 * (we can't pre-empt a hung promise without a real timer, but BudgetTracker
 * still authoritatively decides what counts as "elapsed").
 */
function withDeadline<T>(
  p: Promise<T>,
  remainingMs: number,
  step: SubBudgetName,
  elapsedAtStart: number,
): Promise<T> {
  if (remainingMs <= 0) {
    // Suppress any late rejection from the orphaned promise so we don't leak
    // an unhandledRejection up to the host process.
    p.catch(() => {
      /* swallow: deadline already fired before await began */
    });
    return Promise.reject(new BudgetExhaustedError(step, elapsedAtStart));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new BudgetExhaustedError(step, elapsedAtStart + remainingMs));
    }, remainingMs);
    // Make sure a hung dependency does not keep the event loop alive past
    // the engine call.
    if (typeof (t as { unref?: () => void }).unref === 'function') {
      (t as { unref?: () => void }).unref!();
    }
    p.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        if (settled) {
          // Late rejection after deadline already fired — swallow.
          return;
        }
        settled = true;
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export class DecisionEngine {
  constructor(private deps: DecisionEngineDeps) {}

  async run(input: DecisionEngineInput): Promise<DecisionEngineResult> {
    const clock = this.deps.clock ?? (() => Date.now());
    const tracker = new BudgetTracker(TOTAL_BUDGET_MS, clock);
    const audit = new PepAudit();

    // Engine-wide abort controller. We abort it on budget exhaustion so
    // downstream awaits that look at AbortSignal can bail out promptly. We
    // also forward caller-supplied aborts.
    const controller = new AbortController();
    if (input.signal) {
      if (input.signal.aborted) {
        controller.abort();
      } else {
        input.signal.addEventListener('abort', () => controller.abort(), {
          once: true,
        });
      }
    }
    const signal = controller.signal;

    const runStep = async <T>(
      name: SubBudgetName,
      fn: () => Promise<T>,
    ): Promise<T> => {
      this.checkBudget(tracker, name);
      if (signal.aborted) {
        throw new BudgetExhaustedError(name, tracker.elapsed());
      }
      tracker.startSub(name);
      try {
        const remaining = tracker.remaining();
        return await withDeadline(fn(), remaining, name, tracker.elapsed());
      } finally {
        tracker.endSub(name);
      }
    };

    try {
      // --- Step 0: resolve all applicable policies (Codex #103: must obey budget too). ---
      const resolved_policies = await runStep('resolver', () =>
        this.deps.resolver.resolveDescriptors({
          tenant_id: input.base.tenant_id,
          agent_id: input.base.agent_id,
          descriptors: ['*'],
          scope: { channel: input.base.channel.kind },
        }),
      );

      // --- Step 1: Early PEP. ---
      const earlyResult = await runStep('early_pep', () =>
        this.deps.earlyPep.evaluate({
          base: input.base,
          resolved_policies,
        }),
      );

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

      // --- Step 2: intent classifier. ---
      const intent = await runStep('intent', () =>
        this.deps.intentClassifier.classify(input.base),
      );

      // --- Step 3: risk scorer (stub in P9b; TODO P9c). ---
      const risk = await runStep('risk', () =>
        this.deps.riskScorer.score({ intent, base: input.base }),
      );

      // --- Step 4: workflow selector. ---
      const workflow = await runStep('workflow', () =>
        this.deps.workflowSelector.select(input.base, intent),
      );

      // --- Step 5: agent selector (no-op in P9b). ---
      const agent = await runStep('agent', () =>
        this.deps.agentSelector.select(input.base),
      );

      // --- Step 6: skill selector. ---
      // Codex review #103: the skill selector MUST query under the resolved
      // routing agent (`agent.agent_id`), NOT `base.agent_id`. If channel
      // policy routes to a different agent than the one that built the
      // BaseContextPacket, base.agent_id would leak a different agent's
      // skills/tool permissions into the packet.
      const skillOptions: NonNullable<
        Parameters<SkillSelector['select']>[2]
      > = { agent_id_override: agent.agent_id };
      if (workflow.workflow_id !== undefined) {
        skillOptions.workflow_id = workflow.workflow_id;
      }
      const skill = await runStep('skill', () =>
        this.deps.skillSelector.select(input.base, intent, skillOptions),
      );

      // --- Step 7: Mid PEP. ---
      const midResult: MidPepOutput = await runStep('mid_pep', () =>
        this.deps.midPep.evaluate({
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
        }),
      );

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

      // --- Step 8: action decider. ---
      const decision = await runStep('action', () =>
        this.deps.actionDecider.decide({
          base: input.base,
          intent,
          risk,
          workflow,
          skill,
          midPepOutcome: midResult,
          earlyWarnings: (earlyResult as ContinueDecision).warnings ?? [],
        }),
      );

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
        // Make sure any still-pending awaits see the abort.
        controller.abort();
        return this.budgetFallback(input.base, tracker, audit, err);
      }
      throw err;
    } finally {
      // Idempotent: safe even if we already aborted above.
      controller.abort();
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
      // Defensive: the sensitive-check is invoked from the fallback path,
      // which by definition runs after the main budget is blown. Wrap it in
      // a tight (50ms) timeout so a hung lockdown reader cannot keep the
      // fallback itself open indefinitely. Fail-closed on timeout.
      return await Promise.race([
        this.deps.lockdownReader.tenantHasSensitiveContext(tenant_id),
        new Promise<boolean>((resolve) => {
          const t = setTimeout(() => resolve(true), 50);
          if (typeof (t as { unref?: () => void }).unref === 'function') {
            (t as { unref?: () => void }).unref!();
          }
        }),
      ]);
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
