/**
 * P9b — Action Decider.
 *
 * Spec §9.2: consolidates inputs from all upstream steps and chooses one of
 * 5 ActionModes:
 *   - escalate              (require_dual_approval, require_human_review)
 *   - continue_workflow     (active procedure in continue mode)
 *   - call_tool             (FOUND + selected skill is tool_mediated / decide)
 *   - respond               (default — incl. no selected skill = free-form chat)
 *   - ask_clarification     (NOT a normal no-skill outcome — a no-skill turn
 *                            routes to `respond`, see F1 Phase 0 below. The
 *                            engine still emits ask_clarification from a few
 *                            specific paths: this ActionDecider emits it when a
 *                            selected tool skill can't be resolved
 *                            (`skill_lookup_failed`) or a Mid PEP
 *                            `reduce_tool_set` strips every tool from a
 *                            tool-mediated skill; and DecisionEngine emits it on
 *                            a non-escalating Mid PEP block and on the
 *                            non-sensitive budget fallback
 *                            (decision-engine.ts ~:302 / ~:397).)
 *
 * Spec §9.3 derives context_requirements + evaluation_plan from skill hints.
 *
 * F1 Phase 0 (skill-execution coexistence): the Decision Engine must be SAFE
 * to enable. Two regressions are closed here:
 *   1. A turn with NO selected skill used to fall into `ask_clarification`,
 *      which `src/agent/core.ts` surfaces as a canned "Pode me dar mais
 *      detalhes?" and skips the LLM — i.e. it broke ALL free-form chat the
 *      moment the engine was switched on. It now routes to `respond` with
 *      `skill: null`, a normal free-form turn.
 *   2. The low-intent-confidence auto-`ask_clarification` was removed for the
 *      same reason (a perfectly normal chat message often classifies below the
 *      threshold and would have been hijacked into the canned reply).
 * Anti-hijack on the selection side lives in SkillSelector: it only returns a
 * `selected_skill_id` when the message clearly matches a skill, so the FOUND
 * branches below are reached only for genuinely skill-relevant turns.
 *
 * Budget target: <30ms.
 */
import type {
  ActionDecider,
  ActionDeciderInput,
  ActionDeciderResult,
  ContinueDecision,
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

    // 3. No selected skill → normal free-form `respond` (F1 Phase 0).
    //
    // Previously this fell into `ask_clarification`, which core.ts surfaces as
    // a canned "Pode me dar mais detalhes?" and skips the LLM — breaking ALL
    // free-form chat the moment the engine was enabled. A turn with no skill
    // (SkillSelector found nothing relevant — the anti-hijack guard) is a
    // perfectly normal chat turn and MUST reach the LLM via `respond` with a
    // null skill context. The low-intent-confidence auto-`ask_clarification`
    // is gone for the same reason: a normal message frequently classifies
    // below any threshold and would otherwise be hijacked into the canned
    // reply. `ask_clarification` now only originates from a Mid PEP
    // `reduce_tool_set` that empties a selected tool skill (below) — a state
    // that cannot arise on a no-skill turn.
    if (!input.skill.selected_skill_id) {
      return {
        action_mode: 'respond',
        tool_permissions: EMPTY_TOOL_PERMS,
        context_requirements: buildContextRequirements({
          skill: null,
          intent: input.intent,
          risk: input.risk,
          workflow: input.workflow,
        }),
        evaluation_plan: DEFAULT_EVAL_PLAN,
        rationale: 'respond:no_skill',
      };
    }

    // 4. Resolve the skill.
    //
    // Codex round-2 finding 3: prefer the scoped `selected_skill` instance
    // resolved upstream by SkillSelector (which queried under the routed
    // agent). The previous unscoped `find(skill_id)` would happily return a
    // skill from another agent — or even another tenant — sharing the same
    // ID, leaking its `allowed_tools` into the packet.
    //
    // We still fall back to `find(skill_id, scope)` for callers that didn't
    // populate `selected_skill` (e.g. tests / legacy wiring), but the call
    // is now SCOPED to `(tenant_id, routed agent_id)` so the leak is
    // closed in either path. If neither yields a skill, we treat it as a
    // lookup failure rather than silently emitting empty permissions.
    let skill: Skill | null = input.skill.selected_skill ?? null;
    if (!skill) {
      const lookupScope = {
        tenant_id: input.base.tenant_id,
        // ActionDecider sees only base.agent_id at this layer; the routed
        // agent is what was used by SkillSelector and is already encoded
        // into `selected_skill` when present. When falling back we use
        // base.agent_id which matches the original (pre-routing) caller
        // and is the only piece of identity available here.
        agent_id: input.base.agent_id,
      };
      const findOpts: { signal?: AbortSignal } = {};
      if (input.signal) findOpts.signal = input.signal;
      skill = await this.deps.skillsRepo.find(
        input.skill.selected_skill_id,
        lookupScope,
        findOpts,
      );
    }

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
      // Codex review #103: enforce Mid PEP `reduce_tool_set` reductions
      // BEFORE emitting the packet. If reducing removes every available tool
      // from a tool-mediated skill, fall back to ask_clarification — never
      // emit a call_tool packet with an empty allowed_tools list.
      const reductions = collectReductions(input.midPepOutcome);
      const toolPerms = applyToolReductions(buildToolPerms(skill), reductions);
      if (
        reductions.length > 0 &&
        toolPerms.allowed_tools.length === 0 &&
        (skill.allowed_tools ?? []).length > 0
      ) {
        return {
          action_mode: 'ask_clarification',
          tool_permissions: toolPerms,
          context_requirements: DEFAULT_CONTEXT_REQUIREMENTS,
          evaluation_plan: DEFAULT_EVAL_PLAN,
          rationale: `tool_set_reduced_to_empty:${skill.id}`,
        };
      }
      return {
        action_mode: 'call_tool',
        tool_permissions: toolPerms,
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

function collectReductions(
  outcome: ActionDeciderInput['midPepOutcome'],
): NonNullable<ContinueDecision['tool_reductions']> {
  // Block / escalate / dual_approval already short-circuit the engine before
  // action-decider runs, but we narrow defensively.
  if ('decision' in outcome) return [];
  return outcome.tool_reductions ?? [];
}

function applyToolReductions(
  perms: DecisionPacket['tool_permissions'],
  reductions: NonNullable<ContinueDecision['tool_reductions']>,
): DecisionPacket['tool_permissions'] {
  if (reductions.length === 0) return perms;
  const removed = new Set<string>();
  for (const r of reductions) {
    for (const t of r.removed_tools) removed.add(t);
  }
  if (removed.size === 0) return perms;
  const remainingAllowed = perms.allowed_tools.filter((t) => !removed.has(t));
  const removedActuallyAllowed = perms.allowed_tools.filter((t) =>
    removed.has(t),
  );
  // Merge into blocked_tools (dedup, preserve original order then appended).
  const blockedSet = new Set<string>(perms.blocked_tools);
  for (const t of removedActuallyAllowed) blockedSet.add(t);
  return {
    allowed_tools: remainingAllowed,
    blocked_tools: Array.from(blockedSet),
    requires_confirmation: perms.requires_confirmation.filter(
      (t) => !removed.has(t),
    ),
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
