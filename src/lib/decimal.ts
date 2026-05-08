// Wrapper sobre decimal.js para aritmética financeira segura.
//
// Por que existe: o driver `pg` retorna colunas `numeric(15,2)` como string
// (e não `number`) justamente para preservar precisão. Qualquer
// `Number(string)` ou aritmética em ponto flutuante (0.1 + 0.2 !== 0.3)
// é inaceitável em sistema financeiro de 9 entidades. Toda soma, subtração,
// multiplicação ou comparação numérica de valores monetários DEVE passar
// por Decimal.
//
// Padrão: precisão de 30 dígitos significativos é folga grande sobre
// numeric(15,2), e ROUND_HALF_EVEN ("banker's rounding") é o padrão
// financeiro internacional — mantém balanço de arredondamentos em zero
// no longo prazo, ao contrário do half-up que enviesa pra cima.

import Decimal from 'decimal.js';

Decimal.set({
  precision: 30,
  rounding: Decimal.ROUND_HALF_EVEN,
});

export { Decimal };

/**
 * Converte string (vinda do Postgres) ou number (vindo de input/zod) em Decimal.
 * - `null`/`undefined` → `new Decimal(0)`
 * - String inválida ou NaN → throws com mensagem clara
 *
 * Aceita Decimal de entrada (no-op, retorna a mesma referência) pra
 * permitir composição em pipelines onde o tipo já foi normalizado antes.
 */
export function toDecimal(v: string | number | null | undefined | Decimal): Decimal {
  if (v === null || v === undefined) return new Decimal(0);
  if (v instanceof Decimal) return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) {
      throw new Error(`toDecimal: valor numérico inválido (${v})`);
    }
    return new Decimal(v);
  }
  // string
  try {
    const d = new Decimal(v);
    if (d.isNaN()) {
      throw new Error(`toDecimal: string inválida ("${v}")`);
    }
    return d;
  } catch (err) {
    throw new Error(
      `toDecimal: não foi possível parsear "${v}" como Decimal: ${(err as Error).message}`,
      { cause: err },
    );
  }
}

/**
 * Formata um Decimal como BRL: `R$ 1.234,56`.
 *
 * NOTA DE PRECISÃO: a formatação final converte o Decimal pra `number`
 * via `.toNumber()` antes de passar pro `Intl.NumberFormat`. Isso aceita
 * perda de precisão na CONVERSÃO PRA STRING — não na aritmética. Para
 * valores realistas (R$ 0,00 a R$ 50.000,00 do hard limit, e mesmo bem
 * acima), essa conversão é exata. Aritmética intermediária (somas,
 * subtrações, multiplicações) deve continuar em Decimal antes de chamar
 * fmtBRL no resultado final.
 */
export function fmtBRL(d: Decimal): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(d.toNumber());
}

/**
 * Soma uma lista de valores (string Postgres, number, Decimal, ou null/undefined).
 * Retorna sempre Decimal — chame `.toString()` ou `fmtBRL` no resultado.
 */
export function sumDecimal(
  values: Array<string | number | null | undefined | Decimal>,
): Decimal {
  let acc = new Decimal(0);
  for (const v of values) {
    acc = acc.plus(toDecimal(v));
  }
  return acc;
}
