/**
 * P9c — Heuristic risk scorer (Stage 1) tests.
 *
 * Cenários (fluxo §10.11 do spec):
 *  1. Conversa casual + nenhum sinal sensível → low + ambiguous=false (não dispara LLM).
 *  2. Tópico financial + write_external → medium ou +.
 *  3. Tool irreversível → high ou +.
 *  4. Tópico critical_decision + irreversible → critical.
 *  5. risk_override do owner trava (acima ou abaixo).
 *  6. skill_confidence < threshold → bump de risco.
 *  7. ambiguous=true para low + sinais fracos / medium + sem trigger forte.
 *  8. triggers retorna trace auditável (signal + weight).
 */
import { describe, it, expect } from 'vitest';
import { RiskLevel } from '@/types/enums.js';
import { scoreTurnHeuristic, scoreKnowledgeHeuristic } from '@/shared/risk/heuristic.ts';
import type { TurnRiskSignals, KnowledgeRiskSignals } from '@/shared/risk/types.ts';

describe('scoreTurnHeuristic', () => {
  it('conversa casual sem sinais → low + ambiguous=false', () => {
    const sig: TurnRiskSignals = {
      topic: 'casual',
      tool_kinds: [],
    };
    const r = scoreTurnHeuristic(sig);
    expect(r.level).toBe(RiskLevel.LOW);
    expect(r.ambiguous).toBe(false);
    expect(r.triggers).toEqual([]);
  });

  it('tópico operacional simples + leitura local → low não-ambíguo', () => {
    const sig: TurnRiskSignals = {
      topic: 'operational_simple',
      tool_kinds: ['read_local'],
    };
    const r = scoreTurnHeuristic(sig);
    expect(r.level).toBe(RiskLevel.LOW);
    expect(r.ambiguous).toBe(false);
  });

  it('topic=unknown sem outros sinais → low mas ambiguous=true (LLM gate)', () => {
    const sig: TurnRiskSignals = { topic: 'unknown' };
    const r = scoreTurnHeuristic(sig);
    expect(r.level).toBe(RiskLevel.LOW);
    expect(r.ambiguous).toBe(true);
  });

  it('financial + write_external → medium', () => {
    const sig: TurnRiskSignals = {
      topic: 'financial',
      tool_kinds: ['write_external'],
    };
    const r = scoreTurnHeuristic(sig);
    expect(r.level).toBe(RiskLevel.MEDIUM);
    expect(r.triggers.some((t) => t.signal === 'topic:financial')).toBe(true);
    expect(r.triggers.some((t) => t.signal === 'tool:write_external')).toBe(true);
  });

  it('tool irreversível → high (mesmo sem outros sinais)', () => {
    const sig: TurnRiskSignals = {
      topic: 'operational_simple',
      tool_kinds: ['irreversible'],
    };
    const r = scoreTurnHeuristic(sig);
    expect(r.level).toBe(RiskLevel.HIGH);
  });

  it('critical_decision + irreversível → critical', () => {
    const sig: TurnRiskSignals = {
      topic: 'critical_decision',
      tool_kinds: ['irreversible'],
    };
    const r = scoreTurnHeuristic(sig);
    expect(r.level).toBe(RiskLevel.CRITICAL);
  });

  it('risk_override do owner ELEVA acima do heurístico', () => {
    const sig: TurnRiskSignals = {
      topic: 'casual',
      risk_override: RiskLevel.HIGH,
    };
    const r = scoreTurnHeuristic(sig);
    expect(r.level).toBe(RiskLevel.HIGH);
    expect(r.triggers.some((t) => t.signal === 'owner:override')).toBe(true);
  });

  it('risk_override do owner NÃO REBAIXA abaixo do heurístico (no-downgrade vale também para owner)', () => {
    // Owner pediu LOW, mas heurística diz HIGH (irreversível). Override
    // só ELEVA — para garantir que owner nunca abaixa um sinal forte por
    // engano / configuração incorreta.
    const sig: TurnRiskSignals = {
      topic: 'critical_decision',
      tool_kinds: ['irreversible'],
      risk_override: RiskLevel.LOW,
    };
    const r = scoreTurnHeuristic(sig);
    expect(r.level).toBe(RiskLevel.CRITICAL);
  });

  it('skill_confidence abaixo do threshold sobe risco', () => {
    const sig: TurnRiskSignals = {
      topic: 'operational_simple',
      skill_confidence: 0.3,
      skill_threshold: 0.7,
    };
    const r = scoreTurnHeuristic(sig);
    expect(r.level === RiskLevel.MEDIUM || r.level === RiskLevel.HIGH).toBe(true);
    expect(r.triggers.some((t) => t.signal === 'self_model:below_threshold')).toBe(true);
  });

  it('memória sensível ativa sobe risco a pelo menos medium', () => {
    const sig: TurnRiskSignals = {
      topic: 'casual',
      active_sensitive_memory_count: 1,
    };
    const r = scoreTurnHeuristic(sig);
    expect(r.level === RiskLevel.MEDIUM || r.level === RiskLevel.HIGH).toBe(true);
  });

  it('procedure com critical_step sobe a pelo menos high', () => {
    const sig: TurnRiskSignals = {
      topic: 'operational_simple',
      active_procedure_has_critical_step: true,
    };
    const r = scoreTurnHeuristic(sig);
    expect(r.level === RiskLevel.HIGH || r.level === RiskLevel.CRITICAL).toBe(true);
  });

  it('triggers carrega trace auditável (signal + weight + contributes_to)', () => {
    const sig: TurnRiskSignals = {
      topic: 'financial',
      tool_kinds: ['write_external'],
    };
    const r = scoreTurnHeuristic(sig);
    for (const t of r.triggers) {
      expect(typeof t.signal).toBe('string');
      expect(t.signal.length).toBeGreaterThan(0);
      expect(typeof t.weight).toBe('number');
      expect(t.weight).toBeGreaterThan(0);
      expect([RiskLevel.LOW, RiskLevel.MEDIUM, RiskLevel.HIGH, RiskLevel.CRITICAL])
        .toContain(t.contributes_to);
    }
  });

  it('confidence cresce com nº de sinais convergentes', () => {
    const minimal = scoreTurnHeuristic({ topic: 'financial' });
    const richer = scoreTurnHeuristic({
      topic: 'financial',
      tool_kinds: ['write_external'],
      active_sensitive_memory_count: 1,
    });
    expect(richer.confidence).toBeGreaterThan(minimal.confidence);
  });

  it('signals vazios (objeto vazio) não throw → baseline low/ambíguo', () => {
    const r = scoreTurnHeuristic({});
    expect(r.level).toBe(RiskLevel.LOW);
    expect(r.ambiguous).toBe(true);
  });
});

