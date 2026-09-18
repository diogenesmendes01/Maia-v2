/**
 * P06 — liga a rota do gateway de inferência ao processo HTTP da Maia.
 *
 * Só é importado por `buildServer()` quando `MAIA_HERMES_ENABLED=true`: com a
 * flag desligada nada disto entra no grafo do servidor. O provider é o da casa
 * (OpenRouter, com a chave que o processo já tem); o filho Hermes nunca vê
 * essa chave — ele recebe só a credencial curta do run.
 *
 * A policy de preço desconhecido é `deny`: sem tarifa verificável, o teto duro
 * não existe, e a admissão não finge que existe.
 */
import type { FastifyInstance } from 'fastify';
import { config } from '@/config/env.js';
import { inferenceRepo } from '@/db/repositories/inference-repos.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { createChatCompletionsRelay } from '@/lib/llm/providers/chat-completions-relay.js';
import { _internal, getToolCallingModels } from '@/lib/openrouter-models.js';
import { parseSourceAllowlist } from './inference-flow.js';
import { registerHermesInferenceRoute } from './inference-route.js';
import { createCatalogTariff } from './inference-tariff.js';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export async function registerHermesInferenceGateway(app: FastifyInstance): Promise<void> {
  // Allowlist ilegível derruba o boot: uma regra descartada em silêncio mudaria
  // quem pode chamar a rota sem ninguém ter decidido.
  const allowed_sources = parseSourceAllowlist(config.MAIA_HERMES_INFERENCE_ALLOWED_SOURCES);
  if (allowed_sources === null) {
    throw new Error('MAIA_HERMES_INFERENCE_ALLOWED_SOURCES inválida');
  }
  // Ligado sem provider é incompleto (§9.3): falha no boot, não em cada turno
  // gastando o teto de chamadas do run com 503.
  if (!config.OPENROUTER_API_KEY) {
    throw new Error('MAIA_HERMES_ENABLED=true exige OPENROUTER_API_KEY');
  }
  await registerHermesInferenceRoute(app, {
    allowed_sources,
    ledger: inferenceRepo,
    relay: createChatCompletionsRelay({
      provider: 'openrouter',
      apiKey: config.OPENROUTER_API_KEY,
      baseURL: OPENROUTER_BASE_URL,
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/diogenesmendes01/Maia-v2',
        'X-OpenRouter-Title': 'Maia',
      },
    }),
    tariffFor: createCatalogTariff({
      async models() {
        const models = await getToolCallingModels();
        return { models, fallback: models === _internal.FALLBACK_TOOL_MODELS };
      },
    }),
    policy: { on_unpriced: 'deny' },
    runInScope: runWithTenantContext,
  });
}
