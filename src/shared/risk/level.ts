/**
 * P9c — Risk level utilities (single source of truth for ordering).
 *
 * Ordenação total imutável: low < medium < high < critical.
 *
 * Por que centralizar:
 *  - O invariante "LLM nunca rebaixa" depende de uma ordenação total
 *    confiável. Centralizar evita comparações de string ad-hoc que
 *    podem regredir silenciosamente se o enum for reordenado em
 *    `src/types/enums.ts`.
 *  - `maxRiskLevel` e `compareRiskLevel` são as únicas APIs
 *    aprovadas para combinar/comparar níveis.
 */
import { RiskLevel } from '@/types/enums.js';

/**
 * Mapping numérico estável usado SOMENTE internamente para comparações.
 * Não exportado: não vire fonte de verdade alternativa fora deste módulo.
 */
const RANK: Record<RiskLevel, number> = {
  [RiskLevel.LOW]: 0,
  [RiskLevel.MEDIUM]: 1,
  [RiskLevel.HIGH]: 2,
  [RiskLevel.CRITICAL]: 3,
};

/**
 * Retorna -1 / 0 / 1 (estilo `Array.prototype.sort`).
 */
export function compareRiskLevel(a: RiskLevel, b: RiskLevel): number {
  return Math.sign(RANK[a] - RANK[b]);
}

/**
 * Retorna o nível de maior severidade. Ties → primeiro argumento
 * (irrelevante para a aplicação, mas determinístico para testes).
 */
export function maxRiskLevel(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * `a >= b` em severidade.
 */
export function isAtLeast(a: RiskLevel, b: RiskLevel): boolean {
  return RANK[a] >= RANK[b];
}

/**
 * Lista totalmente ordenada (low → critical). Útil para iterar
 * em testes e em tabelas de UI.
 */
export const RISK_LEVELS_ASCENDING: readonly RiskLevel[] = Object.freeze([
  RiskLevel.LOW,
  RiskLevel.MEDIUM,
  RiskLevel.HIGH,
  RiskLevel.CRITICAL,
]);
