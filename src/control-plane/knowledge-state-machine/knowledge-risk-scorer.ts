/**
 * P9c — KnowledgeRiskScorer.
 *
 * Wrapper fino sobre `src/shared/risk/scorer.ts` para o pipeline de
 * lifecycle de conhecimento (proposed → testing → active → frozen →
 * rolled_back). Reaproveita 100% da heurística + gate Haiku — o
 * invariante "LLM nunca rebaixa" vem grátis do shared.
 *
 * Quem chama (futuro):
 *  - Classificador de candidatos (P1) ao decidir aceitar/rejeitar
 *    propostas de regra/procedimento.
 *  - Persister (P3a/P3c) ao gatekeep transição proposed→active.
 *  - Drift decision-engine (P4) ao avaliar risco de uma evidência
 *    transformada em ação.
 *
 * P9c entrega o módulo + a interface, sem alterar fluxos consumidores.
 */
import { scoreKnowledgeRisk } from '@/shared/risk/scorer.js';
import { haikuRiskGate } from '@/shared/risk/llm-gate.js';
import type { ScoredRisk, KnowledgeRiskSignals, LLMGate } from '@/shared/risk/types.js';

export type KnowledgeRiskScorerOptions = {
  /** Sobrescreve o gate (default: haikuRiskGate). */
  gate?: LLMGate;
  /** Texto que vai ao LLM se o gate disparar. Default: ''. */
  contextText?: string;
};

export async function scoreKnowledge(
  signals: KnowledgeRiskSignals,
  opts: KnowledgeRiskScorerOptions = {},
): Promise<ScoredRisk> {
  return scoreKnowledgeRisk(signals, {
    gate: opts.gate ?? haikuRiskGate,
    contextText: opts.contextText ?? '',
  });
}

// Re-export para conveniência dos call sites (mesma razão do wrapper de turn).
export type { KnowledgeRiskSignals, ScoredRisk } from '@/shared/risk/types.js';
