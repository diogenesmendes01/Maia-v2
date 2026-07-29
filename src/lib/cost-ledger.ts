import { sql } from 'drizzle-orm';
import { factsRepo } from '@/db/repositories.js';
import { db } from '@/db/client.js';
import { getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';
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

/**
 * Custo em USD de uma chamada, pela MESMA tabela de preços que o ledger usa
 * para registrar o gasto real (issue #508).
 *
 * Exportado para que a reserva de orçamento (`src/lib/llm/budget.ts`) estime
 * o custo ANTES da chamada com a mesma aritmética que vai liquidá-la depois —
 * duas tabelas de preço divergentes fariam a quota reservar um valor e cobrar
 * outro.
 */
export async function estimateLLMCostUsd(input: {
  model: string;
  tokens_input: number;
  tokens_output: number;
}): Promise<number> {
  const rate = await rateFor(input.model);
  const usd_cents =
    (input.tokens_input / 1000) * rate.input + (input.tokens_output / 1000) * rate.output;
  return usd_cents / 100;
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

/**
 * Acumula o delta no fact de custo com UM statement atômico (issue #508,
 * review rodada 2).
 *
 * O que havia antes: `getByKey` → somar em JS → `upsert` com o total ABSOLUTO.
 * Read-modify-write. Duas chamadas concorrentes liam o mesmo acumulado e a
 * segunda sobrescrevia o incremento da primeira — subcontagem silenciosa,
 * pior sob concorrência, que é exatamente quando o custo importa. A quota já
 * não depende mais disto (a admissão é o contador atômico em Redis), mas este
 * fact é a contabilidade histórica que o dashboard e o alerta de gasto leem.
 *
 * A soma agora acontece DENTRO do `ON CONFLICT DO UPDATE`, lendo
 * `agent_facts.valor` (a linha travada pelo próprio upsert) em vez de um valor
 * lido antes. Não exigiu migration: o índice único
 * `(tenant_id, agent_id, escopo, chave)` já existe desde a migração 018, e é
 * ele o conflict target.
 *
 * `usd_cents` é somado como `numeric` (não float) e arredondado a 2 casas, o
 * mesmo contrato de antes.
 */
async function upsertCostFact(args: {
  escopo: string;
  chave: string;
  delta: { tokens_input: number; tokens_output: number; usd_cents: number };
  provider: string;
  model: string;
}): Promise<void> {
  // Escopo explícito: este caminho não passa por `applyTenantGuard`, então os
  // ids do ALS entram como parâmetros — e `getCurrent*` falha fechado quando
  // não há contexto, que é o comportamento desejado num write tenant-scoped.
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();

  const seed = {
    tokens_input: args.delta.tokens_input,
    tokens_output: args.delta.tokens_output,
    usd_cents: Math.round(args.delta.usd_cents * 100) / 100,
    provider: args.provider,
    last_model: args.model,
  };

  await db.execute(sql`
    INSERT INTO agent_facts (tenant_id, agent_id, escopo, chave, valor, fonte, confianca)
    VALUES (
      ${tenant_id}, ${agent_id}, ${args.escopo}, ${args.chave},
      ${JSON.stringify(seed)}::jsonb, 'inferido', 1
    )
    ON CONFLICT (tenant_id, agent_id, escopo, chave) DO UPDATE SET
      valor = jsonb_build_object(
        'tokens_input',
          COALESCE((agent_facts.valor->>'tokens_input')::numeric, 0) + ${args.delta.tokens_input}::numeric,
        'tokens_output',
          COALESCE((agent_facts.valor->>'tokens_output')::numeric, 0) + ${args.delta.tokens_output}::numeric,
        'usd_cents',
          ROUND(COALESCE((agent_facts.valor->>'usd_cents')::numeric, 0) + ${args.delta.usd_cents}::numeric, 2),
        'provider', ${args.provider}::text,
        'last_model', ${args.model}::text
      ),
      fonte = 'inferido',
      updated_at = now()
  `);
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
