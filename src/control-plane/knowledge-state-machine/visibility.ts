/**
 * P10a — Knowledge visibility predicate.
 *
 * Architecture Lock (master §0.1): mudança na VISIBILITY_TABLE exige
 * aprovação do founder via CODEOWNERS.
 *
 * The LLM only ever sees the 5 middle states (ephemeral..active).
 * 'proposed', 'pending_review', 'deprecated', and 'revoked' are
 * invisible regardless of context. 'strict' context_mode additionally
 * hides 'ephemeral' (for high-criticality skills/contexts).
 */

import type {
  KnowledgeLifecycleStatus,
  KnowledgeVisibilityContext,
  KnowledgeVisibilityResult,
} from './types.js';

const VISIBILITY_TABLE: Record<KnowledgeLifecycleStatus, KnowledgeVisibilityResult> = {
  proposed:       { visible: false, weight: 0.0, label: null },
  pending_review: { visible: false, weight: 0.0, label: null },
  ephemeral:      { visible: true,  weight: 0.3, label: '[novo, baixa confiança]' },
  observed:       { visible: true,  weight: 0.5, label: '[observado]' },
  reinforced:     { visible: true,  weight: 0.7, label: '[reforçado]' },
  verified:       { visible: true,  weight: 0.9, label: '[verificado]' },
  active:         { visible: true,  weight: 1.0, label: '[ativo]' },
  deprecated:     { visible: false, weight: 0.0, label: null },
  revoked:        { visible: false, weight: 0.0, label: null },
};

export function knowledgeIsVisible(
  k: { lifecycle_status: KnowledgeLifecycleStatus },
  ctx?: KnowledgeVisibilityContext,
): KnowledgeVisibilityResult {
  const result = VISIBILITY_TABLE[k.lifecycle_status];
  // Strict mode additionally hides ephemeral (low-confidence/new).
  if (ctx?.context_mode === 'strict' && k.lifecycle_status === 'ephemeral') {
    return { visible: false, weight: 0.0, label: null };
  }
  return result;
}

/**
 * Convenience accessor for tests + consumers that need to enumerate the
 * full visibility table. Returns a shallow copy to prevent mutation.
 */
export function getVisibilityTable(): Record<
  KnowledgeLifecycleStatus,
  KnowledgeVisibilityResult
> {
  return { ...VISIBILITY_TABLE };
}

/**
 * States that are visible to the LLM under default ('normal') context.
 * Used by KnowledgeStateMachine.propose to compute visible_to_llm flag.
 */
export const VISIBLE_STATES: ReadonlyArray<KnowledgeLifecycleStatus> = [
  'ephemeral',
  'observed',
  'reinforced',
  'verified',
  'active',
] as const;
