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
  SkillSelectorAudience,
  SkillSelectorOptions,
  SkillSelectorResult,
  SkillsRepo,
} from './types.js';
import type {
  BaseContextPacket,
  DecisionPacket,
} from '../context-packet/types.js';
import { SKILL_MATCH_THRESHOLD, scoreSkillMatch } from './skill-match.js';
import {
  evaluateUsagePolicy,
  resolveEffectiveUsagePolicy,
  type UsagePolicyBlockReason,
} from '@/skills/usage-policy.js';
import { audit } from '@/governance/audit.js';
import { logger } from '@/lib/logger.js';
import type { AuditAction } from '@/governance/audit-actions.js';

export interface SkillSelectorDeps {
  skillsRepo: SkillsRepo;
}

const MAX_CANDIDATES = 5;

/** Map a usage-policy block reason to its append-only AUDIT_ACTIONS label. */
const BLOCK_REASON_TO_AUDIT: Record<UsagePolicyBlockReason, AuditAction> = {
  audience_blocked: 'skill_blocked_by_audience',
  channel_blocked: 'skill_blocked_by_channel',
  data_scope_blocked: 'skill_blocked_by_data_scope',
  auth_level_insufficient: 'skill_blocked_by_auth_level',
  risk_blocked: 'skill_blocked_by_risk',
};

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

    let ranked = [...candidates].sort(rankByCategoryAndPriority);

    // Issue #409 — usage-policy candidate filter (EARLY, conservative). Remove
    // every ranked candidate whose `usage_policy` does not admit the resolved
    // audience/channel/data_scope/risk BEFORE any tool reaches the LLM
    // (invariant #2: backend disposes BEFORE the LLM gets tools; invariant #5:
    // fail-closed — no admitted skill ⇒ empty selection ⇒ ActionDecider routes
    // to a free-form respond / escalate). Every admit/remove decision is audited
    // (invariant #4). The execution gate (skill-runner gate 4.6) re-checks the
    // SAME policy at run time, closing the TOCTOU window.
    //
    // The filter runs whenever an `audience` is supplied (the production
    // contract — the Decision Engine ALWAYS supplies one from the resolved
    // AudienceContext). Legacy/stub callers that omit `audience` skip the early
    // filter and rely on the unconditional fail-closed gate 4.6 in the runner.
    if (options?.audience) {
      ranked = await this.filterByUsagePolicy(ranked, base, options.audience);
      if (ranked.length === 0) {
        // No skill is safe for this audience. Surface the (already-filtered)
        // empty candidate set; ActionDecider falls back to respond/escalate.
        return { candidate_skill_ids: [] };
      }
    }

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

    // Strict `>` (not `>=`): owner decision following PR #217 review (issue #219).
    // An exact tie at SKILL_MATCH_THRESHOLD (e.g. 2-of-4 = 0.5) MUST NOT commit a
    // selection — boundary ties are ambiguous and historically allowed over-selection.
    // Tie-breaking ABOVE the threshold remains deterministic via the pre-sorted
    // category×priority order.
    if (best && bestScore > SKILL_MATCH_THRESHOLD) {
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

  /**
   * Issue #409 — apply each candidate's `SkillUsagePolicy` against the resolved
   * audience/channel/data_scope/risk and KEEP only the admitted ones.
   *
   * Fail-closed:
   *   - A skill with NO `usage_policy` is evaluated under the CONSERVATIVE
   *     DEFAULT (internal/trusted only) — see `resolveEffectiveUsagePolicy`.
   *   - A MALFORMED `usage_policy` is treated as a BLOCK (removed) — a broken
   *     governance policy must never silently widen access.
   *
   * Every decision is audited (invariant #4): `skill_allowed` for an admitted
   * candidate, `skill_blocked_by_*` (mapped from the typed block reason) for a
   * removed one. Audit is best-effort — a failed audit never changes the
   * admission outcome, but it is logged.
   */
  private async filterByUsagePolicy(
    ranked: Skill[],
    base: BaseContextPacket,
    audience: SkillSelectorAudience,
  ): Promise<Skill[]> {
    const auditCtx = {
      pessoa_id: base.actor?.pessoa_id ?? null,
      conversa_id: base.conversation_id ?? null,
    };

    const admitted: Skill[] = [];
    for (const skill of ranked) {
      const resolved = resolveEffectiveUsagePolicy(skill.usage_policy ?? null);
      if (!resolved.ok) {
        // Malformed policy → fail-closed (remove + audit as audience block with
        // the parse error detail so the trail explains the refusal).
        await this.auditDecision('skill_blocked_by_audience', skill, audience, {
          ...auditCtx,
          detail: `malformed_usage_policy: ${resolved.error}`,
          policy_source: 'malformed',
        });
        continue;
      }

      const decision = evaluateUsagePolicy(resolved.policy, {
        audience_type: audience.audience_type,
        trust_level: audience.trust_level,
        channel_type: audience.channel_type,
        ...(audience.allowed_data_scope !== undefined
          ? { allowed_data_scope: audience.allowed_data_scope }
          : {}),
        ...(audience.risk_level !== undefined ? { risk_level: audience.risk_level } : {}),
      });

      if (decision.allowed) {
        admitted.push(skill);
        await this.auditDecision('skill_allowed', skill, audience, {
          ...auditCtx,
          policy_source: resolved.source,
        });
      } else {
        await this.auditDecision(
          BLOCK_REASON_TO_AUDIT[decision.reason],
          skill,
          audience,
          { ...auditCtx, detail: decision.detail, policy_source: resolved.source },
        );
      }
    }
    return admitted;
  }

  private async auditDecision(
    acao: AuditAction,
    skill: Skill,
    audience: SkillSelectorAudience,
    extra: {
      pessoa_id: string | null;
      conversa_id: string | null;
      detail?: string;
      policy_source: string;
    },
  ): Promise<void> {
    try {
      await audit({
        acao,
        pessoa_id: extra.pessoa_id,
        conversa_id: extra.conversa_id,
        metadata: {
          enforcement_point: 'skill_selector_candidate_filter',
          skill_id: skill.id,
          skill_descriptor: skill.skill_descriptor ?? null,
          audience_type: audience.audience_type,
          trust_level: audience.trust_level,
          channel_type: audience.channel_type,
          policy_source: extra.policy_source,
          ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
        },
      });
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, acao, skill_id: skill.id },
        'skills.usage_policy.selector_audit_failed',
      );
    }
  }
}

function rankByCategoryAndPriority(a: Skill, b: Skill): number {
  const aScore = (a.category === 'respond' ? 2 : 1) * (a.priority ?? 0);
  const bScore = (b.category === 'respond' ? 2 : 1) * (b.priority ?? 0);
  return bScore - aScore; // descending
}
