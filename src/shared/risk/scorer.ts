/**
 * P9c — Scorer composto: heurística (Stage 1, sempre) + gate Haiku
 * (Stage 2, condicional) + invariante "LLM nunca rebaixa".
 *
 * Defesa em profundidade — 3 camadas:
 *  1) TIPO: o `LLMGate` em `types.ts` aceita qualquer `RiskLevel`,
 *     mas a aplicação do resultado é feita por este módulo via
 *     `maxRiskLevel(heuristic, llm)` — nunca por atribuição direta.
 *  2) RUNTIME: este arquivo APLICA a regra. Se o LLM tentou rebaixar,
 *     `llm_attempted_downgrade=true` é registrado no resultado e em
 *     audit (via cognitive_module_log do gate + flag no scorer).
 *  3) PROPERTY TEST: `tests/unit/risk-scorer.spec.ts` gera 500 inputs
 *     aleatórios + LLM mock que pode tentar rebaixar; o resultado final
 *     nunca pode ficar abaixo do heurístico.
 *
 * Composição com `runCognitiveModule`:
 *  - O gate (`haikuRiskGate`) é wrapped no próprio módulo. O scorer
 *    aqui é PURO: não toca repos, não toca cognitive_module_log
 *    diretamente. Isso permite que os 2 wrappers (turn / knowledge)
 *    componham livremente sem audit duplicado.
 */
import { RiskLevel } from '@/types/enums.js';
import { maxRiskLevel, compareRiskLevel } from './level.js';
import { scoreTurnHeuristic, scoreKnowledgeHeuristic } from './heuristic.js';
import type {
  KnowledgeRiskSignals,
  LLMGate,
  ScoredRisk,
  TurnRiskSignals,
} from './types.js';

export type ScorerOptions = {
  /** Implementação do gate LLM (injetada para teste/composição). */
  gate: LLMGate;
  /** Texto contextual fornecido ao LLM. Caller controla redaction de PII. */
  contextText: string;
};

/**
 * Aplica heurística → gate condicional → no-downgrade enforcement.
 * Retorna `ScoredRisk` carregando o nível final + diagnóstico.
 */
async function applyGate(
  heuristic: { level: RiskLevel; confidence: number; ambiguous: boolean; triggers: ScoredRisk['triggers'] },
  opts: ScorerOptions,
): Promise<ScoredRisk> {
  // Pula gate se não-ambíguo OU se nível >= high (gastar Haiku para
  // tentar elevar HIGH→CRITICAL não vale; CRITICAL via LLM precisa de
  // sinal determinístico forte, nunca de inferência).
  const skipGate = !heuristic.ambiguous ||
    compareRiskLevel(heuristic.level, RiskLevel.HIGH) >= 0;
  if (skipGate) {
    return {
      level: heuristic.level,
      confidence: heuristic.confidence,
      llm_consulted: false,
      llm_attempted_downgrade: false,
      triggers: heuristic.triggers,
      decided_by: 'heuristic',
    };
  }

  let suggested: { suggested_level: RiskLevel; reason: string } | null;
  try {
    suggested = await opts.gate({
      current_level: heuristic.level,
      context_text: opts.contextText,
    });
  } catch {
    // Defensive — gate impl deveria capturar e retornar null. Aqui
    // garantimos que erro não vaza para o caller do scorer.
    suggested = null;
  }

  if (!suggested) {
    return {
      level: heuristic.level,
      confidence: heuristic.confidence,
      llm_consulted: true,
      llm_attempted_downgrade: false,
      triggers: heuristic.triggers,
      decided_by: 'heuristic',
    };
  }

  // 3-layer enforcement, layer 2 (RUNTIME):
  //   resolved = max(heuristic, llm) — se LLM < heuristic, max devolve
  //   heuristic e marcamos llm_attempted_downgrade=true.
  const attemptedDowngrade =
    compareRiskLevel(suggested.suggested_level, heuristic.level) < 0;
  const resolved = maxRiskLevel(heuristic.level, suggested.suggested_level);

  const llmActuallyMoved = compareRiskLevel(resolved, heuristic.level) > 0;

  return {
    level: resolved,
    confidence: heuristic.confidence,
    llm_consulted: true,
    llm_attempted_downgrade: attemptedDowngrade,
    triggers: heuristic.triggers,
    llm_reason: suggested.reason,
    decided_by: llmActuallyMoved ? 'llm_upgrade' : 'heuristic',
  };
}

export async function scoreTurnRisk(
  sig: TurnRiskSignals,
  opts: ScorerOptions,
): Promise<ScoredRisk> {
  const heuristic = scoreTurnHeuristic(sig);
  return applyGate(heuristic, opts);
}

export async function scoreKnowledgeRisk(
  sig: KnowledgeRiskSignals,
  opts: ScorerOptions,
): Promise<ScoredRisk> {
  const heuristic = scoreKnowledgeHeuristic(sig);
  return applyGate(heuristic, opts);
}
