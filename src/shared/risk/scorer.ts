/**
 * P9c — Scorer composto: heurística (Stage 1, sempre) + gate Haiku
 * (Stage 2, condicional) + invariante "LLM nunca rebaixa".
 *
 * Defesa em profundidade — 4 camadas (Codex review #97):
 *  1) TIPO: o `LLMGate` em `types.ts` aceita qualquer `RiskLevel`,
 *     mas a aplicação do resultado é feita por este módulo via
 *     `maxRiskLevel(heuristic, llm)` — nunca por atribuição direta.
 *  2) RUNTIME (1): este arquivo APLICA a regra do max. Se o LLM tentou
 *     rebaixar, `llm_attempted_downgrade=true` é registrado no resultado
 *     e em audit (via cognitive_module_log do gate + flag no scorer).
 *  3) RUNTIME (2): `assertNoCriticalSignalLoss` post-LLM verifica que
 *     se a heurística produziu um trigger CRITICAL determinístico,
 *     o resultado final é CRITICAL. Se algum caminho futuro tentar
 *     comprimir esse sinal, esta asserção quebra o caminho em vez de
 *     deixar passar uma under-classification silenciosa.
 *  4) PROPERTY TEST: `tests/unit/risk-scorer.spec.ts` gera 10k inputs
 *     aleatórios + LLM mock que pode tentar rebaixar; o resultado final
 *     nunca pode ficar abaixo do heurístico, e nenhum trigger CRITICAL
 *     desaparece silenciosamente.
 *
 * Validação de runtime fail-closed (level.ts): se o gate devolver um
 * suggested_level fora do enum RiskLevel, `compareRiskLevel` lança
 * `InvalidRiskLevelError`. Aqui capturamos esse erro e tratamos como
 * "gate inválido" (mantém heurístico) sem propagar.
 *
 * Composição com `runCognitiveModule`:
 *  - O gate (`haikuRiskGate`) é wrapped no próprio módulo. O scorer
 *    aqui é PURO: não toca repos, não toca cognitive_module_log
 *    diretamente. Isso permite que os 2 wrappers (turn / knowledge)
 *    componham livremente sem audit duplicado.
 */
