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
import { counter, METRIC } from '@/observability/metrics.js';
import { estimateInputTokens, reserveBudget, settleReservation } from './budget.js';
import type { BudgetReservation } from './budget.js';
import {
  acquireCircuit,
  circuitOutcomeFor,
  peekCircuit,
  releaseCircuit,
} from './circuit-breaker.js';
import type { CircuitKey, CircuitState } from './circuit-breaker.js';
import { LLMGatewayError, classifyProviderError, isAbortError } from './errors.js';
import { resolveModelPair } from './model-resolver.js';
import { getProvider } from './providers/index.js';
import { currentScope, emitUsage, recordAttempt, statusForKind } from './telemetry.js';
import { workloadPolicy } from './workloads.js';
import type { LLMGatewayRequest, LLMResponse, LLMUsage, ResolvedModel } from './types.js';

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

/**
 * Evidência de consumo anexada a um erro de provider.
 *
 * Uma resposta que morre no meio (abort do caller, deadline, queda de conexão)
 * às vezes chega com `usage` parcial no erro do SDK. Quando chega, é a melhor
 * medida do que foi realmente gerado; quando não chega, o caller cobra só a
 * entrada — que o provider certamente contabilizou ao receber o prompt.
 */
function usageFromError(err: unknown): Partial<LLMUsage> | undefined {
  const usage = (err as { usage?: unknown })?.usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const { input_tokens, output_tokens } = usage as Partial<LLMUsage>;
  const out: Partial<LLMUsage> = {};
  if (typeof input_tokens === 'number' && input_tokens >= 0) out.input_tokens = input_tokens;
  if (typeof output_tokens === 'number' && output_tokens >= 0) out.output_tokens = output_tokens;
  return out.input_tokens === undefined && out.output_tokens === undefined ? undefined : out;
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
   * Deadline ABSOLUTO da chamada inteira: o MENOR entre o que o caller pediu e
   * o teto do operador.
   *
   * Duas correções distintas moram nesta linha.
   *
   * A primeira: a mecânica de deadline compartilhado existia desde o começo,
   * mas o campo era opcional e quase nenhum caller o passava — na prática o
   * gateway rodava com `Infinity`, e cada tentativa podia consumir o timeout
   * por requisição inteiro, mais backoff, mais fallback. Derivar de
   * `LLM_TURN_DEADLINE_MS` é o que torna o limite real para quem não declara.
   *
   * A segunda: derivar sozinho não bastava, porque um `deadline_at` explícito
   * no futuro distante passava por cima do orçamento configurado.
   * `LLM_TURN_DEADLINE_MS` é TETO, não default — declarar um deadline serve
   * para APERTAR o limite (é o que a issue #507 faz por turno), nunca para
   * afrouxá-lo. Daí o `Math.min`.
   */
  const deadlineCeiling = startedAt + config.LLM_TURN_DEADLINE_MS;
  const deadlineAt = Math.min(ctx.deadline_at ?? deadlineCeiling, deadlineCeiling);

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

  // (4) DISJUNTOR (issue #534). Se a janela recente de erros diz que este
  // `(provider, workload)` está fora, a chamada não acontece — sem tentativa,
  // sem backoff, sem fallback.
  //
  // A checagem precede a resolução de modelo e a reserva de cota de propósito:
  // uma chamada que não vai sair não deve carimbar orçamento nem gastar I/O de
  // Redis. É a leitura NÃO destrutiva; a sonda de half-open só é consumida na
  // tentativa de verdade, mais abaixo.
  const circuitKey: CircuitKey = { provider: provider.name, workload: req.workload };
  const circuitError = (state: string, retry_after_ms: number): LLMGatewayError =>
    new LLMGatewayError({
      kind: 'circuit_open',
      detail: `circuit ${state} for provider=${provider.name} workload=${req.workload}`,
      provider: provider.name,
      workload: req.workload,
      retry_after_ms,
    });

  /**
   * Gêmeo de sombra da recusa, contado UMA VEZ POR CHAMADA.
   *
   * Precisa ser aqui, e não dentro do disjuntor: em `enforce` a chamada morre
   * no primeiro `peek` e produz exatamente UM
   * `maia_llm_requests_total{status="circuit_open"}`. Em `shadow` a chamada
   * segue e passa por `acquireCircuit` mais N vezes (tentativas + fallback) —
   * contar lá dentro inflaria a sombra em ~4× num workload com retry e
   * destruiria a comparação, que é a única razão de a métrica existir.
   *
   * A emissão fica dentro do escopo do caller, então `counter()` anexa
   * `tenant_id + agent_id` do ALS: o estado do disjuntor é global, mas quem
   * teria comido a recusa continua atribuível — em sombra também.
   */
  let shadowCounted = false;
  const countWouldReject = (state: CircuitState): void => {
    if (shadowCounted) return;
    shadowCounted = true;
    counter(METRIC.LLM_CIRCUIT_WOULD_REJECT, {
      provider: provider.name,
      workload: req.workload,
      state,
    });
  };

  const peek = peekCircuit(circuitKey);
  if (peek.would_reject) countWouldReject(peek.state);
  if (!peek.allowed) {
    const err = circuitError(peek.state, peek.retry_after_ms);
    await emitUsage(
      {
        workload: req.workload,
        tier,
        provider: provider.name,
        model: 'unresolved',
        status: 'circuit_open',
        attempts: 0,
        duration_ms: Date.now() - startedAt,
        error_kind: 'circuit_open',
        pessoa_id: req.pessoa_id,
        trace_id: ctx.trace_id,
      },
      scope,
    );
    throw err;
  }

  // (5) Uma leitura de settings resolve primário E fallback. É leitura de
  // configuração, não I/O de provider — pode preceder a reserva de quota, e
  // precisa: a estimativa de custo depende do modelo escolhido.
  const { primary, fast } = await resolveModelPair(tier);

  // (6) RESERVA de orçamento — atômica, antes de qualquer I/O de provider.
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
   * Gasto ACUMULADO da chamada — soma de TODA tentativa que chegou ao
   * provider, não só da resposta final.
   *
   * Uma tentativa que falhou no meio já transmitiu o prompt: os tokens de
   * entrada foram consumidos e cobrados. Contabilizá-la como custo zero fazia
   * o gasto real divergir do contabilizado precisamente no retry storm — muitas
   * tentativas, poucas respostas — que é o cenário que a quota existe para
   * conter.
   */
  let spentUsd = 0;

  /** Tokens de entrada estimados uma vez: o payload não muda entre tentativas. */
  const estimatedInputTokens = estimateInputTokens(req.system, req.messages);

  /**
   * Cobra UMA tentativa enviada e liquida o acumulado.
   *
   * `usage` vem da resposta quando houve uma; num erro, alguns SDKs anexam
   * `usage` parcial (resposta que morreu no meio) — usamos quando existe. Sem
   * evidência de saída, cobra-se só a entrada, que é o que o provider
   * certamente contabilizou ao receber o prompt.
   */
  const chargeAttempt = async (model: string, usage?: Partial<LLMUsage>): Promise<void> => {
    const cost = await estimateLLMCostUsd({
      model,
      tokens_input: usage?.input_tokens ?? estimatedInputTokens,
      tokens_output: usage?.output_tokens ?? 0,
    }).catch(() => 0);
    spentUsd += cost;
    await settleReservation(reservation, spentUsd);
  };

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
    // Tentativa bem sucedida: cobra com o `usage` REAL da resposta.
    if (reservation.active) await chargeAttempt(resolved.model, res.usage);
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

      // Toda requisição que sai passa pelo disjuntor — tentativa primária,
      // retry e fallback. Reavaliar A CADA tentativa é o que impede uma chamada
      // já em voo de continuar gastando o que sobrou das tentativas depois que
      // o disjuntor abriu por causa do tráfego concorrente.
      const permit = acquireCircuit(circuitKey);
      if (permit.allowed && permit.would_reject) countWouldReject(permit.state);
      if (!permit.allowed) {
        const err = circuitError(permit.state, permit.retry_after_ms);
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
        releaseCircuit(permit, 'ok');
        recordAttempt(
          {
            provider: primary.provider,
            model: primary.model,
            workload: req.workload,
            outcome: 'ok',
          },
          scope,
        );
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
        // Deadline do TURNO não é evidência sobre o provider: quem estourou foi
        // o orçamento do caller. Só o que o SDK classificou como falha de
        // provider alimenta a janela do disjuntor.
        releaseCircuit(permit, link.deadlineFired() ? 'ignored' : circuitOutcomeFor(err.kind));
        recordAttempt(
          {
            provider: primary.provider,
            model: primary.model,
            workload: req.workload,
            outcome: err.kind,
          },
          scope,
        );
        // A tentativa CHEGOU ao provider (`provider.call()` foi executada), então
        // o prompt foi transmitido e a entrada foi cobrada — inclusive quando o
        // desfecho é abort ou timeout no meio do voo. Cobrar aqui é o que
        // impede o gasto real de divergir do contabilizado num retry storm.
        if (reservation.active) await chargeAttempt(primary.model, usageFromError(rawErr));

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

    // O fallback roda no MESMO provider (só troca o slug do modelo), então
    // compartilha o disjuntor de `(provider, workload)`. É o ponto do
    // exercício: era exatamente o fallback que continuava martelando um
    // provider já fora do ar depois das tentativas do primário.
    const fallbackPermit = acquireCircuit(circuitKey);
    if (fallbackPermit.allowed && fallbackPermit.would_reject) {
      countWouldReject(fallbackPermit.state);
    }
    if (!fallbackPermit.allowed) {
      const err = circuitError(fallbackPermit.state, fallbackPermit.retry_after_ms);
      await fail(fast, err);
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
        model: fast.model,
        signal: link.signal,
        timeout_ms: attemptTimeout(),
      });
      releaseCircuit(fallbackPermit, 'ok');
      recordAttempt(
        {
          provider: fast.provider,
          model: fast.model,
          workload: req.workload,
          outcome: 'ok',
        },
        scope,
      );
      return await finish(fast, res, primary.model);
    } catch (rawErr) {
      const err = link.deadlineFired()
        ? new LLMGatewayError({ kind: 'timeout', detail: 'deadline exceeded during fallback' })
        : classifyProviderError(rawErr, {
            provider: fast.provider,
            model: fast.model,
            workload: req.workload,
          });
      releaseCircuit(fallbackPermit, link.deadlineFired() ? 'ignored' : circuitOutcomeFor(err.kind));
      recordAttempt(
        {
          provider: fast.provider,
          model: fast.model,
          workload: req.workload,
          outcome: err.kind,
        },
        scope,
      );
      // O fallback também foi ENVIADO: soma sobre o que as tentativas do
      // primário já custaram, não substitui.
      if (reservation.active) await chargeAttempt(fast.model, usageFromError(rawErr));
      await fail(fast, err);
      // Um abort no fallback tem que vencer o erro do primário: mascarar o
      // cancelamento atrás do último 5xx rouba do caller o sinal de que ELE
      // cancelou (regressão fechada na PR #221, item 2).
      if (err.kind === 'aborted' || ctx.signal?.aborted) {
        throw isAbortError(rawErr) ? rawErr : err;
      }
      // O erro do FALLBACK é o que o caller precisa ver.
      //
      // Antes, este ramo lançava `lastError ?? err` — ou seja, o 5xx do
      // primário. Um fallback que devolve 401/403/400 é TERMINAL, mas o caller
      // recebia um erro retentável e podia insistir numa chave inválida ou num
      // payload malformado, gerando o retry externo que a camada única de
      // retry existe para evitar. Além de esconder a causa real do incidente.
      //
      // Quando o fallback também falha de forma transitória, o kind coincide e
      // a escolha é indiferente; quando diverge, o terminal manda.
      throw err;
    }
  } finally {
    link.dispose();
    // Liquidação final. `chargeAttempt` já liquidou por tentativa, então aqui
    // isto é no-op no caso comum — e é o que devolve a reserva INTEIRA quando
    // `spentUsd` é 0, ou seja, quando nenhuma requisição chegou a sair (abort
    // antes do primeiro envio). Sem esta linha, uma chamada que nunca gastou
    // deixaria a estimativa presa no contador e a quota encolheria a cada
    // recusa, que é justamente quando o retry storm começa.
    await settleReservation(reservation, spentUsd);
  }
}

export const _internal = { backoffMs, abortableSleep, linkSignal, BACKOFF_BASE_MS };
