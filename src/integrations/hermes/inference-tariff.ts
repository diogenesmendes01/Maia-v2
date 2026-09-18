/**
 * P06 (spec §9.2 "tarifa versionada conhecida") — a tarifa do modelo aprovado
 * a partir do catálogo do OpenRouter, que é o provider da casa.
 *
 * Só preço BUSCADO no catálogo vale: a lista fixa de fallback do
 * `openrouter-models.ts` é o que o seletor de modelos usa quando o catálogo não
 * responde, e tratar aquele número como preço verificável poria um teto duro
 * em cima de um valor que ninguém conferiu. Sem catálogo, a tarifa é `null` e
 * a policy da admissão decide (o default `deny` não admite).
 *
 * A versão é o digest do par (modelo, preço): o ledger registra exatamente a
 * tarifa com que cada tentativa foi reservada e liquidada.
 */
import { canonicalDigest } from './canonical-json.js';
import type { InferenceTariffV1 } from './inference-flow.js';
import type { OpenRouterModel } from '@/lib/openrouter-models.js';

export interface TariffCatalogV1 {
  /** O catálogo, e se ele veio do fallback fixo. */
  models(): Promise<{ models: readonly OpenRouterModel[]; fallback: boolean }>;
}

/** US$ por milhão de tokens → nanousd por token (×1000), inteiro. */
function nanousdPerToken(usdPerMillion: number): number | null {
  if (!Number.isFinite(usdPerMillion) || usdPerMillion < 0) return null;
  return Math.round(usdPerMillion * 1000);
}

export function createCatalogTariff(catalog: TariffCatalogV1) {
  return async function tariffFor(model: string): Promise<InferenceTariffV1 | null> {
    const { models, fallback } = await catalog.models();
    if (fallback) return null;
    const m = models.find((x) => x.id === model);
    if (!m) return null;
    const input = nanousdPerToken(m.pricing.prompt_per_million);
    const output = nanousdPerToken(m.pricing.completion_per_million);
    if (input === null || output === null) return null;
    return {
      version: `openrouter:${canonicalDigest({ id: m.id, pricing: m.pricing }).slice(0, 16)}`,
      input_nanousd_per_token: input,
      output_nanousd_per_token: output,
    };
  };
}
