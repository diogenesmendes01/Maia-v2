/**
 * Tests for RiskScorerProdAdapter (Camada 3, stub #1/4).
 *
 * Verifies that the adapter correctly:
 *  - Maps {intent, base} → TurnRiskSignals (including intent.label → TopicSignal)
 *  - Calls P9c scoreTurn internally
 *  - Maps ScoredRisk (4 levels: low/medium/high/critical) back to the
 *    DE RiskScorer interface (3 levels: low/medium/high + requires_human_review)
 *  - CRITICAL caps to 'high' with requires_human_review=true + 'critical_capped' reason
 *  - Gate failure → escalated MEDIUM (no exposure of internal trigger name required)
 *  - Invalid intent.label → coerced to 'unknown' topic → at least medium with ambiguous
 *
 * Depends on PR #154 — RiskScorerProdAdapter lives in prod-env.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BaseContextPacket } from '@/runtime/context-packet/types.js';

// ---------------------------------------------------------------------------
// Hoisted mocks — scoreTurn must be mocked BEFORE the module is imported.
// ---------------------------------------------------------------------------

const { scoreTurnMock } = vi.hoisted(() => ({
  scoreTurnMock: vi.fn(),
}));

vi.mock('@/runtime/decision/turn-risk-scorer.js', () => ({
  scoreTurn: scoreTurnMock,
}));

// We also need to mock all the prod adapters' heavy deps so prod-env.ts
// doesn't fail at import time in the unit test environment.
vi.mock('@/control-plane/policy/policy-descriptor-resolver.js', () => ({
  policyDescriptorResolver: { resolveDescriptors: vi.fn() },
}));
vi.mock('@/control-plane/policy/policy-rules-repo.js', () => ({
  policyRulesRepo: { getById: vi.fn() },
}));
vi.mock('@/governance/policy-dsl/evaluator.js', () => ({
  evaluate: vi.fn(),
}));
vi.mock('@/control-plane/skill-registry/skills-repo.js', () => ({
  skillsRepo: { listByCategory: vi.fn(), getById: vi.fn() },
}));
vi.mock('@/db/repositories.js', () => ({
  procedureExecutionsRepo: { findById: vi.fn() },
  mensagensRepo: { findById: vi.fn() },
}));
vi.mock('@/db/tenant-context.js', () => ({
  getCurrentAgent: vi.fn().mockReturnValue('agent-test-1'),
}));
vi.mock('@/lib/metrics.js', () => ({
  incCounter: vi.fn(),
  observeHistogram: vi.fn(),
}));
vi.mock('@/lib/claude.js', () => ({
  callLLM: vi.fn(),
}));

// Import AFTER mocks are set up.
import { RiskScorerProdAdapter } from '@/runtime/decision/prod-env.js';
import { RiskLevel } from '@/types/enums.js';
import type { ScoredRisk } from '@/shared/risk/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkBase(overrides?: Partial<BaseContextPacket>): BaseContextPacket {
  return {
    trace_id: 'trace-1',
    tenant_id: 'tenant-1',
    agent_id: 'agent-1',
    session_id: 'session-1',
    conversation_id: 'conv-1',
    channel: { id: 'ch-1', kind: 'whatsapp', is_locked_down: false },
    actor: {
      user_id: 'u1',
      pessoa_id: 'p1',
      role: 'user',
      is_authenticated: true,
    },
    input: {
      kind: 'text',
      content_ref: 'cref-1',
      content_hmac: 'hmac-1',
      received_at: new Date().toISOString(),
    },
    active_procedure_execution_id: null,
    feature_flags_snapshot: {},
    entered_at_ms: Date.now(),
    active_sensitive_memory_count: 0,
    ...overrides,
  };
}

function mkScoredRisk(level: string, extra?: Partial<ScoredRisk>): ScoredRisk {
  return {
    level: level as ScoredRisk['level'],
    confidence: 0.8,
    llm_consulted: false,
    llm_attempted_downgrade: false,
    triggers: [],
    decided_by: 'heuristic',
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RiskScorerProdAdapter (Camada 3, stub #1/4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * T1: Financial/transfer intent + a tool signal that makes P9c emit CRITICAL.
   * The adapter must cap CRITICAL → 'high' and add 'critical_capped' to reasons.
   */
  it('T1: CRITICAL ScoredRisk → level=high, requires_human_review=true, reasons contain critical indicator', async () => {
    // Arrange: P9c emits CRITICAL (e.g. financial + transfer tool composite).
    scoreTurnMock.mockResolvedValue(
      mkScoredRisk(RiskLevel.CRITICAL, {
        triggers: [
          { signal: 'topic:financial', contributes_to: RiskLevel.HIGH, weight: 1 },
          { signal: 'tool:transfer', contributes_to: RiskLevel.HIGH, weight: 1 },
          {
            signal: 'composite:critical_decision+sensitive_tool',
            contributes_to: RiskLevel.CRITICAL,
            weight: 1,
          },
        ],
      }),
    );

    const adapter = new RiskScorerProdAdapter();
    const result = await adapter.score({
      intent: { label: 'transferencia', confidence: 0.9 },
      base: mkBase(),
    });

    // Assert: CRITICAL is capped to 'high' at the interface boundary.
    expect(result.level).toBe('high');
    expect(result.requires_human_review).toBe(true);
    // Must mention the cap in reasons so callers can audit the CRITICAL signal.
    const hasIndicator =
      result.reasons.some((r) => r.includes('critical_capped') || r.includes('critical'));
    expect(hasIndicator).toBe(true);
  });

  /**
   * T2: Low-risk social intent + no sensitive signals → adapter returns low.
   */
  it('T2: LOW ScoredRisk for social intent → level=low, requires_human_review=false', async () => {
    // Arrange: P9c returns LOW for a casual conversation intent.
    scoreTurnMock.mockResolvedValue(mkScoredRisk(RiskLevel.LOW));

    const adapter = new RiskScorerProdAdapter();
    const result = await adapter.score({
      intent: { label: 'chat', confidence: 0.9 },
      base: mkBase(),
    });

    expect(result.level).toBe('low');
    expect(result.requires_human_review).toBe(false);
  });

  /**
   * T3: Gate throws (mock) → adapter returns at least MEDIUM.
   * The internal reason 'gate:fallback_ambiguous' is an internal trigger; callers
   * only need to see that level >= medium. We do NOT assert the exact internal
   * trigger name in the public reasons array.
   */
  it('T3: gate failure → level is at least medium', async () => {
    // Arrange: scoreTurn (which wraps the gate) returns MEDIUM after gate error.
    // This simulates what scorer.ts does internally when gate throws and
    // heuristic was ambiguous LOW → escalated to MEDIUM.
    scoreTurnMock.mockResolvedValue(
      mkScoredRisk(RiskLevel.MEDIUM, {
        llm_consulted: true,
        triggers: [
          {
            signal: 'gate:fallback_ambiguous',
            contributes_to: RiskLevel.MEDIUM,
            weight: 1,
          },
        ],
        decided_by: 'heuristic',
      }),
    );

    const adapter = new RiskScorerProdAdapter();
    const result = await adapter.score({
      intent: { label: 'transferencia', confidence: 0.7 },
      base: mkBase(),
    });

    // The interface level must be 'medium' or 'high' (>= medium).
    const levelRank = { low: 0, medium: 1, high: 2 } as Record<string, number>;
    expect(levelRank[result.level] ?? -1).toBeGreaterThanOrEqual(levelRank['medium']);
  });

  /**
   * T4: Invalid intent.label → coerced to 'unknown' topic → heuristic marks
   * ambiguous=true. P9c then escalates to at least MEDIUM (or CRITICAL if
   * other signals fire). The adapter must return level >= medium.
   */
  it('T4: invalid intent.label → coerced to unknown → level at least medium', async () => {
    // Arrange: when topic='unknown', heuristic sets ambiguous=true.
    // P9c gate runs and (in absence of gate impl in test) escalates ambiguous
    // LOW → MEDIUM. We mock scoreTurn returning MEDIUM with ambiguous trigger.
    scoreTurnMock.mockResolvedValue(
      mkScoredRisk(RiskLevel.MEDIUM, {
        llm_consulted: true,
        triggers: [
          {
            signal: 'gate:fallback_ambiguous',
            contributes_to: RiskLevel.MEDIUM,
            weight: 1,
          },
        ],
      }),
    );

    const adapter = new RiskScorerProdAdapter();
    const result = await adapter.score({
      // This label is not in any known mapping → should coerce to 'unknown'.
      intent: { label: 'xyz_completely_unknown_label_9999', confidence: 0.5 },
      base: mkBase(),
    });

    // Level must be at least medium (unknown → ambiguous → gate escalation).
    const levelRank = { low: 0, medium: 1, high: 2 } as Record<string, number>;
    expect(levelRank[result.level] ?? -1).toBeGreaterThanOrEqual(levelRank['medium']);

    // Verify scoreTurn was called with topic='unknown' (coerced).
    expect(scoreTurnMock).toHaveBeenCalledOnce();
    const signalsArg = scoreTurnMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(signalsArg?.topic).toBe('unknown');
  });

  /**
   * T5: active_sensitive_memory_count in BaseContextPacket → adapter passes the
   * count to TurnRiskSignals so P9c heuristic can derive the sensitive-memory
   * risk floor. Verified by inspecting what scoreTurn receives.
   */
  it('T5: active_sensitive_memory_count=5 → scoreTurn receives active_sensitive_memory_count=5', async () => {
    // Arrange: P9c returns MEDIUM (the count may push it there).
    scoreTurnMock.mockResolvedValue(
      mkScoredRisk(RiskLevel.MEDIUM, {
        triggers: [
          {
            signal: 'sensitive_memory_count',
            contributes_to: RiskLevel.MEDIUM,
            weight: 1,
          },
        ],
      }),
    );

    const adapter = new RiskScorerProdAdapter();
    await adapter.score({
      intent: { label: 'chat', confidence: 0.9 },
      base: mkBase({ active_sensitive_memory_count: 5 }),
    });

    // The adapter must pass active_sensitive_memory_count through to TurnRiskSignals.
    expect(scoreTurnMock).toHaveBeenCalledOnce();
    const signals = scoreTurnMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(signals?.active_sensitive_memory_count).toBe(5);
  });
});
