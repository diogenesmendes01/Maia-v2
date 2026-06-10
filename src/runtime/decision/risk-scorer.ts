/**
 * P9b — Risk Scorer (stub).
 *
 * Spec §7.2 + master §0.4 principle 5 (no-downgrade invariant).
 *
 * This is the **stub** shipped with P9b. P9c (#97) shipped the real
 * implementation — `scoreTurn` in `turn-risk-scorer.ts`, with LLM-based
 * enrichment that can ELEVATE risk but NEVER DOWNGRADE — and production wires
 * it via `riskScorerProdAdapter` in `prod-env.ts` (#153).
 *
 * `RiskScorerStubImpl` is intentionally retained as the deterministic default
 * for test harnesses when `env.riskScorer` is omitted (#377 — keeps the live
 * Haiku risk gate out of harnesses; prod never hits it).
 *
 * Budget target: <40ms (stub is sync-equivalent).
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
  async score(
    input: {
      intent: DecisionPacket['intent'];
      base: BaseContextPacket;
    },
    _options?: { signal?: AbortSignal },
  ): Promise<DecisionPacket['risk_profile']> {
    // P9b stub is synchronous; AbortSignal forwarding becomes relevant when
    // P9c TurnRiskScorer adds a Haiku-based enrichment that performs I/O.
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

    // Defensive check: P9b stub never returns 'high' but the contract allows
    // future P9c implementations to elevate. Cast keeps the contract clear.
    const requires_human_review: boolean = (level as RiskLevel) === 'high';
    return {
      level,
      reasons,
      requires_human_review,
    };
  }
}
