/**
 * P6 Task 8 — Role Selector Engine (orquestrador).
 *
 * Cola tudo: roda os dois suggesters em paralelo (determinístico + LLM),
 * resolve conflitos (determinístico vence por ser mais barato e previsível),
 * delega a decisão final ao policy decider e SEMPRE registra a auditoria
 * em `role_selector_decisions` — mesmo quando `action='keep_current'`.
 *
 * Invariante (critério #3 da spec P6 done): TODA chamada a `selectRole`
 * gera exatamente 1 row em `role_selector_decisions`. Testado em
 * `tests/unit/role-audit-always-recorded.spec.ts`.
 *
 * Resolução de conflito entre suggesters:
 *  - Ambos sugerem o mesmo role → determinístico (origem auditável).
 *  - Discordam → determinístico vence; conflito registrado em `conflicts[]`.
 *  - Apenas um sugere → vence o que sugeriu.
 *  - Nenhum sugere → candidato null vai pro policy decider (que devolve
 *    keep_current/policy_default).
 */
import { roleSelectorDecisionsRepo } from '@/db/repositories.js';
import { llmSuggester } from './llm-suggester.js';
import { deterministicSuggester } from './deterministic-classifier.js';
import { decidePolicy } from './policy-decider.js';
import {
  SuggestedBy,
  RoleDecisionAction,
  DecidedBy,
  SwitchBehavior,
} from '@/types/enums.js';
import type { RoleSelectorInput, RoleCandidate } from './types.js';
import type { Role } from '@/db/schema.js';

export type RoleSelectorResult = {
  decided_role: Role;
  action: RoleDecisionAction;
  decision_id: string;
};

/**
 * Strength scoring helper. Mirrors the WEAK<MEDIUM<STRONG ordering used by
 * llm-suggester.ts (confidence-derived) and deterministic-classifier.ts
 * (regex-derived). Used by the tiebreaker when suggesters disagree.
 */
function strengthScore(s: RoleCandidate['strength']): number {
  if (s === 'strong') return 3;
  if (s === 'medium') return 2;
  return 1;
}

export async function selectRole(input: RoleSelectorInput): Promise<RoleSelectorResult> {
  // [P88-H4] Short-circuit on locked policies — the policy decider would
  // return keep_current regardless, and burning Haiku tokens + 3s latency
  // for a no-op is hot-path waste. Locked is the most common config for
  // the default Maia. Suggesters skipped; audit still records keep_current.
  const policySwitchBehavior = input.policy.switch_behavior as SwitchBehavior;
  if (policySwitchBehavior === SwitchBehavior.LOCKED) {
    const baseCount = input.conversa_id
      ? await roleSelectorDecisionsRepo.countSwitchesInConversation(input.conversa_id)
      : 0;
    const recorded = await roleSelectorDecisionsRepo.record({
      conversa_id: input.conversa_id,
      turno_id: input.turno_id,
      channel_id: input.channel_id,
      policy_id: input.policy.id,
      current_role_id: input.current_role.id,
      decided_role_id: input.current_role.id,
      action: RoleDecisionAction.KEEP_CURRENT,
      candidates: [],
      conflicts: [],
      suggested_by: SuggestedBy.NONE,
      decided_by: DecidedBy.POLICY_RULE,
      reason: 'policy locked',
      switch_count_in_conversation: baseCount,
    });
    return {
      decided_role: input.current_role,
      action: RoleDecisionAction.KEEP_CURRENT,
      decision_id: recorded.id,
    };
  }

  // Run both suggesters in parallel
  const [detResult, llmResult] = await Promise.all([
    deterministicSuggester.suggest(input),
    llmSuggester.suggest(input),
  ]);

  const candidates: RoleCandidate[] = [detResult, llmResult].filter(
    (c): c is RoleCandidate => c !== null,
  );
  const conflicts: Array<{ a: string; b: string; reason: string }> = [];

  // Conflict resolution. Default: deterministic wins (cheaper, regex source-
  // of-truth, audited via conflicts[]). Exception per [P88-H3] — respect a
  // meaningful strength delta: when the LLM candidate is STRICTLY STRONGER
  // (one full strength tier higher) than the deterministic one, the LLM wins
  // and the override is recorded in conflicts[]. A "medium vs medium" or
  // "strong vs medium" with the same confidence still picks deterministic.
  let chosenCandidate: RoleCandidate | null = null;
  if (detResult && llmResult) {
    if (detResult.role_id === llmResult.role_id) {
      chosenCandidate = detResult;
    } else {
      const detScore = strengthScore(detResult.strength);
      const llmScore = strengthScore(llmResult.strength);
      const llmWinsOnStrength = llmScore > detScore;
      if (llmWinsOnStrength) {
        conflicts.push({
          a: detResult.role_key,
          b: llmResult.role_key,
          reason: 'llm_stronger_signal',
        });
        chosenCandidate = llmResult;
      } else {
        conflicts.push({
          a: detResult.role_key,
          b: llmResult.role_key,
          reason: 'suggesters_disagree',
        });
        chosenCandidate = detResult;
      }
    }
  } else {
    chosenCandidate = detResult ?? llmResult;
  }

  const decision = await decidePolicy({ input, candidate: chosenCandidate });

  // Compute switch count for audit
  const baseCount = input.conversa_id
    ? await roleSelectorDecisionsRepo.countSwitchesInConversation(input.conversa_id)
    : 0;
  const newSwitchCount =
    decision.action === RoleDecisionAction.SWITCH ? baseCount + 1 : baseCount;

  // ALWAYS record — even for keep_current (spec §9 P6 done criterion #3)
  const recorded = await roleSelectorDecisionsRepo.record({
    conversa_id: input.conversa_id,
    turno_id: input.turno_id,
    channel_id: input.channel_id,
    policy_id: input.policy.id,
    current_role_id: input.current_role.id,
    suggested_role_id: chosenCandidate?.role_id,
    decided_role_id: decision.decided_role.id,
    action: decision.action,
    candidates: candidates.map((c) => ({
      role_key: c.role_key,
      confidence: c.confidence,
      strength: c.strength,
      suggested_by: c.suggested_by,
      reason: c.reason,
    })),
    conflicts,
    suggested_by: chosenCandidate?.suggested_by ?? SuggestedBy.NONE,
    decided_by: decision.decided_by,
    suggested_strength: chosenCandidate?.strength,
    suggested_confidence: chosenCandidate?.confidence,
    reason: decision.reason,
    switch_count_in_conversation: newSwitchCount,
  });

  return {
    decided_role: decision.decided_role,
    action: decision.action,
    decision_id: recorded.id,
  };
}
