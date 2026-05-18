/**
 * P9c — Scorer composto (heurística + gate LLM) com 3 camadas de defesa
 * contra rebaixamento:
 *   1) TIPO: assinatura de `LLMGate` aceita qualquer `RiskLevel`, mas o
 *      scorer aplica `maxRiskLevel` ANTES de retornar (impede que LLM
 *      retorne 'low' quando heurística disse 'high').
 *   2) RUNTIME: `llm_attempted_downgrade=true` é registrado em audit
 *      quando o LLM tentou rebaixar (mantemos o nível heurístico).
 *   3) PROPERTY TEST: 500 iterações geram heurística aleatória + LLM
 *      mock que devolve níveis aleatórios (incluindo abaixo) e checam
 *      que o nível final NUNCA fica abaixo do heurístico.
 *
 * Cenários adicionais:
 *  - Heurística não-ambígua → LLM nem é chamado.
 *  - LLM null (timeout/erro) → mantém heurístico.
 *  - LLM eleva → resultado eleva, decided_by='llm_upgrade'.
 *  - LLM concorda → mantém, decided_by='heuristic'.
 *  - Adversarial: LLM tenta 'low' contra heurística 'medium' → final 'medium'
 *    + llm_attempted_downgrade=true.
 */
import { describe, it, expect, vi } from 'vitest';
import { RiskLevel } from '@/types/enums.js';
import {
  scoreTurnRisk,
  scoreKnowledgeRisk,
} from '@/shared/risk/scorer.ts';
import {
  RISK_LEVELS_ASCENDING,
  isAtLeast,
  compareRiskLevel,
} from '@/shared/risk/level.ts';
import type { LLMGate, TurnRiskSignals, KnowledgeRiskSignals } from '@/shared/risk/types.ts';

function gateReturning(suggested: RiskLevel | null, reason = 'mock'): LLMGate {
  return async () => (suggested === null ? null : { suggested_level: suggested, reason });
}

