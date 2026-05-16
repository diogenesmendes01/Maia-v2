/**
 * P9b — Action Decider.
 *
 * Spec §9.2: consolidates inputs from all upstream steps and chooses one of
 * 5 ActionModes:
 *   - escalate              (require_dual_approval, require_human_review)
 *   - continue_workflow     (active procedure in continue mode)
 *   - ask_clarification     (missing skill OR low intent confidence)
 *   - call_tool             (skill is tool_mediated / decide)
 *   - respond               (default)
 *
 * Spec §9.3 derives context_requirements + evaluation_plan from skill hints.
 *
 * Budget target: <30ms.
 */
import type {
  ActionDecider,
  ActionDeciderInput,
  ActionDeciderResult,
  RequireDualApprovalDecision,
  Skill,
  SkillsRepo,
} from './types.js';
import type {
  ContextRequirements,
  DecisionPacket,
} from '../context-packet/types.js';
import { DEFAULT_CONTEXT_REQUIREMENTS } from '../context-packet/types.js';

export interface ActionDeciderDeps {
  skillsRepo: SkillsRepo;
}

const INTENT_CONFIDENCE_THRESHOLD = 0.6;

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

export class ActionDeciderImpl implements ActionDecider {
  constructor(private deps: ActionDeciderDeps) {}

  async decide(input: ActionDeciderInput): Promise<ActionDeciderResult> {
    // 1. Hard cases — require_dual_approval surfaces as escalate.
    if (
      'decision' in input.midPepOutcome &&
      input.midPepOutcome.decision === 'require_dual_approval'
    ) {
      const approval = input.midPepOutcome as RequireDualApprovalDecision;
      return {
        action_mode: 'escalate',
        tool_permissions: EMPTY_TOOL_PERMS,
        context_requirements: DEFAULT_CONTEXT_REQUIREMENTS,
        evaluation_plan: { ...DEFAULT_EVAL_PLAN, human_review_required: true },
        rationale: `require_dual_approval:${approval.approval_class}`,
      };
    }

    if (input.risk.requires_human_review) {
      return {
        action_mode: 'escalate',
        tool_permissions: EMPTY_TOOL_PERMS,
        context_requirements: DEFAULT_CONTEXT_REQUIREMENTS,
        evaluation_plan: { ...DEFAULT_EVAL_PLAN, human_review_required: true },
        rationale: 'human_review_required_by_risk',
      };
    }

    // 2. Workflow continuation wins (master §3.2).
    if (input.workflow.mode === 'continue' && input.workflow.workflow_id) {
      return {
        action_mode: 'continue_workflow',
        tool_permissions: EMPTY_TOOL_PERMS,
        context_requirements: buildContextRequirements({
          skill: null,
          intent: input.intent,
          risk: input.risk,
          workflow: input.workflow,
        }),
        evaluation_plan: DEFAULT_EVAL_PLAN,
        rationale: `continue:${input.workflow.workflow_id}`,
      };
    }

    // 3. Skill missing or intent too ambiguous → ask_clarification.
    if (
      !input.skill.selected_skill_id ||
      input.intent.confidence < INTENT_CONFIDENCE_THRESHOLD
    ) {
      return {
        action_mode: 'ask_clarification',
        tool_permissions: EMPTY_TOOL_PERMS,
        context_requirements: DEFAULT_CONTEXT_REQUIREMENTS,
        evaluation_plan: DEFAULT_EVAL_PLAN,
        rationale: !input.skill.selected_skill_id
          ? 'skill_missing'
          : `low_intent_confidence:${input.intent.confidence.toFixed(2)}`,
      };
    }

    // 4. Look up skill to decide tool path vs respond.
    const skill = await this.deps.skillsRepo.find(input.skill.selected_skill_id);

    if (!skill) {
      return {
        action_mode: 'ask_clarification',
        tool_permissions: EMPTY_TOOL_PERMS,
        context_requirements: DEFAULT_CONTEXT_REQUIREMENTS,
        evaluation_plan: DEFAULT_EVAL_PLAN,
        rationale: `skill_lookup_failed:${input.skill.selected_skill_id}`,
      };
    }

    if (skill.category === 'tool_mediated' || skill.category === 'decide') {
      return {
        action_mode: 'call_tool',
        tool_permissions: buildToolPerms(skill),
        context_requirements: buildContextRequirements({
          skill,
          intent: input.intent,
          risk: input.risk,
          workflow: input.workflow,
        }),
        evaluation_plan: {
          ...DEFAULT_EVAL_PLAN,
          llm_judge_required: false,
        },
        rationale: `call_tool:${skill.id}`,
      };
    }

    // 5. Default — respond.
    return {
      action_mode: 'respond',
      tool_permissions: EMPTY_TOOL_PERMS,
      context_requirements: buildContextRequirements({
        skill,
        intent: input.intent,
        risk: input.risk,
        workflow: input.workflow,
      }),
      evaluation_plan: DEFAULT_EVAL_PLAN,
      rationale: `respond:${skill.id}`,
    };
  }
}

function buildToolPerms(skill: Skill): DecisionPacket['tool_permissions'] {
  return {
    allowed_tools: skill.allowed_tools ?? [],
    blocked_tools: skill.blocked_tools ?? [],
    requires_confirmation: skill.requires_confirmation_tools ?? [],
  };
}

interface ContextReqsArgs {
  skill: Skill | null;
  intent: DecisionPacket['intent'];
  risk: DecisionPacket['risk_profile'];
  workflow: ActionDeciderInput['workflow'];
}

function buildContextRequirements(args: ContextReqsArgs): ContextRequirements {
  const wantsDeep =
    args.skill?.runtime_hints?.allow_deep_context === true ||
    args.risk.level !== 'low' ||
    !!args.workflow.workflow_id ||
    args.intent.label === 'plan' ||
    args.intent.label === 'diagnose';

  if (!wantsDeep) return DEFAULT_CONTEXT_REQUIREMENTS;

  return {
    ...DEFAULT_CONTEXT_REQUIREMENTS,
    user: { depth: 'deep', max_items: 20 },
    knowledge: { depth: 'deep', max_facts: 30, max_rules: 15 },
    history: { depth: 'relevant', max_turns: 12 },
    skill: 'selected_only',
  };
}
