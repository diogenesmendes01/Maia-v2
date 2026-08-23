/**
 * P9c — TurnRiskScorer.
 *
 * Wrapper fino sobre `src/shared/risk/scorer.ts` para o caminho de
 * decisão por turno. Reaproveita 100% da heurística + gate Haiku do
 * shared module — não duplica lógica.
 *
 * Responsabilidades exclusivas do wrapper:
 *  - Default do gate (Haiku); injeção em testes.
 *  - Default do contextText (vazio se caller não passar — gate ainda
 *    funciona, mas com sinal mais fraco).
 *
 * Quem chama:
 *  - Em P9c este wrapper só EXISTE; consumidores (preturn-graph,
 *    react-loop, critic) integram em fase posterior. P9c entrega o
 *    módulo + a interface, sem alterar caminho crítico.
 */
import { scoreTurnRisk } from '@/shared/risk/scorer.js';
import { haikuRiskGate } from '@/shared/risk/llm-gate.js';
import type { ScoredRisk, TurnRiskSignals, LLMGate } from '@/shared/risk/types.js';

export type TurnRiskScorerOptions = {
  /** Sobrescreve o gate (default: haikuRiskGate). Use em testes ou para
   *  desabilitar o LLM em ambientes offline. */
  gate?: LLMGate;
  /** Texto que vai ao LLM se o gate disparar. Default: ''. */
  contextText?: string;
  /**
   * Issue #507 (achado 2) — cancelamento do caller. O Decision Engine já
   * entrega este sinal ao port `riskScorer.score`; sem repassá-lo daqui a
   * cadeia morria antes do `callLLM` do gate.
   */
  signal?: AbortSignal;
};

export async function scoreTurn(
  signals: TurnRiskSignals,
  opts: TurnRiskScorerOptions = {},
): Promise<ScoredRisk> {
  return scoreTurnRisk(signals, {
    gate: opts.gate ?? haikuRiskGate,
    contextText: opts.contextText ?? '',
    // Issue #507 (achado 2) — o sinal do turno, vindo do Decision Engine.
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}

// Re-export tipos relevantes para callers do wrapper. Evita que cada
// consumer importe de shared E de runtime — basta importar daqui.
export type { TurnRiskSignals, ScoredRisk } from '@/shared/risk/types.js';