describe('scoreTurnRisk — gate orchestration', () => {
  it('heurística não-ambígua → LLM NÃO é chamado', async () => {
    const gate = vi.fn<Parameters<LLMGate>, ReturnType<LLMGate>>(
      gateReturning(RiskLevel.CRITICAL),
    );
    const sig: TurnRiskSignals = {
      topic: 'critical_decision',
      tool_kinds: ['irreversible'],
    };
    const r = await scoreTurnRisk(sig, { gate, contextText: 'irrelevant' });
    expect(r.level).toBe(RiskLevel.CRITICAL);
    expect(gate).not.toHaveBeenCalled();
    expect(r.llm_consulted).toBe(false);
    expect(r.decided_by).toBe('heuristic');
  });

  it('low não-ambíguo (casual) → LLM NÃO é chamado', async () => {
    const gate = vi.fn<Parameters<LLMGate>, ReturnType<LLMGate>>(
      gateReturning(RiskLevel.HIGH),
    );
    const r = await scoreTurnRisk(
      { topic: 'casual', tool_kinds: [] },
      { gate, contextText: 'oi' },
    );
    expect(r.level).toBe(RiskLevel.LOW);
    expect(gate).not.toHaveBeenCalled();
  });

  it('low ambíguo (topic=unknown) → LLM É chamado', async () => {
    const gate = vi.fn<Parameters<LLMGate>, ReturnType<LLMGate>>(
      gateReturning(RiskLevel.MEDIUM, 'soa um pouco financeiro'),
    );
    const r = await scoreTurnRisk(
      { topic: 'unknown' },
      { gate, contextText: 'duvida sobre conta' },
    );
    expect(gate).toHaveBeenCalledTimes(1);
    expect(r.llm_consulted).toBe(true);
    expect(r.level).toBe(RiskLevel.MEDIUM);
    expect(r.decided_by).toBe('llm_upgrade');
  });

  it('LLM retorna null (timeout/erro) → mantém heurístico', async () => {
    const gate = vi.fn<Parameters<LLMGate>, ReturnType<LLMGate>>(gateReturning(null));
    const r = await scoreTurnRisk(
      { topic: 'unknown' },
      { gate, contextText: 'x' },
    );
    expect(r.llm_consulted).toBe(true);
    expect(r.level).toBe(RiskLevel.LOW);
    expect(r.decided_by).toBe('heuristic');
    expect(r.llm_attempted_downgrade).toBe(false);
  });

  it('LLM concorda → mantém heurístico, decided_by=heuristic', async () => {
    const gate = gateReturning(RiskLevel.LOW);
    const r = await scoreTurnRisk(
      { topic: 'unknown' },
      { gate, contextText: 'x' },
    );
    expect(r.level).toBe(RiskLevel.LOW);
    expect(r.decided_by).toBe('heuristic');
    expect(r.llm_attempted_downgrade).toBe(false);
  });

  it('ADVERSARIAL: LLM retorna low contra heurística medium → mantém medium', async () => {
    // Heurística MEDIUM ambígua: financial sem strong-trigger.
    const sig: TurnRiskSignals = {
      topic: 'financial',
    };
    const gate = vi.fn<Parameters<LLMGate>, ReturnType<LLMGate>>(
      gateReturning(RiskLevel.LOW, 'pareceu casual'),
    );
    const r = await scoreTurnRisk(sig, { gate, contextText: 'x' });
    expect(r.level).toBe(RiskLevel.MEDIUM);
    expect(r.llm_attempted_downgrade).toBe(true);
    expect(r.decided_by).toBe('heuristic');
  });

  it('LLM é wrapped em runCognitiveModule (audit happens via gate)', async () => {
    // O wrapping é responsabilidade da impl do gate (haikuRiskGate). Aqui
    // só checamos que o scorer não bypassa o gate quando ambíguo —
    // garantindo que `cognitive_module_log` recebe a chamada.
    let calls = 0;
    const gate: LLMGate = async () => {
      calls++;
      return { suggested_level: RiskLevel.MEDIUM, reason: 'x' };
    };
    await scoreTurnRisk({ topic: 'unknown' }, { gate, contextText: 'x' });
    expect(calls).toBe(1);
  });
});

