import { factsRepo } from '@/db/repositories.js';
import { logger } from '@/lib/logger.js';

// Approximate USD prices per 1k tokens (cents). Kept conservative so the
// daily-threshold alert fires earlier on miscount rather than later.
const USD_CENTS_PER_1K_TOKENS: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-6': { input: 0.3, output: 1.5 },
  'claude-opus-4-7': { input: 1.5, output: 7.5 },
  'claude-haiku-4-5-20251001': { input: 0.08, output: 0.4 },
  'voyage-3': { input: 0.012, output: 0 },
  'whisper-1': { input: 0.6, output: 0 },
};

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function rateFor(model: string): { input: number; output: number } {
  return USD_CENTS_PER_1K_TOKENS[model] ?? { input: 0.3, output: 1.5 };
}

export async function recordLLMCost(input: {
  provider: string;
  model: string;
  tokens_input: number;
  tokens_output: number;
}): Promise<void> {
  try {
    const day = todayKey();
    const rate = rateFor(input.model);
    const usd_cents =
      (input.tokens_input / 1000) * rate.input + (input.tokens_output / 1000) * rate.output;
    const key = `cost.daily.llm.${day}`;
    const existing = await factsRepo.getByKey('global', key);
    const prev = (existing?.valor ?? {}) as {
      tokens_input?: number;
      tokens_output?: number;
      usd_cents?: number;
    };
    await factsRepo.upsert({
      escopo: 'global',
      chave: key,
      valor: {
        tokens_input: (prev.tokens_input ?? 0) + input.tokens_input,
        tokens_output: (prev.tokens_output ?? 0) + input.tokens_output,
        usd_cents: Math.round(((prev.usd_cents ?? 0) + usd_cents) * 100) / 100,
        provider: input.provider,
        last_model: input.model,
      },
      fonte: 'inferido',
      confianca: 1,
    });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'cost_ledger.llm_failed');
  }
}

export async function readDailyLLMUsd(day: string = todayKey()): Promise<number> {
  const f = await factsRepo.getByKey('global', `cost.daily.llm.${day}`);
  if (!f) return 0;
  const v = (f.valor ?? {}) as { usd_cents?: number };
  return (v.usd_cents ?? 0) / 100;
}
