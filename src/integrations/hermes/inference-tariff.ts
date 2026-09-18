/**
 * P06 (spec §9.2 "tarifa versionada conhecida") — a tarifa do modelo aprovado
 * a partir do catálogo do OpenRouter, que é o provider da casa.
 *
 * Só preço BUSCADO vale: a lista fixa de fallback do `openrouter-models.ts` não
 * tem `pricing_raw`, e um número que ninguém conferiu não vira teto duro.
 *
 * Duas taxas por token (prompt, completion) têm de cobrir tudo o que uma
 * chamada PELO GATEWAY pode custar. Por componente do preço cru:
 *
 *  - inalcançável pelo contrato estrito do §9.1 — busca web (`plugins`,
 *    `web_search_options`), escrita de cache (`cache_control`), imagem/áudio
 *    de entrada (conteúdo em partes) e de saída (`modalities`) são recusados na
 *    entrada, e o Hermes pinado só marca cache com base_url do OpenRouter, não
 *    a do gateway — ignorado;
 *  - leitura de cache — mais barata que o prompt: cobrar o prompt superestima;
 *  - `internal_reasoning` — o raciocínio conta em `completion_tokens`: coberto
 *    se não passar da taxa de completion, senão sem tarifa;
 *  - faixas (`overrides`, por tamanho do prompt ou janela UTC) — vale a MAIOR
 *    taxa entre a base e as faixas, qualquer que seja a condição;
 *  - qualquer outro componente diferente de zero (ex. taxa por request) ou
 *    forma desconhecida — sem tarifa.
 *
 * Sem tarifa, a policy da admissão decide (o default `deny` não admite). A
 * conversão lê a string decimal do catálogo e ARREDONDA PARA CIMA, como toda
 * conta de dinheiro do gateway. A versão é o digest do preço cru inteiro.
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

/**
 * Cobranças que só existem com campo ou forma de conteúdo que o contrato do
 * gateway recusa (teste em `hermes-inference-tariff.spec.ts` amarra as duas
 * listas), mais a leitura de cache.
 */
export const TARIFF_UNREACHABLE_COMPONENTS: ReadonlySet<string> = new Set([
  'web_search',
  'input_cache_write',
  'input_cache_write_1h',
  'image',
  'audio',
  'input_audio_cache',
  'image_output',
  'audio_output',
  'input_cache_read',
]);

/** Chaves de uma faixa que são CONDIÇÃO de aplicação, não preço. */
const CONDICOES_DE_FAIXA = new Set(['min_prompt_tokens', 'utc_days', 'utc_start', 'utc_end']);

type Taxas = { input: number; output: number };

const isObj = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function taxasDaFaixa(faixa: Readonly<Record<string, unknown>>, faixaExtra: boolean): Taxas | null {
  const input = nanousdPerTokenCeil(faixa.prompt);
  const output = nanousdPerTokenCeil(faixa.completion);
  if (input === null || output === null) return null;
  for (const [chave, valor] of Object.entries(faixa)) {
    if (chave === 'prompt' || chave === 'completion' || chave === 'overrides') continue;
    if (TARIFF_UNREACHABLE_COMPONENTS.has(chave)) continue;
    if (faixaExtra && CONDICOES_DE_FAIXA.has(chave)) continue;
    const nano = nanousdPerTokenCeil(valor);
    if (nano === null) return null;
    if (chave === 'internal_reasoning' && nano <= output) continue;
    if (nano > 0) return null;
  }
  return { input, output };
}

/** A maior taxa entre a base e as faixas, ou `null` se alguma não couber. */
function taxasDoPreco(raw: Readonly<Record<string, unknown>>): Taxas | null {
  const base = taxasDaFaixa(raw, false);
  if (!base) return null;
  const overrides = raw.overrides;
  if (overrides === undefined || overrides === null) return base;
  if (!Array.isArray(overrides)) return null;
  let { input, output } = base;
  for (const faixa of overrides) {
    const t = isObj(faixa) ? taxasDaFaixa(faixa, true) : null;
    if (!t) return null;
    input = Math.max(input, t.input);
    output = Math.max(output, t.output);
  }
  return { input, output };
}

export function createCatalogTariff(catalog: TariffCatalogV1) {
  return async function tariffFor(model: string): Promise<InferenceTariffV1 | null> {
    const { models, fallback } = await catalog.models();
    if (fallback) return null;
    const m = models.find((x) => x.id === model);
    const raw = m?.pricing_raw;
    if (!m || !raw) return null;
    const taxas = taxasDoPreco(raw);
    if (!taxas) return null;
    return {
      version: `openrouter:${canonicalDigest({ id: m.id, pricing: raw }).slice(0, 16)}`,
      input_nanousd_per_token: taxas.input,
      output_nanousd_per_token: taxas.output,
    };
  };
}
