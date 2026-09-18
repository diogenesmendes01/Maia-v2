/**
 * P06 (spec §9.2 "tarifa versionada conhecida") — a tarifa do modelo aprovado
 * a partir do catálogo do OpenRouter, que é o provider da casa.
 *
 * Só preço BUSCADO vale, e só quando ele é o preço inteiro:
 *
 *  - a lista fixa de fallback do `openrouter-models.ts` não tem `pricing_raw`,
 *    e um número que ninguém conferiu não vira teto duro;
 *  - preço em FAIXAS (`overrides`, ex. acima de 200k tokens de prompt) ou com
 *    componente além de prompt/completion (por request, imagem, busca,
 *    raciocínio, escrita de cache) não cabe em duas taxas por token — usar só
 *    as duas subcontaria. Cache de LEITURA é ignorado: é mais barato que o
 *    prompt, então cobrar o prompt é superestimar, o lado seguro.
 *
 * Nesses casos a tarifa é `null` e a policy da admissão decide (o default
 * `deny` não admite). A conversão lê a string decimal do catálogo e ARREDONDA
 * PARA CIMA, como toda conta de dinheiro do gateway. A versão é o digest do
 * preço cru inteiro.
 */
import { canonicalDigest } from './canonical-json.js';
import type { InferenceTariffV1 } from './inference-flow.js';
import type { OpenRouterModel } from '@/lib/openrouter-models.js';

export interface TariffCatalogV1 {
  /** O catálogo, e se ele veio do fallback fixo. */
  models(): Promise<{ models: readonly OpenRouterModel[]; fallback: boolean }>;
}

const DECIMAL_RE = /^(\d+)(?:\.(\d+))?$/;
const NANO_DIGITS = 9;

/** US$ por token (string decimal do catálogo) → nanousd por token, para CIMA. */
export function nanousdPerTokenCeil(usdPerToken: unknown): number | null {
  if (typeof usdPerToken !== 'string') return null;
  const m = DECIMAL_RE.exec(usdPerToken.trim());
  if (!m) return null;
  const inteiro = m[1] ?? '0';
  const frac = m[2] ?? '';
  const cabe = frac.slice(0, NANO_DIGITS).padEnd(NANO_DIGITS, '0');
  const sobra = frac.slice(NANO_DIGITS);
  let nano = BigInt(inteiro) * 10n ** BigInt(NANO_DIGITS) + BigInt(cabe);
  if (/[1-9]/.test(sobra)) nano += 1n;
  return nano > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(nano);
}

/** Componentes que as duas taxas por token não representam. */
const IGNORAVEIS = new Set(['prompt', 'completion', 'input_cache_read']);

function precoInteiro(raw: Readonly<Record<string, unknown>>): boolean {
  for (const [chave, valor] of Object.entries(raw)) {
    if (IGNORAVEIS.has(chave)) continue;
    if (chave === 'overrides') {
      if (Array.isArray(valor) ? valor.length > 0 : valor !== null && valor !== undefined)
        return false;
      continue;
    }
    // Qualquer outro componente com valor diferente de zero → preço incompleto.
    const nano = nanousdPerTokenCeil(valor);
    if (nano === null || nano > 0) return false;
  }
  return true;
}

export function createCatalogTariff(catalog: TariffCatalogV1) {
  return async function tariffFor(model: string): Promise<InferenceTariffV1 | null> {
    const { models, fallback } = await catalog.models();
    if (fallback) return null;
    const m = models.find((x) => x.id === model);
    const raw = m?.pricing_raw;
    if (!m || !raw || !precoInteiro(raw)) return null;
    const input = nanousdPerTokenCeil(raw.prompt);
    const output = nanousdPerTokenCeil(raw.completion);
    if (input === null || output === null) return null;
    return {
      version: `openrouter:${canonicalDigest({ id: m.id, pricing: raw }).slice(0, 16)}`,
      input_nanousd_per_token: input,
      output_nanousd_per_token: output,
    };
  };
}
