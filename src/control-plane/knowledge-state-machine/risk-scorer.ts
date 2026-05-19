/**
 * P10a — KnowledgeRiskScorer.
 *
 * **STUB IMPLEMENTATION** — the canonical implementation lives in P9c
 * (`src/control-plane/knowledge-risk-scorer/index.ts`). When that lands,
 * this file becomes a thin re-export of the canonical class.
 *
 * The stub implements the conservative-fallback contract documented in
 * the P10a plan ("if PR #97 not merged use stub: rule → SEMPRE
 * pending_review-shape inputs, low+conf>=0.6 → ephemeral-shape, default
 * → pending_review-shape"):
 *
 *   - kind='rule' → risk='high' (so decideInitialStatus routes to
 *     pending_review).
 *   - kind != 'rule' AND confidence >= 0.6 → risk='low' (so eligible
 *     for ephemeral when other gates allow).
 *   - otherwise → risk='medium' (forces pending_review).
 *
 * The scorer never downgrades a sensitivity hint coming from the
 * proposer — this preserves the master §5 "no-downgrade" invariant
 * even in stub mode.
 */

import type {
  KnowledgeKind,
  KnowledgeOrigin,
  KnowledgeRiskLevel,
  KnowledgeScope,
  KnowledgeSensitivity,
} from './types.js';

export interface KnowledgeRiskScoreInput {
  trace_id: string;
  tenant_id: string;
  agent_id: string;
  kind: KnowledgeKind;
  scope: KnowledgeScope;
  content_text: string;
  confidence: number;
  origin: KnowledgeOrigin;
  proposer_sensitivity_hint?: KnowledgeSensitivity;
}

export interface KnowledgeRiskScoreOutput {
  level: KnowledgeRiskLevel;
  sensitivity: KnowledgeSensitivity;
  reasons: string[];
  source: 'stub:p10a' | 'heuristic' | 'llm_elevated' | 'cache';
}

export class KnowledgeRiskScorer {
  static async score(
    input: KnowledgeRiskScoreInput,
  ): Promise<KnowledgeRiskScoreOutput> {
    const reasons: string[] = [];

    // Rule kind is always elevated risk so decideInitialStatus routes
    // it to pending_review (master §2.6 — non-negotiable).
    if (input.kind === 'rule') {
      reasons.push('kind=rule:always_human_review');
      return {
        level: 'high',
        sensitivity: input.proposer_sensitivity_hint ?? 'medium',
        reasons,
        source: 'stub:p10a',
      };
    }

    // user_explicit and human_approved skip the confidence check and
    // get a low risk floor — the human is the source.
    if (input.origin === 'user_explicit' || input.origin === 'human_approved') {
      reasons.push(`origin=${input.origin}:human_provided`);
      return {
        level: 'low',
        sensitivity: input.proposer_sensitivity_hint ?? 'low',
        reasons,
        source: 'stub:p10a',
      };
    }

    if (input.confidence >= 0.6) {
      reasons.push(`confidence>=0.6:${input.confidence.toFixed(2)}`);
      return {
        level: 'low',
        sensitivity: input.proposer_sensitivity_hint ?? 'low',
        reasons,
        source: 'stub:p10a',
      };
    }

    reasons.push(`confidence_below_threshold:${input.confidence.toFixed(2)}`);
    return {
      level: 'medium',
      sensitivity: input.proposer_sensitivity_hint ?? 'low',
      reasons,
      source: 'stub:p10a',
    };
  }
}
