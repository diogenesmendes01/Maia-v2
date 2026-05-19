/**
 * P9b — Skill Selector.
 *
 * Spec §7.5: uses `skillsRepo.findActive` (P9a) and ranks candidates by
 * (category match × priority). Top-1 is `selected_skill_id`, top-5 are
 * `candidate_skill_ids`.
 *
 * Budget target: <40ms.
 */
import type {
  Skill,
  SkillSelector,
  SkillSelectorOptions,
  SkillSelectorResult,
  SkillsRepo,
} from './types.js';
import type {
  BaseContextPacket,
  DecisionPacket,
} from '../context-packet/types.js';

export interface SkillSelectorDeps {
  skillsRepo: SkillsRepo;
}

const MAX_CANDIDATES = 5;

export class SkillSelectorImpl implements SkillSelector {
  constructor(private deps: SkillSelectorDeps) {}

  async select(
    base: BaseContextPacket,
    intent: DecisionPacket['intent'],
    options?: SkillSelectorOptions,
  ): Promise<SkillSelectorResult> {
    // Codex review #103: always honour the routed agent over base.agent_id.
    // The channel policy may resolve a different default agent than the one
    // that built the BaseContextPacket; skill lookup MUST use the routed
    // agent or we leak skills/tool permissions across agents inside the same
    // tenant.
    const routedAgentId = options?.agent_id_override ?? base.agent_id;
    const query: Parameters<SkillsRepo['findActive']>[0] = {
      tenant_id: base.tenant_id,
      agent_id: routedAgentId,
      applicable_to_intent: intent.label,
    };
    if (options?.workflow_id !== undefined) {
      query.applicable_to_workflow = options.workflow_id;
    }

    const findOpts: { signal?: AbortSignal } = {};
    if (options?.signal) findOpts.signal = options.signal;
    const candidates = await this.deps.skillsRepo.findActive(query, findOpts);

    if (candidates.length === 0) {
      return { candidate_skill_ids: [] };
    }

    const ranked = [...candidates].sort(rankByCategoryAndPriority);
    const result: SkillSelectorResult = {
      candidate_skill_ids: ranked
        .slice(0, MAX_CANDIDATES)
        .map((s) => s.id),
    };
    const top = ranked[0];
    if (top) {
      result.selected_skill_id = top.id;
      // Codex round-2 findings 2+3: carry the scoped Skill object forward so
      // Mid PEP and ActionDecider use the SAME instance the routed-agent
      // query produced. This eliminates the unscoped find() lookup that
      // could otherwise return a homonym from another agent.
      result.selected_skill = top;
    }
    return result;
  }
}

function rankByCategoryAndPriority(a: Skill, b: Skill): number {
  const aScore = (a.category === 'respond' ? 2 : 1) * (a.priority ?? 0);
  const bScore = (b.category === 'respond' ? 2 : 1) * (b.priority ?? 0);
  return bScore - aScore; // descending
}
