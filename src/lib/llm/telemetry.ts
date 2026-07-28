/**
 * Telemetria única do LLM Gateway (issue #508).
 *
 * Antes desta issue, métrica e custo eram registrados DENTRO de cada adapter
 * e só no caminho de sucesso: toda chamada direta ao SDK (drift, role
 * selector, risk gate, visão, …) ficava fora da contabilidade, e erro /
 * timeout / rate limit / cancelamento não incrementavam nada — apesar de o
 * runbook operacional já documentar `maia_llm_calls_total{status="error"}`.
 *
 * Agora existe UM ponto de emissão, chamado em TODO desfecho.
 *
 * Invariantes respeitadas aqui:
 *  - `trace_id`, `pessoa_id`, conversa e mensagem NUNCA viram label Prometheus
 *    (cardinalidade). Vão só para o log estruturado.
 *  - `tenant_id`/`agent_id` só entram como label quando o ALS realmente os
 *    forneceu. Sem contexto, a chamada é contada SEM os labels e o gap é
 *    sinalizado em `maia_llm_scope_missing_total` — nunca preenchido com o
 *    literal `'default'`.
 *  - Nenhum prompt, resposta, chave de API ou header de autorização é logado.
 */
import { incCounter, observeHistogram } from '@/lib/metrics.js';
import { logger } from '@/lib/logger.js';
import { recordLLMCost } from '@/lib/cost-ledger.js';
import { tryGetCurrentContext } from '@/db/tenant-context.js';
import type { LLMErrorKind } from './errors.js';
import type { LLMTier, LLMUsage, LLMWorkload } from './types.js';

export type LLMCallStatus =
  | 'ok'
  | 'error'
  | 'timeout'
  | 'rate_limit'
  | 'cancelled'
  | 'budget_exhausted';

/** Mapeia o kind do erro para o status observável (label Prometheus). */
export function statusForKind(kind: LLMErrorKind): LLMCallStatus {
  switch (kind) {
    case 'aborted':
      return 'cancelled';
    case 'timeout':
      return 'timeout';
    case 'rate_limit':
      return 'rate_limit';
    case 'budget_exhausted':
      return 'budget_exhausted';
    default:
      return 'error';
  }
}

export type LLMUsageEvent = {
  workload: LLMWorkload;
  tier: LLMTier;
  provider: string;
  model: string;
  status: LLMCallStatus;
  attempts: number;
  duration_ms: number;
  usage?: LLMUsage;
  /** Modelo de origem quando houve downgrade para o fast. */
  fallback_from?: string;
  fallback_reason?: string;
  error_kind?: LLMErrorKind;
  /** Só log/ledger — nunca label. */
  pessoa_id?: string;
  trace_id?: string;
};

export type LLMScope = { tenant_id: string; agent_id: string } | null;

export function currentScope(): LLMScope {
  return tryGetCurrentContext();
}

/**
 * Emite métricas + evento de uso + custo para UMA chamada terminada.
 *
 * Nunca lança: uma falha de telemetria não pode derrubar o turno. Mas também
 * não engole em silêncio — cada caminho de falha incrementa um counter
 * próprio para que o operador veja a evidência sumindo (critério explícito da
 * issue: "falha de telemetria não pode esconder a chamada").
 */