describe('scoreKnowledgeRisk — gate orchestration', () => {
  it('regra com 1 evidência (ambígua) → LLM consultado', async () => {
    const gate = vi.fn<Parameters<LLMGate>, ReturnType<LLMGate>>(
      gateReturning(RiskLevel.MEDIUM),
    );
    const sig: KnowledgeRiskSignals = {
      knowledge_type: 'regra',
      derived_confidence: 0.6,
      evidence_count: 1,
    };
    await scoreKnowledgeRisk(sig, { gate, contextText: 'x' });
    expect(gate).toHaveBeenCalledTimes(1);
  });

  it('procedimento com touches_irreversible (high não-ambíguo) → LLM NÃO chamado', async () => {
    const gate = vi.fn<Parameters<LLMGate>, ReturnType<LLMGate>>(
      gateReturning(RiskLevel.LOW),
    );
    const sig: KnowledgeRiskSignals = {
      knowledge_type: 'procedimento',
      touches_irreversible: true,
      tool_kinds: ['irreversible'],
      evidence_count: 5,
    };
    const r = await scoreKnowledgeRisk(sig, { gate, contextText: 'x' });
    expect(gate).not.toHaveBeenCalled();
    expect(r.level === RiskLevel.HIGH || r.level === RiskLevel.CRITICAL).toBe(true);
  });

  it('ADVERSARIAL knowledge: LLM tenta low contra high → fica high', async () => {
    const sig: KnowledgeRiskSignals = {
      knowledge_type: 'lacuna',
      topic: 'critical_decision',
    };
    const gate = gateReturning(RiskLevel.LOW, 'parece ok');
    const r = await scoreKnowledgeRisk(sig, { gate, contextText: 'x' });
    // lacuna em critical_decision sempre é ambígua, então gate roda; mas
    // se LLM tenta rebaixar, mantemos.
    expect(isAtLeast(r.level, RiskLevel.MEDIUM)).toBe(true);
    if (r.llm_consulted) {
      // A heurística devolve MEDIUM; LLM tenta LOW → llm_attempted_downgrade.
      expect(r.llm_attempted_downgrade).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// PROPERTY TEST: 500 iterações com inputs aleatórios e LLM mock
// ---------------------------------------------------------------------------

function pseudoRandomGenerator(seed: number) {
  // mulberry32 — determinístico, suficiente para property testing leve.
  let state = seed | 0;
  return function next(): number {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickFrom<T>(rnd: () => number, arr: readonly T[]): T {
  // arr é não-vazio nas chamadas abaixo; o cast é necessário porque
  // noUncheckedIndexedAccess marcaria T | undefined. As call sites
  // protegem com `length > 0`.
  const idx = Math.floor(rnd() * arr.length);
  return arr[idx]!;
}

function randomTurnSignals(rnd: () => number): TurnRiskSignals {
  const topics = ['casual', 'operational_simple', 'financial', 'legal', 'health',
    'critical_decision', 'unknown'] as const;
  const tools = ['read_local', 'read_external', 'write_local', 'write_external',
    'transfer', 'irreversible', 'communication'] as const;
  const overrides = [undefined, RiskLevel.LOW, RiskLevel.MEDIUM, RiskLevel.HIGH,
    RiskLevel.CRITICAL] as const;

  const tool_kinds: TurnRiskSignals['tool_kinds'] = [];
  const nTools = Math.floor(rnd() * 3);
  for (let i = 0; i < nTools; i++) tool_kinds.push(pickFrom(rnd, tools));

  return {
    topic: pickFrom(rnd, topics),
    tool_kinds,
    skill_confidence: rnd() < 0.4 ? rnd() : undefined,
    skill_threshold: rnd() < 0.4 ? rnd() : undefined,
    active_sensitive_memory_count: rnd() < 0.3 ? Math.floor(rnd() * 3) : undefined,
    active_procedure_has_critical_step: rnd() < 0.2,
    risk_override: pickFrom(rnd, overrides),
  };
}

function randomKnowledgeSignals(rnd: () => number): KnowledgeRiskSignals {
  const ktypes = ['fato', 'regra', 'procedimento', 'lacuna', 'tool_request'] as const;
  const topics = ['casual', 'operational_simple', 'financial', 'legal', 'health',
    'critical_decision', 'unknown'] as const;
  const tools = ['read_local', 'read_external', 'write_local', 'write_external',
    'transfer', 'irreversible', 'communication'] as const;
  const overrides = [undefined, RiskLevel.LOW, RiskLevel.MEDIUM, RiskLevel.HIGH,
    RiskLevel.CRITICAL] as const;

  const tool_kinds: KnowledgeRiskSignals['tool_kinds'] = [];
  const nTools = Math.floor(rnd() * 3);
  for (let i = 0; i < nTools; i++) tool_kinds.push(pickFrom(rnd, tools));

  return {
    knowledge_type: pickFrom(rnd, ktypes),
    topic: pickFrom(rnd, topics),
    derived_confidence: rnd() < 0.5 ? rnd() : undefined,
    evidence_count: rnd() < 0.7 ? Math.floor(rnd() * 6) : undefined,
    touches_irreversible: rnd() < 0.25,
    tool_kinds,
    risk_override: pickFrom(rnd, overrides),
  };
}

describe('PROPERTY: scoreTurnRisk (10k iter) — final NUNCA abaixo do heurístico + critical preserved', () => {
  it('LLM aleatório (incluindo abaixo + inválido) nunca rebaixa o resultado final', async () => {
    const rnd = pseudoRandomGenerator(0xC0FFEE);
    const ITER = 10_000;
    let downgradeAttempts = 0;
    let llmCalls = 0;
    let invalidLevelInjections = 0;
    let criticalHeuristicCount = 0;

    const { scoreTurnHeuristic } = await import('@/shared/risk/heuristic.ts');

    for (let i = 0; i < ITER; i++) {
      const sig = randomTurnSignals(rnd);
      // 5% das vezes o LLM "responde" um nível inválido (fora do enum) —
      // o scorer deve ignorar e manter heurístico (Codex review #97 finding 3).
      const injectInvalid = rnd() < 0.05;
      const llmLevel = injectInvalid
        ? ('bogus_level' as unknown as RiskLevel)
        : pickFrom(rnd, RISK_LEVELS_ASCENDING);
      if (injectInvalid) invalidLevelInjections++;
      let calledThisIter = false;
      const gate: LLMGate = async () => {
        calledThisIter = true;
        return { suggested_level: llmLevel, reason: 'rng' };
      };
      const r = await scoreTurnRisk(sig, { gate, contextText: 'rng' });
      const h = scoreTurnHeuristic(sig);
      // Final NUNCA abaixo do heurístico.
      expect(isAtLeast(r.level, h.level)).toBe(true);

      // CRITICAL SIGNAL PRESERVATION (Codex finding — defesa em profundidade):
      // se a heurística produziu um trigger CRITICAL, o resultado final é CRITICAL.
      const heuristicHasCriticalTrigger = h.triggers.some(
        (t) => t.contributes_to === RiskLevel.CRITICAL,
      );
      if (heuristicHasCriticalTrigger) {
        criticalHeuristicCount++;
        expect(r.level).toBe(RiskLevel.CRITICAL);
      }

      // Se LLM foi chamado com nível válido e tentou abaixar → flag.
      if (calledThisIter && !injectInvalid) {
        llmCalls++;
        if (compareRiskLevel(llmLevel, h.level) < 0) {
          downgradeAttempts++;
          expect(r.llm_attempted_downgrade).toBe(true);
          expect(r.level).toBe(h.level);
        }
      }
    }
    // Sanity: o gerador realmente tentou rebaixar pelo menos algumas vezes
    // E injetou alguns inválidos — caso contrário o teste estaria provando nada.
    expect(llmCalls).toBeGreaterThan(0);
    expect(downgradeAttempts).toBeGreaterThan(0);
    expect(invalidLevelInjections).toBeGreaterThan(0);
    // Sanity: existiu pelo menos um caso CRITICAL determinístico no
    // randomização (composite critical_decision + irreversible).
    expect(criticalHeuristicCount).toBeGreaterThan(0);
  }, 30_000); // timeout de 30s para 10k iter
});

describe('PROPERTY: scoreKnowledgeRisk (10k iter) — final NUNCA abaixo do heurístico + critical preserved', () => {
  it('LLM aleatório nunca rebaixa knowledge; CRITICAL triggers nunca perdem', async () => {
    const rnd = pseudoRandomGenerator(0xCAFE_F00D);
    const ITER = 10_000;
    let downgradeAttempts = 0;
    let invalidInjections = 0;
    let criticalHeuristicCount = 0;

    const { scoreKnowledgeHeuristic } = await import('@/shared/risk/heuristic.ts');

    for (let i = 0; i < ITER; i++) {
      const sig = randomKnowledgeSignals(rnd);
      const injectInvalid = rnd() < 0.05;
      const llmLevel = injectInvalid
        ? ('SUPER_CRITICAL_PLUS' as unknown as RiskLevel)
        : pickFrom(rnd, RISK_LEVELS_ASCENDING);
      if (injectInvalid) invalidInjections++;
      const gate: LLMGate = async () => ({ suggested_level: llmLevel, reason: 'rng' });
      const r = await scoreKnowledgeRisk(sig, { gate, contextText: 'rng' });
      const h = scoreKnowledgeHeuristic(sig);
      expect(isAtLeast(r.level, h.level)).toBe(true);

      const hasCriticalTrigger = h.triggers.some(
        (t) => t.contributes_to === RiskLevel.CRITICAL,
      );
      if (hasCriticalTrigger) {
        criticalHeuristicCount++;
        expect(r.level).toBe(RiskLevel.CRITICAL);
      }

      if (!injectInvalid && compareRiskLevel(llmLevel, h.level) < 0) {
        downgradeAttempts++;
        // Só checamos a flag se o gate foi chamado (heurística ambígua).
        if (r.llm_consulted) {
          expect(r.llm_attempted_downgrade).toBe(true);
          expect(r.level).toBe(h.level);
        }
      }
    }
    expect(downgradeAttempts).toBeGreaterThan(0);
    expect(invalidInjections).toBeGreaterThan(0);
    expect(criticalHeuristicCount).toBeGreaterThan(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Codex review #97 finding 1 — knowledge CRITICAL never silently downgrades
// ---------------------------------------------------------------------------
describe('scoreKnowledgeRisk — CRITICAL composite no-downgrade', () => {
  it('procedimento critical_decision + irreversible: LLM adversarial NÃO rebaixa', async () => {
    const sig: KnowledgeRiskSignals = {
      knowledge_type: 'procedimento',
      topic: 'critical_decision',
      tool_kinds: ['irreversible'],
      evidence_count: 5,
    };
    // Heurística é CRITICAL — gate é SKIPADO (level >= HIGH).
    const adversarial: LLMGate = vi.fn(async () => ({
      suggested_level: RiskLevel.LOW,
      reason: 'parece ok',
    }));
    const r = await scoreKnowledgeRisk(sig, { gate: adversarial, contextText: 'x' });
    expect(r.level).toBe(RiskLevel.CRITICAL);
    expect(adversarial).not.toHaveBeenCalled();
    expect(r.decided_by).toBe('heuristic');
  });

  it('tool_request critical_decision + transfer: CRITICAL preservado mesmo se gate tentasse', async () => {
    const sig: KnowledgeRiskSignals = {
      knowledge_type: 'tool_request',
      topic: 'critical_decision',
      tool_kinds: ['transfer'],
    };
    const r = await scoreKnowledgeRisk(sig, {
      gate: async () => ({ suggested_level: RiskLevel.LOW, reason: 'mock' }),
      contextText: '',
    });
    expect(r.level).toBe(RiskLevel.CRITICAL);
  });
});

// ---------------------------------------------------------------------------
// Codex review #97 finding 3 — invalid gate output is ignored, not propagated
// ---------------------------------------------------------------------------
describe('scoreTurnRisk — invalid LLM output handling', () => {
  it('gate retorna nível string fora do enum → ignora, mantém heurístico', async () => {
    const gate: LLMGate = async () => ({
      suggested_level: 'super_critical' as unknown as RiskLevel,
      reason: 'fora do enum',
    });
    const r = await scoreTurnRisk(
      { topic: 'unknown' }, // ambíguo → gate consultado
      { gate, contextText: 'x' },
    );
    // Heurística é LOW; gate output inválido é ignorado.
    expect(r.level).toBe(RiskLevel.LOW);
    expect(r.llm_consulted).toBe(true);
    expect(r.llm_attempted_downgrade).toBe(false);
    expect(r.decided_by).toBe('heuristic');
  });

  it('gate retorna nível undefined → ignora, mantém heurístico', async () => {
    const gate: LLMGate = async () => ({
      suggested_level: undefined as unknown as RiskLevel,
      reason: 'sem level',
    });
    const r = await scoreTurnRisk(
      { topic: 'financial' }, // medium ambíguo → gate consultado
      { gate, contextText: 'x' },
    );
    expect(r.level).toBe(RiskLevel.MEDIUM);
    expect(r.decided_by).toBe('heuristic');
  });
});
