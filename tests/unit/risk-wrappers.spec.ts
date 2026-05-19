/**
 * P9c — Wrappers (TurnRiskScorer + KnowledgeRiskScorer) — testes
 * de smoke + verificação de que delegam corretamente para o shared
 * scorer e que o gate é injetável.
 *
 * Ambos os wrappers são intencionalmente "dumb" — heuristic +
 * no-downgrade já são exaustivamente testados em risk-scorer.spec.ts;
 * aqui só checamos contrato de wrapper.
 */
import { describe, it, expect, vi } from 'vitest';
import { scoreTurn } from '@/runtime/decision/turn-risk-scorer.ts';
import { scoreKnowledge } from '@/control-plane/knowledge-state-machine/knowledge-risk-scorer.ts';
import { RiskLevel } from '@/types/enums.js';
import type { LLMGate } from '@/shared/risk/types.js';

describe('TurnRiskScorer (wrapper)', () => {
  it('chama o gate injetado quando heurística é ambígua', async () => {
    const gate: LLMGate = vi.fn(async () => ({
      suggested_level: RiskLevel.HIGH,
      reason: 'mock',
    }));
    const r = await scoreTurn({ topic: 'unknown' }, { gate, contextText: 'x' });
    expect(gate).toHaveBeenCalledTimes(1);
    expect(r.level).toBe(RiskLevel.HIGH);
    expect(r.decided_by).toBe('llm_upgrade');
  });

  it('PULA gate quando heurística não-ambígua (low casual)', async () => {
    const gate = vi.fn();
    const r = await scoreTurn(
      { topic: 'casual', tool_kinds: [] },
      { gate: gate as unknown as LLMGate, contextText: '' },
    );
    expect(r.level).toBe(RiskLevel.LOW);
    expect(gate).not.toHaveBeenCalled();
  });

  it('preserva no-downgrade no wrapper (mesmo gate adversarial)', async () => {
    const gate: LLMGate = async () => ({
      suggested_level: RiskLevel.LOW,
      reason: 'tentando rebaixar',
    });
    const r = await scoreTurn(
      // financial = MEDIUM heuristic e ambíguo
      { topic: 'financial' },
      { gate, contextText: 'x' },
    );
    expect(r.level).toBe(RiskLevel.MEDIUM);
    expect(r.llm_attempted_downgrade).toBe(true);
  });
});

describe('KnowledgeRiskScorer (wrapper)', () => {
  it('chama o gate injetado para regra com pouca evidência', async () => {
    const gate: LLMGate = vi.fn(async () => ({
      suggested_level: RiskLevel.MEDIUM,
      reason: 'x',
    }));
    await scoreKnowledge(
      { knowledge_type: 'regra', evidence_count: 1, derived_confidence: 0.6 },
      { gate, contextText: 'x' },
    );
    expect(gate).toHaveBeenCalledTimes(1);
  });

  it('PULA gate para procedimento high (touches_irreversible)', async () => {
    const gate = vi.fn();
    const r = await scoreKnowledge(
      {
        knowledge_type: 'procedimento',
        touches_irreversible: true,
        evidence_count: 5,
      },
      { gate: gate as unknown as LLMGate },
    );
    expect(gate).not.toHaveBeenCalled();
    expect(r.level === RiskLevel.HIGH || r.level === RiskLevel.CRITICAL).toBe(true);
  });
});
