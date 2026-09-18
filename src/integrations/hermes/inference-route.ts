/**
 * P06 (spec §9.1, §9.2; K-09; T18) — a ROTA do gateway de inferência:
 * `POST /internal/hermes-inference/v1/chat/completions`.
 *
 * É o único HTTP que o filho Hermes pode fazer. A ordem do handler é a do
 * §9.1, e cada passo fecha antes do seguinte:
 *
 *  1. rede interna, sem proxy — senão 404 antes de ler o corpo;
 *  2. credencial → grant pela HASH, sem tenant; depois o ALS do grant;
 *  3. contrato do pedido (`parseInferenceRequest`), superfície por nome E
 *     schema, teto de saída;
 *  4. autoridade do run (fase, revogação, controle humano, epoch, prazo);
 *  5. admissão com reserva numa TX (repositório), ANTES do provider;
 *  6. relay sem TX, uma tentativa;
 *  7. resposta projetada e validada (tools filtradas) → liquidação → filho.
 *
 * ─── Erros ─────────────────────────────────────────────────────────────────
 *
 * Só `toWireError(código)`: nada de run, tenant, modelo ou motivo no corpo.
 * Recusa de política/autoridade/quota é TERMINAL para o run (§9.1 item 10), e
 * vai com `x-should-retry: false` — o SDK do filho repete 409/429/5xx por
 * default, e repetir uma recusa de política seria o "incentivo" que a spec
 * proíbe. Só `503` pode ser repetido: cada repetição é uma tentativa nova que
 * passa de novo pela admissão.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ChatCompletionsRelayV1 } from '@/lib/llm/providers/chat-completions-relay.js';
import type {
  AdmitAttemptResult,
  InferenceGrantStateV1,
  SettleAttemptResult,
  SettleOutcomeV1,
} from '@/db/repositories/inference-repos.js';
import { canonicalDigest } from './canonical-json.js';
import type { AdmissionPolicyV1 } from './cost-reservation.js';
import {
  INFERENCE_GRANT_AUDIENCE,
  bearerTokenOf,
  hashInferenceToken,
  isWellFormedInferenceToken,
} from './inference-credential.js';
import {
  checkRequestSurface,
  costFromUsage,
  enforceOutputCap,
  estimateExposureMicrousd,
  inputTokensUpperBound,
  isInternalRequest,
  projectChatCompletion,
  renderChatCompletionSse,
  type InferenceTariffV1,
} from './inference-flow.js';
import {
  INFERENCE_GATEWAY_COMPLETIONS_PATH,
  INFERENCE_LIMITS,
  parseInferenceRequest,
  parseInferenceResponse,
  toWireError,
  validateInferenceGrant,
  type InferenceErrorCode,
  type InferenceUsageObservedV1,
} from './inference-gateway.js';

/** O ledger visto pela rota. Implementado por `inferenceRepo`. */
export interface InferenceLedgerPortV1 {
  resolveGrantScope(
    token_hash: string,
  ): Promise<{ grant_id: string; tenant_id: string; agent_id: string } | null>;
  loadGrantState(grant_id: string): Promise<InferenceGrantStateV1 | null>;
  admitAttempt(input: {
    grant_id: string;
    attempt_id: string;
    request_hash: string;
    provider: string;
    presented_audience: string;
    model_requested: string;
    tool_names_requested: readonly string[];
    estimate_microusd: string | null;
    tariff_version: string | null;
    policy: AdmissionPolicyV1;
  }): Promise<AdmitAttemptResult>;
  settleAttempt(input: { attempt_id: string; outcome: SettleOutcomeV1 }): Promise<SettleAttemptResult>;
}

export interface InferenceRouteDepsV1 {
  ledger: InferenceLedgerPortV1;
  relay: ChatCompletionsRelayV1;
  /** Tarifa versionada do modelo aprovado. `null` = sem preço verificável. */
  tariffFor(model: string): Promise<InferenceTariffV1 | null>;
  policy: AdmissionPolicyV1;
  /** `runWithTenantContext`, injetado para a rota não depender do ALS global. */
  runInScope<T>(scope: { tenant_id: string; agent_id: string }, fn: () => Promise<T>): Promise<T>;
  now?: () => number;
  /**
   * O worker pede inferência logo depois do `ready`, e o run só vira
   * `running` quando o dono grava o aceite. Esta é a espera curta por isso;
   * vencida, é `run_not_active` terminal.
   */
  running_wait_ms?: number;
  poll_ms?: number;
}