import { RiskLevel } from '@/types/enums.js';
import { logger } from '@/lib/logger.js';
import {
  maxRiskLevel,
  compareRiskLevel,
  isRiskLevel,
  isAtLeast,
  InvalidRiskLevelError,
} from './level.js';
import { scoreTurnHeuristic, scoreKnowledgeHeuristic } from './heuristic.js';
import type {
  KnowledgeRiskSignals,
  LLMGate,
  RiskTrigger,
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
 * Codex review #97 — invariante crítico:
 *
 * Se a heurística determinística marcou um trigger CRITICAL (ex.: o
 * composite `critical_decision + tool sensível`), o nível final NÃO
 * pode cair abaixo de CRITICAL — mesmo que outras lógicas (gate, owner
 * override, futuros decoradores) tentem suprimir.
 *
 * Esta função é defensiva: ela NÃO deveria nunca corrigir nada na
 * implementação atual (porque `maxRiskLevel` já garante isso), mas
 * registramos um warn loud + retornamos o nível corrigido se algum
 * caminho futuro regredir.
 *
 * Em outras palavras: é uma assertion-with-rescue. Em dev, deveria
 * sempre ser no-op. Em prod, se quebrar, corrige + log para alerta.
 */
function assertNoCriticalSignalLoss(
  triggers: ReadonlyArray<RiskTrigger>,
  resolvedLevel: RiskLevel,
  context: 'turn' | 'knowledge',
): RiskLevel {
  const hasCriticalTrigger = triggers.some(
    (t) => t.contributes_to === RiskLevel.CRITICAL,
  );
  if (!hasCriticalTrigger) return resolvedLevel;
  if (isAtLeast(resolvedLevel, RiskLevel.CRITICAL)) return resolvedLevel;
  // Defesa-em-profundidade: re-escala para CRITICAL e loga audit-visible.
  logger.warn(
    {
      module: 'risk_scorer',
      context,
      resolved_level_before: resolvedLevel,
      critical_triggers: triggers
        .filter((t) => t.contributes_to === RiskLevel.CRITICAL)
        .map((t) => t.signal),
    },
    'scorer.critical_signal_loss_corrected',
  );
  return RiskLevel.CRITICAL;
}

/**
 * Aplica heurística → gate condicional → no-downgrade enforcement →
 * assertCriticalSignals. Retorna `ScoredRisk` carregando o nível final
 * + diagnóstico.
 */
async function applyGate(
  heuristic: { level: RiskLevel; confidence: number; ambiguous: boolean; triggers: ScoredRisk['triggers'] },
  opts: ScorerOptions,
  context: 'turn' | 'knowledge',
): Promise<ScoredRisk> {
  // Pula gate se não-ambíguo OU se nível >= high (gastar Haiku para
  // tentar elevar HIGH→CRITICAL não vale; CRITICAL via LLM precisa de
  // sinal determinístico forte, nunca de inferência).
  const skipGate = !heuristic.ambiguous ||
    compareRiskLevel(heuristic.level, RiskLevel.HIGH) >= 0;
  if (skipGate) {
    const level = assertNoCriticalSignalLoss(heuristic.triggers, heuristic.level, context);
    return {
      level,
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
    const level = assertNoCriticalSignalLoss(heuristic.triggers, heuristic.level, context);
    return {
      level,
      confidence: heuristic.confidence,
      llm_consulted: true,
      llm_attempted_downgrade: false,
      triggers: heuristic.triggers,
      decided_by: 'heuristic',
    };
  }

  // Codex review #97 finding 3 — defesa fail-closed contra outputs
  // corrompidos. Se o LLM (ou um stub mal-comportado) devolveu uma
  // string fora do enum, `compareRiskLevel` lança InvalidRiskLevelError.
  // Em vez de propagar, IGNORAMOS o output e mantemos a heurística — o
  // resultado fica como se o gate tivesse retornado null, mas logamos.
  if (!isRiskLevel(suggested.suggested_level)) {
    logger.warn(
      {
        module: 'risk_scorer',
        context,
        invalid_suggested_level: suggested.suggested_level,
      },
      'scorer.gate_returned_invalid_level_ignored',
    );
    const level = assertNoCriticalSignalLoss(heuristic.triggers, heuristic.level, context);
    return {
      level,
      confidence: heuristic.confidence,
      llm_consulted: true,
      llm_attempted_downgrade: false,
      triggers: heuristic.triggers,
      llm_reason: suggested.reason,
      decided_by: 'heuristic',
    };
  }

  // 3-layer enforcement, layer 2 (RUNTIME):
  //   resolved = max(heuristic, llm) — se LLM < heuristic, max devolve
  //   heuristic e marcamos llm_attempted_downgrade=true.
  let attemptedDowngrade: boolean;
  let resolved: RiskLevel;
  try {
    attemptedDowngrade = compareRiskLevel(suggested.suggested_level, heuristic.level) < 0;
    resolved = maxRiskLevel(heuristic.level, suggested.suggested_level);
  } catch (err) {
    // Belt-and-suspenders: se algum operando virar inválido ENTRE o
    // isRiskLevel guard acima e este bloco (concorrência ou bug futuro),
    // tratamos como gate-null em vez de quebrar o turn.
    if (err instanceof InvalidRiskLevelError) {
      logger.warn(
        { module: 'risk_scorer', context, err: err.message },
        'scorer.invalid_risk_level_in_compare_ignored',
      );
      const level = assertNoCriticalSignalLoss(heuristic.triggers, heuristic.level, context);
      return {
        level,
        confidence: heuristic.confidence,
        llm_consulted: true,
        llm_attempted_downgrade: false,
        triggers: heuristic.triggers,
        llm_reason: suggested.reason,
        decided_by: 'heuristic',
      };
    }
    throw err;
  }

  // Audit-visible log: LLM tried to lower a non-CRITICAL heuristic.
  // (CRITICAL case is protected by skipGate above + assertNoCriticalSignalLoss.)
  if (attemptedDowngrade) {
    logger.warn(
      {
        module: 'risk_scorer',
        context,
        heuristic_level: heuristic.level,
        llm_suggested_level: suggested.suggested_level,
        llm_reason: suggested.reason,
      },
      'scorer.llm_disagreed_down_ignored',
    );
  }

  // Final assertion: critical signals survived end-to-end.
  const finalLevel = assertNoCriticalSignalLoss(heuristic.triggers, resolved, context);
  const llmActuallyMoved = compareRiskLevel(finalLevel, heuristic.level) > 0;

  return {
    level: finalLevel,
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
  return applyGate(heuristic, opts, 'turn');
}

export async function scoreKnowledgeRisk(
  sig: KnowledgeRiskSignals,
  opts: ScorerOptions,
): Promise<ScoredRisk> {
  const heuristic = scoreKnowledgeHeuristic(sig);
  return applyGate(heuristic, opts, 'knowledge');
}
