/**
 * P9b — Skill Selector.
 *
 * Spec §7.5: uses `skillsRepo.findActive` (P9a) and ranks candidates by
 * (category match × priority). Top-1 is `selected_skill_id`, top-5 are
 * `candidate_skill_ids`.
 *
 * F1 Phase 0 (anti-hijack): ranking by category/priority alone made EVERY turn
 * select whichever active skill ranked highest, regardless of whether the
 * message related to it — so with the Decision Engine ON, one active skill
 * hijacked all conversation. The selector now commits to a `selected_skill_id`
 * ONLY when a candidate clearly matches the classified intent (score ≥
 * SKILL_MATCH_THRESHOLD via the deterministic, import-safe matcher in
 * `skill-match.ts`). When nothing clearly matches it returns an EMPTY selection
 * (no `selected_skill_id`), which ActionDecider routes to a normal free-form
 * `respond`. Being conservative here is safe: under-selecting falls back to
 * chat; over-selecting hijacks.
 *
 * `candidate_skill_ids` is still populated from the active set (ranked) so Mid
 * PEP / downstream callers keep visibility into what was in scope; only the
 * single committed selection is gated by the match score.
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
import { SKILL_MATCH_THRESHOLD, scoreSkillMatch } from './skill-match.js';

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
    let candidateIds = ranked.slice(0, MAX_CANDIDATES).map((s) => s.id);

    // F1 Phase 0 anti-hijack: commit to a single skill ONLY when one clearly
    // matches the intent. Pick the BEST match (highest score; category/priority
    // breaks ties via the pre-sorted order) rather than the highest-ranked
    // candidate — a high-priority skill that is irrelevant to the turn must not
    // be selected just because it sorts first.
    let best: Skill | undefined;
    let bestScore = -1;
    for (const skill of ranked) {
      const score = scoreSkillMatch(skill, intent);
      if (score > bestScore) {
        bestScore = score;
        best = skill;
      }
    }

    const result: SkillSelectorResult = { candidate_skill_ids: candidateIds };

    if (best && bestScore >= SKILL_MATCH_THRESHOLD) {
      // Invariant (Codex PR #215 review, CORRECTNESS 3): selected_skill_id MUST
      // appear in the frozen top-N candidate_skill_ids. The best MATCH is chosen
      // by score, but candidates are the top-N by category×priority — so a skill
      // that matches the intent best can rank outside the top-N (e.g. a relevant
      // but low-priority skill). When that happens, prepend it and re-trim to
      // MAX_CANDIDATES so the selection is always present in the candidate set
      // and the list stays bounded.
      if (!candidateIds.includes(best.id)) {
        candidateIds = [best.id, ...candidateIds].slice(0, MAX_CANDIDATES);
        result.candidate_skill_ids = candidateIds;
      }
      result.selected_skill_id = best.id;
      // Codex round-2 findings 2+3: carry the scoped Skill object forward so
      // Mid PEP and ActionDecider use the SAME instance the routed-agent
      // query produced. This eliminates the unscoped find() lookup that
      // could otherwise return a homonym from another agent.
      result.selected_skill = best;
    }
    // else: ambiguous / unrelated turn → no selection. ActionDecider routes
    // this to a normal `respond` (free-form chat).

    return result;
  }
}

function rankByCategoryAndPriority(a: Skill, b: Skill): number {
  const aScore = (a.category === 'respond' ? 2 : 1) * (a.priority ?? 0);
  const bScore = (b.category === 'respond' ? 2 : 1) * (b.priority ?? 0);
  return bScore - aScore; // descending
}
