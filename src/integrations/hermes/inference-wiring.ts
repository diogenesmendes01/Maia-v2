/**
 * P06 — liga a rota do gateway de inferência ao processo HTTP da Maia.
 *
 * Registrada SEMPRE. Não existe flag global que ligue o Hermes (decisão do
 * dono, INV-01): quem liga é a policy por tenant+agente+canal
 * (`agent_engine_policies`, K-15), e sem grant emitido a rota só recusa. O
 * provider é o da casa (OpenRouter, com a chave que o processo já tem); o filho
 * Hermes nunca vê essa chave — ele recebe só a credencial curta do run.
 *
 * Sem `OPENROUTER_API_KEY` a rota fica registrada e recusa ANTES da admissão
 * (`provider_unavailable`): sem tentativa, sem reserva, sem consumir o teto de
 * chamadas do run. Preço desconhecido é recusado pela admissão
 * (`unknown_price`).
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
  await registerHermesInferenceRoute(app, {
    allowed_sources,
    ledger: inferenceRepo,
    relay: config.OPENROUTER_API_KEY
      ? createChatCompletionsRelay({
          provider: 'openrouter',
          apiKey: config.OPENROUTER_API_KEY,
          baseURL: OPENROUTER_BASE_URL,
          defaultHeaders: {
            'HTTP-Referer': 'https://github.com/diogenesmendes01/Maia-v2',
            'X-OpenRouter-Title': 'Maia',
          },
        })
      : null,
    tariffFor: createCatalogTariff({
      async models() {
        const models = await getToolCallingModels();
        return { models, fallback: models === _internal.FALLBACK_TOOL_MODELS };
      },
    }),
    runInScope: runWithTenantContext,
  });
}
