/**
 * Issue #433 — `classifyTurnRisk` shared adapter (src/shared/risk/turn-risk-adapter).
 *
 * This is the helper the baseline `risk_signal_classify` tool wraps AND that the
 * sibling #431 `case_risk_classify` will compose — so its contract is tested
 * directly here (signal extraction + scorer delegation + output mapping), not
 * only through the tool. We inject a deterministic gate to avoid Anthropic.
 */
import { describe, it, expect, vi } from 'vitest';
import { RiskLevel } from '@/types/enums.js';
import type { LLMGate } from '@/shared/risk/types.js';
import {
  classifyTurnRisk,
  extractTurnRiskSignals,
  inferTopicFromText,
  inferToolKindsFromText,
  recommendedActionForLevel,
} from '@/shared/risk/turn-risk-adapter.js';

vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const elevatingGate: LLMGate = async () => ({
  suggested_level: RiskLevel.HIGH,
  reason: 'mock elevation',
});
const downgradingGate: LLMGate = async () => ({
  suggested_level: RiskLevel.LOW,
  reason: 'mock downgrade',
});
const nullGate: LLMGate = async () => null;

describe('recommendedActionForLevel — net-new deterministic mapping', () => {
  it('maps each level to its action', () => {
    expect(recommendedActionForLevel(RiskLevel.LOW)).toBe('allow');
    expect(recommendedActionForLevel(RiskLevel.MEDIUM)).toBe('clarify');
    expect(recommendedActionForLevel(RiskLevel.HIGH)).toBe('confirm');
    expect(recommendedActionForLevel(RiskLevel.CRITICAL)).toBe('handoff');
  });
});

describe('inferTopicFromText — keyword extraction (domain-neutral)', () => {
  it('classifies financial / legal / health / critical_decision / casual', () => {
    expect(inferTopicFromText('preciso fazer um pagamento via pix')).toBe('financial');
    expect(inferTopicFromText('vou processar judicialmente o contrato')).toBe('legal');
    expect(inferTopicFromText('estou com um problema de saúde, fui ao médico')).toBe('health');
    expect(inferTopicFromText('quero demitir o funcionário hoje')).toBe('critical_decision');
    expect(inferTopicFromText('olá, bom dia!')).toBe('casual');
  });

  it('prefers the MORE conservative bucket when signals mix', () => {
    // "demitir" (critical_decision) + "pagamento" (financial) → critical_decision wins.
    expect(inferTopicFromText('vou demitir e fazer o pagamento da rescisão')).toBe(
      'critical_decision',
    );
  });

  it('unmatched text → unknown (ambiguous; gate will be consulted)', () => {
    expect(inferTopicFromText('xyzzy plugh')).toBe('unknown');
  });
});

describe('inferToolKindsFromText', () => {
  it('infers transfer for financial phrasing and irreversible for destructive phrasing', () => {
    expect(inferToolKindsFromText('transferir 100 reais', 'financial')).toContain('transfer');
    expect(inferToolKindsFromText('apagar tudo permanentemente', 'critical_decision')).toContain(
      'irreversible',
    );
  });
});

describe('extractTurnRiskSignals', () => {
  it('structured topic WINS over text inference; tool_kinds are the union', () => {
    const sig = extractTurnRiskSignals({
      text: 'pagamento pix',
      topic: 'casual', // explicit override
      tool_kinds: ['read_local'],
    });
    expect(sig.topic).toBe('casual');
    // explicit read_local + (no inferred kinds because topic is casual now) →
    // but inference runs on the FINAL topic; casual yields no transfer.
    expect(sig.tool_kinds).toContain('read_local');
  });

  it('derives topic + tool_kinds from text when no structured signal is given', () => {
    const sig = extractTurnRiskSignals({ text: 'quero transferir via pix' });
    expect(sig.topic).toBe('financial');
    expect(sig.tool_kinds).toContain('transfer');
  });

  it('carries through the self-model / memory / procedure signals verbatim', () => {
    const sig = extractTurnRiskSignals({
      skill_confidence: 0.2,
      skill_threshold: 0.8,
      active_sensitive_memory_count: 3,
      active_procedure_has_critical_step: true,
      risk_override: RiskLevel.HIGH,
    });
    expect(sig.skill_confidence).toBe(0.2);
    expect(sig.skill_threshold).toBe(0.8);
    expect(sig.active_sensitive_memory_count).toBe(3);
    expect(sig.active_procedure_has_critical_step).toBe(true);
    expect(sig.risk_override).toBe(RiskLevel.HIGH);
  });
});

describe('classifyTurnRisk — scorer delegation + output mapping', () => {
  it('maps decided_by=llm_upgrade → source when the gate elevates an ambiguous turn', async () => {
    const r = await classifyTurnRisk({ topic: 'unknown', gate: elevatingGate });
    expect(r.risk).toBe(RiskLevel.HIGH);
    expect(r.source).toBe('llm_upgrade');
    expect(r.recommended_action).toBe('confirm');
  });

  it('NEVER downgrades below the heuristic floor (adversarial gate ignored)', async () => {
    const r = await classifyTurnRisk({ topic: 'financial', gate: downgradingGate });
    expect(r.risk).toBe(RiskLevel.MEDIUM); // gate's LOW ignored
    expect(r.source).toBe('heuristic');
    expect(r.recommended_action).toBe('clarify');
  });

  it('low/casual non-ambiguous → allow, gate never consulted', async () => {
    const gate = vi.fn(nullGate);
    const r = await classifyTurnRisk({ topic: 'casual', tool_kinds: [], gate });
    expect(r.risk).toBe(RiskLevel.LOW);
    expect(r.recommended_action).toBe('allow');
    expect(gate).not.toHaveBeenCalled();
  });

  it('reasons are the deterministic trigger signal strings', async () => {
    const r = await classifyTurnRisk({ topic: 'financial', gate: nullGate });
    // financial topic contributes a `topic:financial` trigger.
    expect(r.reasons).toContain('topic:financial');
    // triggers carry the structured RiskTrigger detail.
    expect(r.triggers.some((t) => t.signal === 'topic:financial')).toBe(true);
  });

  it('a critical composite (critical_decision + irreversible) → handoff', async () => {
    const r = await classifyTurnRisk({
      text: 'quero apagar tudo e encerrar a empresa de forma irreversível',
      gate: nullGate,
    });
    expect(r.risk).toBe(RiskLevel.CRITICAL);
    expect(r.recommended_action).toBe('handoff');
  });
});
