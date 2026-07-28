import { factsRepo } from '@/db/repositories.js';
import { logger } from '@/lib/logger.js';
import { incCounter } from '@/lib/metrics.js';
import { getToolCallingModels } from '@/lib/openrouter-models.js';

// Approximate USD prices per 1k tokens (cents) for direct-vendor models.
// OpenRouter slugs (containing '/') resolve via getModelPricing(slug) below.
// Conservative defaults so the daily threshold alert errs on the early side.
const USD_CENTS_PER_1K_TOKENS: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-6': { input: 0.3, output: 1.5 },
  'claude-opus-4-7': { input: 1.5, output: 7.5 },
  'claude-haiku-4-5-20251001': { input: 0.08, output: 0.4 },
  'voyage-3': { input: 0.012, output: 0 },
  'whisper-1': { input: 0.6, output: 0 },
};

const FALLBACK_RATE = { input: 0.3, output: 1.5 };

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Look up cents/1k for an OpenRouter slug from the existing 1h-cached
 * `getToolCallingModels()` (no extra HTTP). Returns the conservative
 * fallback if the slug isn't in the list (e.g. cold cache + first network
 * failure). OpenRouter pricing is in USD per million tokens, so we divide
 * by 10 to get cents per 1k.
 */
async function getModelPricing(slug: string): Promise<{ input: number; output: number }> {
  try {
    const models = await getToolCallingModels();
    const m = models.find((x) => x.id === slug);
    if (!m) return FALLBACK_RATE;
    return {
      input: m.pricing.prompt_per_million / 10,
      output: m.pricing.completion_per_million / 10,
    };
  } catch {
    return FALLBACK_RATE;
  }
}

async function rateFor(model: string): Promise<{ input: number; output: number }> {
  // OpenRouter slugs contain a "/", e.g. "anthropic/claude-sonnet-4.6". The
  // hardcoded table never has those — they live in OpenRouter's catalog.
  if (model.includes('/')) return getModelPricing(model);
  return USD_CENTS_PER_1K_TOKENS[model] ?? FALLBACK_RATE;
}

export async function recordLLMCost(input: {
  provider: string;
  model: string;
  tokens_input: number;
  tokens_output: number;
  /**
   * Optional. When set, the call's tokens + USD are aggregated to a per-pessoa
   * key (`cost.daily.llm.${day}.${pessoa_id}`) IN ADDITION to the existing
   * global aggregate. Workers running outside any pessoa context (briefings,
   * reflection batches) leave this undefined → only the global counter moves.
   */
  pessoa_id?: string;
}): Promise<void> {
  try {
    const day = todayKey();
    const rate = await rateFor(input.model);
    const usd_cents =
      (input.tokens_input / 1000) * rate.input + (input.tokens_output / 1000) * rate.output;
    await upsertCostFact({
      escopo: 'global',
      chave: `cost.daily.llm.${day}`,
      delta: { tokens_input: input.tokens_input, tokens_output: input.tokens_output, usd_cents },
      provider: input.provider,
      model: input.model,
    });
    if (input.pessoa_id) {
      await upsertCostFact({
        escopo: 'pessoa',
        chave: `cost.daily.llm.${day}.${input.pessoa_id}`,
        delta: { tokens_input: input.tokens_input, tokens_output: input.tokens_output, usd_cents },
        provider: input.provider,
        model: input.model,
      });
    }
  } catch (err) {
    // Issue #508: falha de persistência do ledger não pode descartar a
    // evidência em silêncio. O warn já existia; o counter é o que dá sinal
    // operacional (alertável) de que custo está sendo perdido.
    incCounter('maia_llm_cost_ledger_failures_total', { stage: 'upsert' });
    logger.warn({ err: (err as Error).message }, 'cost_ledger.llm_failed');
  }
}

async function upsertCostFact(args: {
  escopo: string;
  chave: string;
  delta: { tokens_input: number; tokens_output: number; usd_cents: number };
  provider: string;
  model: string;
}): Promise<void> {
  const existing = await factsRepo.getByKey(args.escopo, args.chave);
  const prev = (existing?.valor ?? {}) as {
    tokens_input?: number;
    tokens_output?: number;
    usd_cents?: number;
  };
  await factsRepo.upsert({
    escopo: args.escopo,
    chave: args.chave,
    valor: {
      tokens_input: (prev.tokens_input ?? 0) + args.delta.tokens_input,
      tokens_output: (prev.tokens_output ?? 0) + args.delta.tokens_output,
      usd_cents: Math.round(((prev.usd_cents ?? 0) + args.delta.usd_cents) * 100) / 100,
      provider: args.provider,
      last_model: args.model,
    },
    fonte: 'inferido',
    confianca: 1,
  });
}

export async function readDailyLLMUsdByPessoa(
  pessoa_id: string,
  day: string = todayKey(),
): Promise<number> {
  const f = await factsRepo.getByKey('pessoa', `cost.daily.llm.${day}.${pessoa_id}`);
  if (!f) return 0;
  const v = (f.valor ?? {}) as { usd_cents?: number };
  return (v.usd_cents ?? 0) / 100;
}

export async function readDailyLLMUsd(day: string = todayKey()): Promise<number> {
  const f = await factsRepo.getByKey('global', `cost.daily.llm.${day}`);
  if (!f) return 0;
  const v = (f.valor ?? {}) as { usd_cents?: number };
  return (v.usd_cents ?? 0) / 100;
}
