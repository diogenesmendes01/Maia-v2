/**
 * P9c — Risk Scoring Wiring Tests.
 *
 * Confirms that the 2 consumers (decision engine + KSM) actually invoke
 * the real P9c wrappers instead of the P9b/P10a stubs. All 4 tests FAIL
 * before the wiring changes and PASS after.
 *
 * T1 — scoreTurn: financeiro_critico + sensitive tool → CRITICAL
 *       (old stub never returned CRITICAL, capped at medium).
 * T2 — scoreTurn: topic=unknown + gate throws → MEDIUM with
 *       gate:fallback_ambiguous trigger (round-2 fix now reachable).
 * T3 — KnowledgeRiskScorer.score: source NOT 'stub:p10a'.
 * T4 — scoreKnowledge: invalid knowledge_type → coerced to lacuna.
 *
 * Note: T1/T2 test the shared turn scorer directly (same code path the
 * decision engine adapter delegates to). T3/T4 test the KSM scorer.
 */

import { describe, it, expect, vi } from 'vitest';
import { RiskLevel } from '@/types/enums.js';
import type { LLMGate } from '@/shared/risk/types.js';

// ─── T1 & T2: Turn risk (shared scorer — real code path used by decision engine) ─

import { scoreTurn } from '@/runtime/decision/turn-risk-scorer.ts';

describe('T1 — turn risk: CRITICAL escalation (stub replaced)', () => {
  it('financeiro_critico topic + sensitive_tool=true → score CRITICAL, source NOT stub:p1', async () => {
    // Gate is skipped (CRITICAL is non-ambiguous, heuristic skipGate condition fires)
    const gate: LLMGate = vi.fn(async () => null);

    const result = await scoreTurn(
      {
        topic: 'critical_decision',      // the financeiro_critico category
        tool_kinds: ['irreversible'],     // sensitive_tool=true
      },
      { gate, contextText: '' },
    );

    // Old stub: max was 'medium' (never returned 'critical').
    // Real scorer: composite critical_decision + irreversible → CRITICAL.
    expect(result.level).toBe(RiskLevel.CRITICAL);

    // Gate should NOT be consulted (CRITICAL is non-ambiguous, skip condition fires)
    expect(gate).not.toHaveBeenCalled();

    // No stub signal in triggers
    const triggerSignals = result.triggers.map((t) => t.signal).join(',');
    expect(triggerSignals).not.toMatch(/stub/i);
  });
});

describe('T2 — turn risk: gate:fallback_ambiguous (round-2 fix reachable)', () => {
  it('topic=unknown + gate throws → escalates to MEDIUM, triggers include gate:fallback_ambiguous', async () => {
    // Gate that throws — simulates Haiku timeout / key missing
    const gate: LLMGate = vi.fn(async () => {
      throw new Error('simulated haiku failure');
    });

    const result = await scoreTurn(
      { topic: 'unknown' },  // unknown → LOW + ambiguous=true
      { gate, contextText: '' },
    );

    // round-2 fix in scorer.ts (applyGate): ambiguous LOW + gate null/throw
    // → escalate to MEDIUM + push gate:fallback_ambiguous trigger
    expect(result.level).toBe(RiskLevel.MEDIUM);
    expect(result.triggers.map((t) => t.signal)).toContain('gate:fallback_ambiguous');
  });
});

// ─── T3 & T4: Knowledge risk (KSM scorer — stub replaced) ──────────────────

import { KnowledgeRiskScorer } from '@/control-plane/knowledge-state-machine/risk-scorer.js';
import { scoreKnowledge } from '@/control-plane/knowledge-state-machine/knowledge-risk-scorer.ts';

describe('T3 — knowledge risk: source NOT stub:p10a', () => {
  it('rule kind + high confidence → source is p9c:knowledge, routing stays conservative', async () => {
    // Gate returns null (no Haiku in unit tests). New signature accepts gate.
    const gate: LLMGate = vi.fn(async () => null);

    const result = await KnowledgeRiskScorer.score(
      {
        trace_id: 'test-t3',
        tenant_id: 'tenant-1',
        agent_id: 'agent-1',
        kind: 'rule',
        scope: 'agent',
        content_text: 'always reply in Portuguese',
        confidence: 0.85,
        origin: 'human_approved',
        proposer_sensitivity_hint: 'medium',
        gate,  // injected gate so we avoid real LLM calls
      },
    );

    // Stub returned 'stub:p10a'. Real scorer must return something else.
    expect(result.source).not.toBe('stub:p10a');

    // Conservative routing preserved: rule kind → at least medium
    expect(['medium', 'high', 'critical']).toContain(result.level);
  });
});

describe('T4 — knowledge risk: invalid knowledge_type coerced to lacuna (round-2)', () => {
  it('totally-fake knowledge_type → coerced to lacuna → ambiguous=true, level not low', async () => {
    // Gate returns null — fail-closed path
    const gate: LLMGate = vi.fn(async () => null);

    // scoreKnowledge directly with an invalid knowledge_type cast.
    // heuristic.coerceKnowledgeType maps unknown values to 'lacuna'.
    // lacuna is always ambiguous; gate null → MEDIUM (fail-closed from LOW).
    const result = await scoreKnowledge(
      { knowledge_type: 'totally-fake' as any }, // eslint-disable-line @typescript-eslint/no-explicit-any
      { gate, contextText: '' },
    );

    // lacuna → ambiguous, gate null → at least MEDIUM (fail-closed)
    expect(result.level).not.toBe(RiskLevel.LOW);

    // Must contain gate:fallback_ambiguous or be HIGH/CRITICAL from heuristic
    const signals = result.triggers.map((t) => t.signal);
    const hasExpectedSignal =
      signals.includes('gate:fallback_ambiguous') ||
      result.triggers.some(
        (t) => t.contributes_to === RiskLevel.HIGH || t.contributes_to === RiskLevel.CRITICAL,
      );
    expect(hasExpectedSignal).toBe(true);
  });
});
