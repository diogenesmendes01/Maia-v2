/**
 * LLM Gateway — a fronteira única de chamadas de modelo da Maia (issue #508).
 *
 * Tudo que era decidido em pontos diferentes do código passa a ser decidido
 * aqui, uma vez só:
 *
 *  - **Provider e modelo**: resolvidos pelo backend a partir de
 *    `workload + tier` (`model-resolver.ts`). O caller nunca passa slug.
 *  - **Deadline total**: um instante absoluto cobre espera de rate limit,
 *    tentativas, backoff, fallback e parsing. Cada tentativa recebe o tempo
 *    RESTANTE, nunca o timeout cheio de novo.
 *  - **Cancelamento**: o `AbortSignal` do caller chega à requisição HTTP do
 *    SDK, interrompe o backoff e impede nova tentativa.
 *  - **Retry**: uma única camada. O SDK tem `maxRetries: 0` nos adapters.
 *  - **Fallback**: controlado por política de workload, registrado
 *    explicitamente com origem, destino e razão.
 *  - **Telemetria e custo**: emitidos em TODO desfecho — sucesso, erro,
 *    timeout, rate limit e cancelamento.
 *
 * O que o gateway NÃO faz: autorizar nada. Ele transporta uma proposta do LLM;
 * quem decide continua sendo o backend (invariante "backend decide, LLM
 * propõe").
 */
import { config } from '@/config/env.js';
import { estimateLLMCostUsd } from '@/lib/cost-ledger.js';
import { reserveBudget, settleReservation } from './budget.js';
import type { BudgetReservation } from './budget.js';
import { LLMGatewayError, classifyProviderError, isAbortError } from './errors.js';
import { resolveModelPair } from './model-resolver.js';
import { getProvider } from './providers/index.js';
import { currentScope, emitUsage, recordAttempt, statusForKind } from './telemetry.js';
import { workloadPolicy } from './workloads.js';
import type { LLMGatewayRequest, LLMResponse, ResolvedModel } from './types.js';

/** Base do backoff exponencial, herdada do comportamento pré-#508. */
const BACKOFF_BASE_MS = 2000;

/**
 * Sinal efetivo da chamada.
 *
 * Quando NÃO há deadline, devolvemos o próprio sinal do caller por
 * IDENTIDADE. Isso não é detalhe cosmético: é o que garante que o
 * cancelamento chega ao SDK como o mesmo objeto que o caller controla, sem
 * uma camada de indireção que possa vazar listeners.
 */
type SignalLink = {
  signal?: AbortSignal;
  deadlineFired: () => boolean;
  dispose: () => void;
};

function linkSignal(caller: AbortSignal | undefined, deadlineAt: number | undefined): SignalLink {
  if (deadlineAt === undefined) {
    return { signal: caller, deadlineFired: () => false, dispose: () => undefined };
  }
  const controller = new AbortController();
  let fired = false;
  const remaining = Math.max(0, deadlineAt - Date.now());
  const timer = setTimeout(() => {
    fired = true;
    controller.abort('llm_deadline_exceeded');
  }, remaining);
  const onCallerAbort = (): void => controller.abort(caller?.reason);
  if (caller) {
    if (caller.aborted) controller.abort(caller.reason);
    else caller.addEventListener('abort', onCallerAbort, { once: true });
  }
  return {
    signal: controller.signal,
    deadlineFired: () => fired,
    dispose: () => {
      clearTimeout(timer);
      if (caller) caller.removeEventListener('abort', onCallerAbort);
    },
  };
}

/**
 * Sleep abortável. Abortar durante o backoff precisa curto-circuitar o timer,
 * não esperá-lo terminar — senão o cancelamento do turno chega até 2×
 * `BACKOFF_BASE_MS` atrasado (regressão fechada na issue #220).
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortedError());
      return;
    }
    let onAbort: (() => void) | null = null;
    const timer = setTimeout(() => {
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        reject(abortedError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * O detalhe `llm_call_aborted` é o token histórico que callers e testes
 * pré-#508 casavam por substring. Mantido de propósito para não quebrar
 * contrato de erro durante a migração.
 */
function abortedError(): LLMGatewayError {
  // `signal.reason` NÃO entra: é valor arbitrário do caller e já foi vetor de
  // vazamento em outros sistemas. O kind já diz tudo que o operador precisa.
  return new LLMGatewayError({ kind: 'aborted', detail: 'llm_call_aborted' });
}

/** Backoff exponencial com jitter para baixo (50%–100% da janela nominal). */
function backoffMs(attemptIndex: number): number {
  const nominal = BACKOFF_BASE_MS * Math.pow(2, attemptIndex);
  return Math.round(nominal * (0.5 + Math.random() * 0.5));
}