const WAITS_FOR_RUNNING = new Set(['submitting', 'submission_unknown']);

function sendError(reply: FastifyReply, code: InferenceErrorCode): FastifyReply {
  const e = toWireError(code);
  if (e.status !== 503) reply.header('x-should-retry', 'false');
  return reply.code(e.status).type('application/json').send(e.body);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function registerHermesInferenceRoute(
  app: FastifyInstance,
  deps: InferenceRouteDepsV1,
): Promise<void> {
  const now = deps.now ?? Date.now;
  const runningWaitMs = deps.running_wait_ms ?? 3_000;
  const pollMs = deps.poll_ms ?? 100;

  await app.register(async (scope) => {
    // Rota não pública: some ANTES de o corpo ser lido.
    scope.addHook('onRequest', async (req, reply) => {
      if (!isInternalRequest({ remote_address: req.socket.remoteAddress, headers: req.headers })) {
        return reply.code(404).send();
      }
    });

    // Erros de parse do Fastify viram o vocabulário do §9.1, sanitizado.
    scope.setErrorHandler((err: { code?: string; statusCode?: number }, _req, reply) => {
      if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return sendError(reply, 'payload_too_large');
      if (typeof err.code === 'string' && err.code.startsWith('FST_ERR_CTP_')) {
        return sendError(reply, 'invalid_request');
      }
      if (err.statusCode === 429) return sendError(reply, 'inference_limit_exceeded');
      return sendError(reply, 'admission_unavailable');
    });

    scope.post(
      INFERENCE_GATEWAY_COMPLETIONS_PATH,
      {
        // O teto exato é do `parseInferenceRequest`; aqui só impede o Fastify de
        // acumular além disso com espaço em branco.
        bodyLimit: INFERENCE_LIMITS.max_total_bytes * 2,
        config: { rateLimit: false },
      },
      async (req, reply) => {
        const token = bearerTokenOf(req.headers.authorization);
        if (token === null || !isWellFormedInferenceToken(token)) {
          return sendError(reply, 'invalid_inference_grant');
        }
        let grantScope: Awaited<ReturnType<InferenceLedgerPortV1['resolveGrantScope']>>;
        try {
          grantScope = await deps.ledger.resolveGrantScope(hashInferenceToken(token));
        } catch {
          return sendError(reply, 'admission_unavailable');
        }
        if (grantScope === null) return sendError(reply, 'invalid_inference_grant');
        const { grant_id } = grantScope;

        return deps.runInScope(
          { tenant_id: grantScope.tenant_id, agent_id: grantScope.agent_id },
          async () => {
            const parsed = parseInferenceRequest(req.body);
            if (parsed.kind !== 'ok') return sendError(reply, parsed.code);
            const request = parsed.request;

            const load = async (): Promise<InferenceGrantStateV1 | null | 'error'> => {
              try {
                return await deps.ledger.loadGrantState(grant_id);
              } catch {
                return 'error';
              }
            };
            let state = await load();
            const limite = now() + runningWaitMs;
            while (state !== null && state !== 'error' && WAITS_FOR_RUNNING.has(state.run_phase)) {
              if (now() >= limite) break;
              await sleep(pollMs);
              state = await load();
            }
            if (state === 'error') return sendError(reply, 'admission_unavailable');
            if (state === null) return sendError(reply, 'invalid_inference_grant');

            const tool_names = (request.tools ?? []).map((t) => t.function.name);
            // Pré-checagem sem lock: recusa cedo o que a admissão recusaria.
            const v = validateInferenceGrant(state.grant, {
              presented_audience: INFERENCE_GRANT_AUDIENCE,
              now: state.now,
              run_phase: state.run_phase,
              calls_so_far: state.calls_so_far,
              model_requested: request.model,
              manifest_digest_effective: state.run_manifest_digest,
              tool_names_requested: tool_names,
            });
            if (v.kind === 'refused') return sendError(reply, v.code);
            // Posse do turno (claim/lease/tentativa) e controle humano/epoch.
            if (state.owner === 'stale_claim') return sendError(reply, 'run_revoked');
            if (state.owner === 'turn_not_running') return sendError(reply, 'run_not_active');
            if (!state.control_ok) return sendError(reply, 'run_revoked');
            if (Date.parse(state.now) >= Date.parse(state.run_deadline_at)) {
              return sendError(reply, 'run_not_active');
            }
            if (!checkRequestSurface(request, state.tool_surface).ok) {
              return sendError(reply, 'tool_surface_mismatch');
            }
            const cap = enforceOutputCap(request, state.max_output_tokens);
            if (!cap.ok) return sendError(reply, 'invalid_request');

            let tariff: InferenceTariffV1 | null;
            try {
              tariff = await deps.tariffFor(request.model);
            } catch {
              tariff = null;
            }
            let estimate: string | null;
            try {
              estimate = estimateExposureMicrousd(
                inputTokensUpperBound(request),
                cap.max_tokens,
                tariff,
              );
            } catch {
              // Tarifa fora do formato é tarifa desconhecida: a policy decide.
              tariff = null;
              estimate = null;
            }

            const forward = { ...request, max_tokens: cap.max_tokens };
            const attempt_id = randomUUID();
            let admitted: AdmitAttemptResult;
            try {
              admitted = await deps.ledger.admitAttempt({
                grant_id,
                attempt_id,
                request_hash: canonicalDigest(forward),
                provider: deps.relay.provider,
                presented_audience: INFERENCE_GRANT_AUDIENCE,
                model_requested: request.model,
                tool_names_requested: tool_names,
                estimate_microusd: estimate,
                tariff_version: tariff?.version ?? null,
                policy: deps.policy,
              });
            } catch {
              return sendError(reply, 'admission_unavailable');
            }
            if (!admitted.ok) return sendError(reply, admitted.code);

            const settle = async (outcome: SettleOutcomeV1): Promise<void> => {
              try {
                await deps.ledger.settleAttempt({ attempt_id, outcome });
              } catch {
                // A tentativa fica `reserved`: exposição, não custo zero.
              }
            };

            // Prazo restante do run; o filho desconectar também corta o upstream.
            const ac = new AbortController();
            const onClose = (): void => {
              if (!reply.raw.writableEnded) ac.abort();
            };
            req.raw.once('close', onClose);
            const remaining = Math.max(1, Date.parse(state.run_deadline_at) - now());
            const out = await deps.relay.relay(forward, { signal: ac.signal, timeout_ms: remaining });
            req.raw.off('close', onClose);

            if (out.kind === 'not_sent') {
              await settle({ kind: 'not_sent', error_code: out.code });
              return sendError(reply, 'provider_unavailable');
            }
            if (out.kind === 'failed_after_send') {
              await settle({ kind: 'failed_after_send', error_code: out.code });
              return sendError(reply, 'provider_unavailable');
            }

            const projected = projectChatCompletion(out.raw);
            const response = parseInferenceResponse(projected, state.grant.allowed_tool_names);
            const usage: InferenceUsageObservedV1 | null =
              response.kind === 'ok'
                ? response.response.usage
                : ((projected as { usage?: InferenceUsageObservedV1 }).usage ?? null);
            let cost: string | null;
            try {
              cost = costFromUsage(usage, tariff);
            } catch {
              cost = null;
            }
            await settle({
              kind: 'completed',
              prompt_tokens: usage?.prompt_tokens ?? null,
              completion_tokens: usage?.completion_tokens ?? null,
              cost_microusd: cost,
              source: cost === null ? 'unavailable' : 'gateway_estimated',
            });
            // Resposta com tool fora da superfície, ou fora do contrato, não
            // chega ao filho — foi paga, e fica registrada como paga.
            if (response.kind !== 'ok') return sendError(reply, response.code);

            if (request.stream === true) {
              return reply
                .code(200)
                .header('content-type', 'text/event-stream')
                .header('cache-control', 'no-cache')
                .send(
                  renderChatCompletionSse(
                    response.response,
                    request.stream_options?.include_usage === true,
                  ),
                );
            }
            const { usage: u, ...rest } = response.response;
            return reply.code(200).send(u === null ? rest : { ...rest, usage: u });
          },
        );
      },
    );
  });
}
