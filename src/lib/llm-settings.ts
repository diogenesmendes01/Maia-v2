import { factsRepo } from '@/db/repositories.js';
import { config } from '@/config/env.js';

/**
 * Runtime model selection. Stored as a fact with `escopo='global'` so the
 * operator can change the LLM model from the dashboard without restarting
 * the process. Each `callLLM` invocation reads the current value (cheap
 * single-row query). On miss, falls back to the env-var defaults
 * (`OPENROUTER_MODEL_*` or `CLAUDE_MODEL_*` depending on `LLM_PROVIDER`).
 */
const KEY_MAIN = 'llm.model.main';
const KEY_FAST = 'llm.model.fast';

function envDefaultMain(): string {
  return config.LLM_PROVIDER === 'openrouter'
    ? config.OPENROUTER_MODEL_MAIN
    : config.CLAUDE_MODEL_MAIN;
}

function envDefaultFast(): string {
  return config.LLM_PROVIDER === 'openrouter'
    ? config.OPENROUTER_MODEL_FAST
    : config.CLAUDE_MODEL_FAST;
}

export async function getCurrentMainModel(): Promise<string> {
  try {
    const f = await factsRepo.getByKey('global', KEY_MAIN);
    const valor = f?.valor as { model?: unknown } | null | undefined;
    if (valor && typeof valor.model === 'string' && valor.model.length > 0) {
      return valor.model;
    }
  } catch {
    // DB hiccup: fall through to env default rather than block the LLM call.
  }
  return envDefaultMain();
}

export async function getCurrentFastModel(): Promise<string> {
  try {
    const f = await factsRepo.getByKey('global', KEY_FAST);
    const valor = f?.valor as { model?: unknown } | null | undefined;
    if (valor && typeof valor.model === 'string' && valor.model.length > 0) {
      return valor.model;
    }
  } catch {
    // ditto
  }
  return envDefaultFast();
}

export async function setCurrentMainModel(model: string): Promise<void> {
  await factsRepo.upsert({
    escopo: 'global',
    chave: KEY_MAIN,
    valor: { model },
    fonte: 'configurado',
    confianca: 1,
  });
}

export async function setCurrentFastModel(model: string): Promise<void> {
  await factsRepo.upsert({
    escopo: 'global',
    chave: KEY_FAST,
    valor: { model },
    fonte: 'configurado',
    confianca: 1,
  });
}

export function envDefaults(): { main: string; fast: string; provider: string } {
  return {
    main: envDefaultMain(),
    fast: envDefaultFast(),
    provider: config.LLM_PROVIDER,
  };
}
