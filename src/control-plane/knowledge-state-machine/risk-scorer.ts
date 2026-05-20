/**
 * P9c — KnowledgeRiskScorer (real implementation).
 *
 * Replaces the P10a stub (`source: 'stub:p10a'`) with the actual P9c
 * scorer from `src/control-plane/knowledge-state-machine/knowledge-risk-scorer.ts`.
 *
 * Adapter responsibilities (inline, <25 LoC):
 *  1. Maps `KnowledgeRiskScoreInput` (KSM-domain types) → `KnowledgeRiskSignals`
 *     (shared-risk domain types).
 *  2. Maps `KnowledgeKind` ('fact','rule','memory',...) → `knowledge_type`
 *     ('fato','regra','procedimento','lacuna','tool_request').
 *  3. Maps `ScoredRisk` → `KnowledgeRiskScoreOutput` (same shape the KSM
 *     state machine already reads: level/sensitivity/reasons/source).
 *
 * Signal mapping:
 *  - `kind` → `knowledge_type` via KIND_TO_KNOWLEDGE_TYPE table.
 *  - `confidence` → `derived_confidence`.
 *  - `origin` 'user_explicit'/'human_approved' → mark as high-evidence
 *    by setting derived_confidence=max(input, 0.8).
 *  - `proposer_sensitivity_hint` → `topic` proxy (high → 'critical_decision',
 *    medium → 'financial', low → omit).
 *  - Gate can be injected for tests via `input.gate` or the second arg.
 *
 * The new `score()` signature adds an optional second argument `{ gate }`
 * so tests can inject a mock gate without touching state-machine.ts.
 * `state-machine.ts` calls `KnowledgeRiskScorer.score(input)` (no second
 * arg) and gets `haikuRiskGate` as default.
 */

import { scoreKnowledge } from './knowledge-risk-scorer.js';
import type { LLMGate } from '@/shared/risk/types.js';
import type {
  KnowledgeKind,
  KnowledgeOrigin,
  KnowledgeRiskLevel,
  KnowledgeScope,
  KnowledgeSensitivity,
} from './types.js';
import type { TopicSignal } from '@/shared/risk/types.js';

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
  /** Optional gate injection for tests (avoids real Haiku calls). */
  gate?: LLMGate;
  /** @internal Test-only: force knowledge_type to an arbitrary string. */
  _test_force_knowledge_type?: string;
}

export interface KnowledgeRiskScoreOutput {
  level: KnowledgeRiskLevel;
  sensitivity: KnowledgeSensitivity;
  reasons: string[];
  source: 'p9c:knowledge' | 'heuristic' | 'llm_elevated' | 'cache';
}

// ---------------------------------------------------------------------------
// Adapter: KnowledgeKind → knowledge_type
// ---------------------------------------------------------------------------

const KIND_TO_KNOWLEDGE_TYPE: Record<
  KnowledgeKind,
  'fato' | 'regra' | 'procedimento' | 'lacuna' | 'tool_request'
> = {
  fact: 'fato',
  rule: 'regra',
  memory: 'fato',           // memory is a scoped fact
  behavioral_hint: 'lacuna', // behavioral hints are observed gaps / tendencies
  procedure_hint: 'procedimento',
};

// ---------------------------------------------------------------------------
// Adapter: sensitivity_hint → topic proxy
// ---------------------------------------------------------------------------

function sensitivityToTopic(
  s: KnowledgeSensitivity | undefined,
): TopicSignal | undefined {
  if (s === 'high') return 'critical_decision';
  if (s === 'medium') return 'financial';
  return undefined;
}

// ---------------------------------------------------------------------------
// Real scorer class (same static API as the stub)
// ---------------------------------------------------------------------------

export class KnowledgeRiskScorer {
  static async score(
    input: KnowledgeRiskScoreInput,
    opts?: { gate?: LLMGate },
  ): Promise<KnowledgeRiskScoreOutput> {
    const gate = opts?.gate ?? input.gate;

    // Derive knowledge_type (allow test override for coercion path validation)
    const knowledge_type = (
      input._test_force_knowledge_type ??
      KIND_TO_KNOWLEDGE_TYPE[input.kind]
    ) as 'fato' | 'regra' | 'procedimento' | 'lacuna' | 'tool_request';

    // Boost derived_confidence for human-provided origins
    const isHumanProvided =
      input.origin === 'user_explicit' || input.origin === 'human_approved';
    const derived_confidence = isHumanProvided
      ? Math.max(input.confidence, 0.8)
      : input.confidence;

    const scored = await scoreKnowledge(
      {
        knowledge_type,
        topic: sensitivityToTopic(input.proposer_sensitivity_hint),
        derived_confidence,
        // evidence_count: not available in the KSM input shape; omit (scorer
        // treats undefined as 0, which makes regra/procedimento ambiguous —
        // conservative default, matches stub behaviour of routing rule→pending).
      },
      { gate, contextText: input.content_text.slice(0, 200) },
    );

    // Map ScoredRisk → KnowledgeRiskScoreOutput
    const level = scored.level as KnowledgeRiskLevel;
    const sensitivity: KnowledgeSensitivity =
      level === 'critical' || level === 'high'
        ? 'high'
        : level === 'medium'
          ? 'medium'
          : 'low';

    const reasons = [
      ...scored.triggers.map((t) => t.signal),
      ...(scored.llm_reason ? [`llm:${scored.llm_reason}`] : []),
    ];

    const source: KnowledgeRiskScoreOutput['source'] =
      scored.decided_by === 'llm_upgrade' ? 'llm_elevated' : 'p9c:knowledge';

    return { level, sensitivity, reasons, source };
  }
}
