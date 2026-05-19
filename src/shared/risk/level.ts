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
 *
 * Revisão Codex #97 (defesa fail-closed):
 *  - `compareRiskLevel`/`maxRiskLevel` agora rejeitam entradas runtime
 *    inválidas (string fora do enum, undefined, número). Sem isso, um
 *    `risk_override` corrompido ou output de gate fora do enum podia
 *    produzir NaN em compare e propagar um nível inválido em max,
 *    corrompendo o ScoredRisk.level final.
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
 * Type guard runtime: true se `value` é um RiskLevel válido (string do
 * enum). Use em borders runtime (LLM output, owner override, deserialização)
 * antes de passar para `compare`/`max`.
 */
export function isRiskLevel(value: unknown): value is RiskLevel {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(RANK, value);
}

/**
 * Versão assert do guard. Lança `InvalidRiskLevelError` se inválido.
 * Use quando o caller exige que a string seja válida (ex.: deserialização
 * de uma row do DB onde o schema deveria ter garantido o enum).
 */
export function assertRiskLevel(value: unknown, context = 'risk level'): asserts value is RiskLevel {
  if (!isRiskLevel(value)) {
    throw new InvalidRiskLevelError(value, context);
  }
}

/**
 * Erro tipado para entradas RiskLevel inválidas em borders runtime.
 * Caller pode catch para diferenciar de outros erros.
 */
export class InvalidRiskLevelError extends Error {
  readonly value: unknown;
  readonly context: string;
  constructor(value: unknown, context: string) {
    super(`Invalid risk level (${context}): ${JSON.stringify(value)}`);
    this.name = 'InvalidRiskLevelError';
    this.value = value;
    this.context = context;
  }
}

/**
 * Retorna -1 / 0 / 1 (estilo `Array.prototype.sort`).
 *
 * Fail-closed: se algum operando NÃO for um RiskLevel válido, lança
 * `InvalidRiskLevelError`. Isso impede que um valor corrompido propague
 * silenciosamente (antes: `RANK[bad]` ⇒ undefined ⇒ NaN em Math.sign).
 */
export function compareRiskLevel(a: RiskLevel, b: RiskLevel): number {
  assertRiskLevel(a, 'compareRiskLevel.a');
  assertRiskLevel(b, 'compareRiskLevel.b');
  return Math.sign(RANK[a] - RANK[b]);
}

/**
 * Retorna o nível de maior severidade. Ties → primeiro argumento
 * (irrelevante para a aplicação, mas determinístico para testes).
 *
 * Fail-closed: idem `compareRiskLevel`. Antes, `maxRiskLevel(good, bad)`
 * podia retornar `bad` se `RANK[bad]` fosse undefined (NaN >= num = false,
 * mas precedência variava). Agora, qualquer operando inválido vira throw.
 */
export function maxRiskLevel(a: RiskLevel, b: RiskLevel): RiskLevel {
  assertRiskLevel(a, 'maxRiskLevel.a');
  assertRiskLevel(b, 'maxRiskLevel.b');
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * `a >= b` em severidade. Fail-closed na validação de entrada.
 */
export function isAtLeast(a: RiskLevel, b: RiskLevel): boolean {
  assertRiskLevel(a, 'isAtLeast.a');
  assertRiskLevel(b, 'isAtLeast.b');
  return RANK[a] >= RANK[b];
}

/**
 * Versão "soft" de `maxRiskLevel`: se um operando for inválido, retorna
 * o outro (válido) em vez de throw. Use no caminho post-LLM onde queremos
 * IGNORAR um output suspeito do gate em vez de quebrar o turn — o caller
 * é responsável por logar o caso para audit.
 *
 * Se AMBOS forem inválidos, ainda throw (não há nível seguro a devolver).
 */
export function maxRiskLevelSafe(a: unknown, b: unknown): RiskLevel {
  const aValid = isRiskLevel(a);
  const bValid = isRiskLevel(b);
  if (aValid && bValid) return maxRiskLevel(a, b);
  if (aValid) return a;
  if (bValid) return b;
  throw new InvalidRiskLevelError(a, 'maxRiskLevelSafe: both invalid');
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
