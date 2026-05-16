/**
 * P9b — Risk Scorer (stub).
 *
 * Spec §7.2 + master §0.4 principle 5 (no-downgrade invariant).
 *
 * This is the **stub** shipped with P9b. The real implementation (P9c) will
 * add LLM-based enrichment that can ELEVATE risk but NEVER DOWNGRADE — see
 * TurnRiskScorer in P9c (PR #97).
 *
 * Budget target: <40ms (stub is sync-equivalent; P9c will use Haiku in medium).
 *
 * TODO(P9c #97): Replace `RiskScorerStubImpl` with `TurnRiskScorer` from
 * P9c. Interface remains the same (no breaking change).
 */
import type { RiskScorer } from './types.js';
import type {
  BaseContextPacket,
  DecisionPacket,
  RiskLevel,
} from '../context-packet/types.js';

const HIGH_RISK_INTENTS = new Set([
  'transfer_intent',
  'cancel_request',
  'change_password',
  'delete_account',
]);

const MEDIUM_RISK_INTENTS = new Set(['balance_query', 'profile_update']);

export class RiskScorerStubImpl implements RiskScorer {
  async score(input: {
    intent: DecisionPacket['intent'];
    base: BaseContextPacket;
  }): Promise<DecisionPacket['risk_profile']> {
    const reasons: string[] = [];
    let level: RiskLevel = 'low';

    if (!input.base.actor.is_authenticated) {
      level = 'medium';
      reasons.push('actor_not_authenticated');
    }

    if (HIGH_RISK_INTENTS.has(input.intent.label)) {
      // P9b stub: never escalates beyond 'medium'.
      // P9c real may elevate to 'high' with LLM call. NEVER downgrade.
      if (level === 'low') level = 'medium';
      reasons.push(`high_risk_intent:${input.intent.label}`);
    }

    if (MEDIUM_RISK_INTENTS.has(input.intent.label) && level === 'low') {
      // Heuristic does NOT elevate by itself for medium intents — kept at low.
      // Document the reason for trace visibility.
      reasons.push(`medium_intent_noted:${input.intent.label}`);
    }

    return {
      level,
      reasons,
      requires_human_review: level === 'high',
    };
  }
}