export async function executeLLM(req: LLMGatewayRequest): Promise<LLMResponse> {
  const startedAt = Date.now();
  const ctx = req.ctx ?? {};
  const policy = workloadPolicy(req.workload);
  const tier = req.tier ?? policy.default_tier;
  const scope = currentScope();

  /**
   * Deadline ABSOLUTO da chamada inteira. Quando o caller não declara um, o
   * gateway DERIVA um a partir de `LLM_TURN_DEADLINE_MS`.
   *
   * A mecânica de deadline compartilhado existia desde a primeira versão, mas
   * o campo era opcional e quase nenhum caller o passava — na prática o
   * gateway rodava com `Infinity`, e cada tentativa podia consumir o timeout
   * por requisição inteiro, mais backoff, mais fallback. Ou seja: o mecanismo
   * certo, nunca acionado. Derivar aqui é o que torna o limite real para o
   * caller que não declara nada; a issue #507 continua podendo passar um
   * deadline mais apertado, e o gateway sempre usa o menor tempo restante.
   */
  const deadlineAt = ctx.deadline_at ?? startedAt + config.LLM_TURN_DEADLINE_MS;

  // (1) Cancelamento antecipado: um caller que já abortou não paga nem pela
  // leitura de settings. Precede QUALQUER I/O.
  if (ctx.signal?.aborted) throw abortedError();
  if (deadlineAt <= Date.now()) {
    throw new LLMGatewayError({
      kind: 'timeout',
      detail: 'deadline exceeded before first attempt',
      workload: req.workload,
    });
  }

  const provider = getProvider();

  // (2) Fail-closed de ISOLAMENTO. Uma chamada de LLM é sempre atribuível: ela
  // gasta dinheiro do tenant, consome a quota dele e produz evidência que
  // precisa ser correlacionada com ele. Sem `tenant_id + agent_id` no ALS não
  // há quota a reservar, não há custo a atribuir e não há métrica a rotular —
  // então a chamada não acontece.
  //
  // Antes desta correção o gateway seguia com `scope=null` e o orçamento
  // simplesmente não era avaliado: bastava perder o contexto para escapar da
  // cota. Contexto ausente-por-omissão não é um modo de operação válido.
  //
  // Trabalho genuinamente global (backup, GC, sondas) já tem endereço
  // explícito e tipado: `runWithSystemContext()` em `src/db/tenant-context.ts`,
  // que abre o contexto reservado `system`/`system`. É opt-in declarado, não
  // ausência.
  if (!scope) {
    const err = new LLMGatewayError({
      kind: 'missing_tenant_context',
      detail:
        'LLM call requires tenant_id + agent_id in the ALS — wrap the caller in ' +
        'runWithTenantContext(), or runWithSystemContext() for genuinely global work',
      provider: provider.name,
      workload: req.workload,
    });
    await emitUsage(
      {
        workload: req.workload,
        tier,
        provider: provider.name,
        model: 'unresolved',
        status: 'error',
        attempts: 0,
        duration_ms: Date.now() - startedAt,
        error_kind: 'missing_tenant_context',
        pessoa_id: req.pessoa_id,
        trace_id: ctx.trace_id,
      },
      scope,
    );
    throw err;
  }

  // (3) Fail-closed de configuração: sem a chave do provider ATIVO não há
  // chamada. Isto é o que faz `LLM_PROVIDER=openrouter` deixar de exigir
  // ANTHROPIC_API_KEY nos módulos migrados.
  if (!provider.isConfigured()) {
    const err = new LLMGatewayError({
      kind: 'configuration',
      detail: `missing API key for provider=${provider.name}`,
      provider: provider.name,
      workload: req.workload,
    });
    await emitUsage(
      {
        workload: req.workload,
        tier,
        provider: provider.name,
        model: 'unresolved',
        status: 'error',
        attempts: 0,
        duration_ms: Date.now() - startedAt,
        error_kind: 'configuration',
        pessoa_id: req.pessoa_id,
        trace_id: ctx.trace_id,
      },
      scope,
    );
    throw err;
  }

  // (4) Uma leitura de settings resolve primário E fallback. É leitura de
  // configuração, não I/O de provider — pode preceder a reserva de quota, e
  // precisa: a estimativa de custo depende do modelo escolhido.
  const { primary, fast } = await resolveModelPair(tier);

  // (5) RESERVA de orçamento — atômica, antes de qualquer I/O de provider.
  // Não é uma checagem: o contador é incrementado com a estimativa e só então
  // comparado, para que chamadas concorrentes nunca decidam sobre o mesmo
  // número. A diferença para o custo real é liquidada no `finally`.
  let reservation: BudgetReservation = { key: '', reserved_usd: 0, active: false };
  try {
    reservation = await reserveBudget({
      scope,
      workload: req.workload,
      model: primary.model,
      system: req.system,
      messages: req.messages,
      max_tokens: req.max_tokens,
    });
  } catch (budgetErr) {
    const err =
      budgetErr instanceof LLMGatewayError
        ? budgetErr
        : new LLMGatewayError({ kind: 'budget_exhausted', detail: 'budget reservation failed' });
    await emitUsage(
      {
        workload: req.workload,
        tier,
        provider: provider.name,
        model: primary.model,
        status: 'budget_exhausted',
        attempts: 0,
        duration_ms: Date.now() - startedAt,
        error_kind: 'budget_exhausted',
        pessoa_id: req.pessoa_id,
        trace_id: ctx.trace_id,
      },
      scope,
    );
    throw err;
  }

  /**
   * Custo REAL da chamada bem sucedida, ou `null` se nenhuma chamada gastou.
   * Liquidado contra a reserva no `finally` — devolvendo a diferença (que
   * costuma ser negativa, já que a reserva assume `max_tokens` de saída).
   */
  let actualCostUsd: number | null = null;

  const link = linkSignal(ctx.signal, deadlineAt);
  const maxAttempts = Math.max(1, policy.max_attempts ?? config.CLAUDE_MAX_RETRIES);
  let attempts = 0;
  let lastError: LLMGatewayError | null = null;
  let lastRawError: unknown = null;

  /** Sempre finito: o deadline é derivado quando o caller não declara um. */
  const remainingMs = (): number => deadlineAt - Date.now();

  /**
   * Teto por tentativa: o menor entre `CLAUDE_TIMEOUT_MS` e o que sobrou do
   * deadline. Antes da #508, `CLAUDE_TIMEOUT_MS` existia em `src/config/env.ts`
   * sem nenhum consumidor no hot path — este é o consumidor.
   */
  const attemptTimeout = (): number =>
    Math.max(1, Math.min(config.CLAUDE_TIMEOUT_MS, remainingMs()));

  const finish = async (
    resolved: ResolvedModel,
    res: LLMResponse,
    fallbackFrom?: string,
  ): Promise<LLMResponse> => {
    // Custo REAL da resposta, pela mesma tabela de preços do ledger. Só é
    // calculado quando há reserva ativa — com a quota desligada, nada a
    // liquidar (e nada a importar).
    if (reservation.active) {
      actualCostUsd = await estimateLLMCostUsd({
        model: resolved.model,
        tokens_input: res.usage.input_tokens,
        tokens_output: res.usage.output_tokens,
      }).catch(() => null);
    }
    await emitUsage(
      {
        workload: req.workload,
        tier: resolved.tier,
        provider: resolved.provider,
        model: resolved.model,
        status: 'ok',
        attempts,
        duration_ms: Date.now() - startedAt,
        usage: res.usage,
        fallback_from: fallbackFrom,
        fallback_reason: fallbackFrom ? 'primary_exhausted' : undefined,
        pessoa_id: req.pessoa_id,
        trace_id: ctx.trace_id,
      },
      scope,
    );
    // O gasto que acabou de acontecer torna o número cacheado do orçamento
    // obsoleto; soltar aqui é o que impede a quota de ficar sempre um passo
    // atrás durante uma rajada.
    return res;
  };

  const fail = async (resolved: ResolvedModel, err: LLMGatewayError): Promise<void> => {
    await emitUsage(
      {
        workload: req.workload,
        tier: resolved.tier,
        provider: resolved.provider,
        model: resolved.model,
        status: statusForKind(err.kind),
        attempts,
        duration_ms: Date.now() - startedAt,
        error_kind: err.kind,
        pessoa_id: req.pessoa_id,
        trace_id: ctx.trace_id,
      },
      scope,
    );
  };

  try {
    for (let i = 0; i < maxAttempts; i++) {
      if (ctx.signal?.aborted) {
        const err = abortedError();
        await fail(primary, err);
        throw err;
      }
      if (remainingMs() <= 0) {
        const err = new LLMGatewayError({ kind: 'timeout', detail: 'deadline exceeded' });
        await fail(primary, err);
        throw err;
      }

      attempts++;
      try {
        const res = await provider.call({
          system: req.system,
          messages: req.messages,
          tools: req.tools,
          temperature: req.temperature,
          max_tokens: req.max_tokens,
          model: primary.model,
          signal: link.signal,
          timeout_ms: attemptTimeout(),
        });
        recordAttempt({
          provider: primary.provider,
          model: primary.model,
          workload: req.workload,
          outcome: 'ok',
        });
        return await finish(primary, res);
      } catch (rawErr) {
        // Deadline que disparou aparece no SDK como abort — reclassificamos
        // para timeout, senão o operador vê "cancelado pelo usuário" quando
        // na verdade o orçamento do turno acabou.
        const err = link.deadlineFired()
          ? new LLMGatewayError({ kind: 'timeout', detail: 'deadline exceeded mid-flight' })
          : classifyProviderError(rawErr, {
              provider: primary.provider,
              model: primary.model,
              workload: req.workload,
            });
        lastError = err;
        lastRawError = rawErr;
        recordAttempt({
          provider: primary.provider,
          model: primary.model,
          workload: req.workload,
          outcome: err.kind,
        });

        // Cancelamento NUNCA é retentável e nunca é reportado como erro de
        // provider. Repassamos o erro original quando ele veio do SDK para
        // preservar `name === 'AbortError'` para quem casa por nome.
        if (err.kind === 'aborted' || ctx.signal?.aborted) {
          await fail(primary, err);
          throw isAbortError(rawErr) ? rawErr : err;
        }
        if (err.kind === 'timeout') {
          await fail(primary, err);
          throw err;
        }
        if (!err.retryable) break;
        if (i >= maxAttempts - 1) break;

        // `Retry-After` do provider vence o backoff local quando presente.
        const delay = err.retry_after_ms ?? backoffMs(i);
        if (delay >= remainingMs()) {
          const timeoutErr = new LLMGatewayError({
            kind: 'timeout',
            detail: 'deadline would elapse during backoff',
          });
          await fail(primary, timeoutErr);
          throw timeoutErr;
        }
        try {
          await abortableSleep(delay, link.signal ?? ctx.signal);
        } catch (sleepErr) {
          // Abortou durante o backoff: ainda é um desfecho da chamada e
          // precisa aparecer em `maia_llm_cancelled_total`.
          const aborted =
            sleepErr instanceof LLMGatewayError ? sleepErr : abortedError();
          await fail(primary, aborted);
          throw aborted;
        }
      }
    }

    // --- fallback controlado -------------------------------------------
    const canFallback =
      policy.allow_fast_fallback &&
      fast.model !== primary.model &&
      lastError !== null &&
      lastError.retryable &&
      !ctx.signal?.aborted &&
      remainingMs() > 0;

    if (!canFallback) {
      const err = lastError ?? new LLMGatewayError({ kind: 'network', detail: 'no attempt made' });
      await fail(primary, err);
      throw isAbortError(lastRawError) ? lastRawError : err;
    }

    attempts++;
    try {
      const res = await provider.call({
        system: req.system,
        messages: req.messages,
        tools: req.tools,
        temperature: req.temperature,
        max_tokens: req.max_tokens,
        model: fast.model,
        signal: link.signal,
        timeout_ms: attemptTimeout(),
      });
      recordAttempt({
        provider: fast.provider,
        model: fast.model,
        workload: req.workload,
        outcome: 'ok',
      });
      return await finish(fast, res, primary.model);
    } catch (rawErr) {
      const err = link.deadlineFired()
        ? new LLMGatewayError({ kind: 'timeout', detail: 'deadline exceeded during fallback' })
        : classifyProviderError(rawErr, {
            provider: fast.provider,
            model: fast.model,
            workload: req.workload,
          });
      recordAttempt({
        provider: fast.provider,
        model: fast.model,
        workload: req.workload,
        outcome: err.kind,
      });
      await fail(fast, err);
      // Um abort no fallback tem que vencer o erro do primário: mascarar o
      // cancelamento atrás do último 5xx rouba do caller o sinal de que ELE
      // cancelou (regressão fechada na PR #221, item 2).
      if (err.kind === 'aborted' || ctx.signal?.aborted) {
        throw isAbortError(rawErr) ? rawErr : err;
      }
      throw lastError ?? err;
    }
  } finally {
    link.dispose();
    // Liquida SEMPRE — sucesso, erro, timeout ou cancelamento. Sem isto, uma
    // chamada que falhou deixaria a estimativa presa no contador e a quota
    // encolheria a cada falha, que é justamente quando o retry storm começa.
    await settleReservation(reservation, actualCostUsd ?? 0);
  }
}

export const _internal = { backoffMs, abortableSleep, linkSignal, BACKOFF_BASE_MS };