export async function emitUsage(event: LLMUsageEvent, scope: LLMScope): Promise<void> {
  // Issue #508 (review rodada 1): o escopo entra em TODAS as emissões
  // tenant-aware, não só em `requests_total`. Antes, duração, timeout,
  // cancelamento, fallback, tokens e attempts agregavam tenants — um tenant
  // sozinho estourando latência ou queimando tokens ficava diluído na média
  // de todos, que é justamente a pergunta que o operador precisa responder.
  const scopeLabels: Record<string, string> = scope
    ? { tenant_id: scope.tenant_id, agent_id: scope.agent_id }
    : {};
  const base = {
    ...scopeLabels,
    provider: event.provider,
    model: event.model,
    tier: event.tier,
    workload: event.workload,
  };

  try {
    incCounter('maia_llm_requests_total', { ...base, status: event.status });
    observeHistogram('maia_llm_request_duration_ms', event.duration_ms, {
      ...base,
      status: event.status,
    });
    // Compat com o runbook operacional (§8) e dashboards existentes, que
    // apontam para `maia_llm_calls_total{status}` e `maia_llm_latency_ms`.
    incCounter('maia_llm_calls_total', {
      provider: event.provider,
      model: event.model,
      status: event.status,
    });
    observeHistogram('maia_llm_latency_ms', event.duration_ms, {
      provider: event.provider,
      model: event.model,
    });

    if (event.status === 'timeout') {
      incCounter('maia_llm_timeouts_total', {
        ...scopeLabels,
        provider: event.provider,
        model: event.model,
        workload: event.workload,
      });
    }
    if (event.status === 'cancelled') {
      incCounter('maia_llm_cancelled_total', {
        ...scopeLabels,
        provider: event.provider,
        model: event.model,
        workload: event.workload,
      });
    }
    if (event.fallback_from) {
      incCounter('maia_llm_fallback_total', {
        ...scopeLabels,
        from_model: event.fallback_from,
        to_model: event.model,
        workload: event.workload,
        reason: event.fallback_reason ?? 'primary_exhausted',
      });
    }
    if (event.usage) {
      incCounter('maia_llm_tokens_total', { ...base, kind: 'input' }, event.usage.input_tokens);
      incCounter('maia_llm_tokens_total', { ...base, kind: 'output' }, event.usage.output_tokens);
      if (event.usage.cache_read) {
        incCounter('maia_llm_tokens_total', { ...base, kind: 'cache_read' }, event.usage.cache_read);
      }
      if (event.usage.cache_write) {
        incCounter(
          'maia_llm_tokens_total',
          { ...base, kind: 'cache_write' },
          event.usage.cache_write,
        );
      }
    }
    if (!scope) {
      // O ALS não tinha contexto: a chamada aconteceu, mas não é atribuível a
      // tenant/agent. Contar isso é o que impede o gap de virar invisível.
      incCounter('maia_llm_scope_missing_total', { workload: event.workload });
    }
  } catch (err) {
    incCounter('maia_llm_telemetry_failures_total', { stage: 'metrics' });
    logger.warn({ err: (err as Error).message }, 'llm_gateway.metrics_failed');
  }

  // Log estruturado — SEM prompt, SEM resposta, SEM chave. É a evidência que
  // a #514 vai correlacionar com o trace do turno.
  logger.info(
    {
      workload: event.workload,
      tier: event.tier,
      provider: event.provider,
      model: event.model,
      status: event.status,
      attempts: event.attempts,
      duration_ms: event.duration_ms,
      tokens_input: event.usage?.input_tokens ?? 0,
      tokens_output: event.usage?.output_tokens ?? 0,
      fallback_from: event.fallback_from,
      fallback_reason: event.fallback_reason,
      error_kind: event.error_kind,
      trace_id: event.trace_id,
      tenant_id: scope?.tenant_id,
      agent_id: scope?.agent_id,
      pessoa_id: event.pessoa_id,
    },
    'llm_gateway.call',
  );

  // Custo só faz sentido quando houve tokens. `recordLLMCost` escreve via
  // `factsRepo`, que já é escopado por ALS — sem contexto ele falha e caímos
  // no counter abaixo em vez de gravar num bucket compartilhado.
  if (!event.usage || (event.usage.input_tokens === 0 && event.usage.output_tokens === 0)) return;
  try {
    await recordLLMCost({
      provider: event.provider,
      model: event.model,
      tokens_input: event.usage.input_tokens,
      tokens_output: event.usage.output_tokens,
      pessoa_id: event.pessoa_id,
    });
  } catch (err) {
    // O ledger é best-effort, mas a perda precisa de sinal operacional —
    // antes da #508 isto era um `.catch(() => undefined)` mudo.
    incCounter('maia_llm_cost_ledger_failures_total', { workload: event.workload });
    logger.warn({ err: (err as Error).message }, 'llm_gateway.cost_ledger_failed');
  }
}

/** Contabiliza o desfecho de UMA tentativa (não da chamada inteira). */
export function recordAttempt(
  args: {
    provider: string;
    model: string;
    workload: LLMWorkload;
    outcome: 'ok' | LLMErrorKind;
  },
  scope: LLMScope,
): void {
  incCounter('maia_llm_attempts_total', {
    ...(scope ? { tenant_id: scope.tenant_id, agent_id: scope.agent_id } : {}),
    provider: args.provider,
    model: args.model,
    workload: args.workload,
    outcome: args.outcome,
  });
}