describe('scoreKnowledgeHeuristic', () => {
  it('fato simples sem sinais → low', () => {
    const sig: KnowledgeRiskSignals = {
      knowledge_type: 'fato',
      topic: 'casual',
      derived_confidence: 0.9,
      evidence_count: 3,
    };
    const r = scoreKnowledgeHeuristic(sig);
    expect(r.level).toBe(RiskLevel.LOW);
  });

  it('regra com pouca evidência (<2) → ambiguous=true', () => {
    const sig: KnowledgeRiskSignals = {
      knowledge_type: 'regra',
      derived_confidence: 0.6,
      evidence_count: 1,
    };
    const r = scoreKnowledgeHeuristic(sig);
    expect(r.ambiguous).toBe(true);
  });

  it('procedimento que toca em irreversível → high ou critical', () => {
    const sig: KnowledgeRiskSignals = {
      knowledge_type: 'procedimento',
      touches_irreversible: true,
      tool_kinds: ['irreversible'],
    };
    const r = scoreKnowledgeHeuristic(sig);
    expect(r.level === RiskLevel.HIGH || r.level === RiskLevel.CRITICAL).toBe(true);
  });

  it('confidence agregada baixa sobe risco a pelo menos medium', () => {
    const sig: KnowledgeRiskSignals = {
      knowledge_type: 'regra',
      derived_confidence: 0.2,
      evidence_count: 1,
    };
    const r = scoreKnowledgeHeuristic(sig);
    expect(r.level === RiskLevel.MEDIUM || r.level === RiskLevel.HIGH).toBe(true);
  });

  it('tool_request com write_external → medium ou +', () => {
    const sig: KnowledgeRiskSignals = {
      knowledge_type: 'tool_request',
      tool_kinds: ['write_external'],
    };
    const r = scoreKnowledgeHeuristic(sig);
    expect(r.level === RiskLevel.MEDIUM || r.level === RiskLevel.HIGH).toBe(true);
  });

  it('lacuna no domínio crítico → ambígua para revisão LLM', () => {
    const sig: KnowledgeRiskSignals = {
      knowledge_type: 'lacuna',
      topic: 'critical_decision',
    };
    const r = scoreKnowledgeHeuristic(sig);
    expect(r.ambiguous).toBe(true);
    expect(r.level === RiskLevel.MEDIUM || r.level === RiskLevel.HIGH).toBe(true);
  });

  it('risk_override do owner ELEVA mas não REBAIXA', () => {
    const sigUp: KnowledgeRiskSignals = {
      knowledge_type: 'fato',
      topic: 'casual',
      risk_override: RiskLevel.HIGH,
    };
    expect(scoreKnowledgeHeuristic(sigUp).level).toBe(RiskLevel.HIGH);

    const sigDown: KnowledgeRiskSignals = {
      knowledge_type: 'procedimento',
      touches_irreversible: true,
      risk_override: RiskLevel.LOW,
    };
    const r = scoreKnowledgeHeuristic(sigDown);
    expect(r.level === RiskLevel.HIGH || r.level === RiskLevel.CRITICAL).toBe(true);
  });
});
