/**
 * Orçamento diário de LLM por `tenant_id + agent_id` (issue #508).
 *
 * Antes desta issue não havia forma uniforme de impor quota: o custo era
 * agregado num fact diário e comparado por um alerta assíncrono, ou seja, um
 * loop descontrolado só era percebido DEPOIS de gastar. O gateway é a única
 * fronteira por onde toda chamada passa — é o único lugar onde uma quota pode
 * ser imposta de verdade.
 *
 * Escopo (invariante 1): a leitura usa `readDailyLLMUsd()`, que lê via
 * `factsRepo` — já escopado pelo ALS. Logo, o orçamento é por tenant+agent
 * por construção, e o cache abaixo é chaveado pelo mesmo par.
 *
 * Postura de falha (deliberada, documentada):
 *  - Orçamento EXCEDIDO → rejeita com `budget_exhausted` (não retentável).
 *    Este é o caminho fail-closed: gastar é o efeito colateral, e efeito
 *    colateral sem orçamento não acontece.
 *  - SEM contexto de ALS → a chamada nem chega aqui: o gateway a rejeita com
 *    `missing_tenant_context` antes de qualquer I/O de provider. A versão
 *    anterior deste módulo aceitava `scope=null` e retornava sem avaliar nada,
 *    o que transformava "perder o contexto" num bypass da cota. Trabalho
 *    genuinamente global declara `runWithSystemContext()` e passa a ter quota
 *    própria sob o tenant reservado `system`.
 *  - Leitura do ledger FALHOU → fail-OPEN com counter
 *    (`maia_llm_budget_check_failures_total`). Custo é controle financeiro,
 *    não de segurança: derrubar todo o tráfego de um tenant por um hiccup de
 *    Postgres é um incidente pior que passar do orçamento por alguns minutos.
 *    O counter é o que torna essa degradação alertável em vez de invisível.
 */
import { config } from '@/config/env.js';
import { readDailyLLMUsd } from '@/lib/cost-ledger.js';
import { incCounter } from '@/lib/metrics.js';
import { logger } from '@/lib/logger.js';
import { LLMGatewayError } from './errors.js';
import type { LLMWorkload } from './types.js';

/**
 * TTL do cache de gasto acumulado. Curto o bastante para o estouro ser
 * percebido em segundos, longo o bastante para não fazer uma leitura de
 * `agent_facts` por chamada de LLM.
 */
const SPEND_CACHE_TTL_MS = 10_000;

type SpendEntry = { usd: number; expires_at: number };

const spendCache = new Map<string, SpendEntry>();

function cacheKey(scope: { tenant_id: string; agent_id: string }): string {
  return JSON.stringify([scope.tenant_id, scope.agent_id]);
}

/** `0` (default) desliga a quota — é a configuração de quem ainda não a adotou. */
function dailyBudgetUsd(): number {
  return config.LLM_DAILY_BUDGET_USD;
}

export function isBudgetEnabled(): boolean {
  return dailyBudgetUsd() > 0;
}

/**
 * Rejeita a chamada quando o tenant+agent já estourou a quota do dia.
 *
 * Chamado ANTES de resolver modelo e antes de qualquer I/O de provider: o
 * ponto de uma quota é não gastar, então ela precisa vir primeiro.
 */
export async function assertWithinBudget(args: {
  /**
   * Não-nulo por tipo. O gateway já rejeita a chamada sem contexto de ALS
   * (`missing_tenant_context`) antes de chegar aqui — antes, este módulo
   * aceitava `null` e simplesmente NÃO avaliava a quota, o que fazia de
   * "perder o contexto" um jeito de escapar do orçamento.
   */
  scope: { tenant_id: string; agent_id: string };
  workload: LLMWorkload;
}): Promise<void> {
  const budget = dailyBudgetUsd();
  if (budget <= 0) return;

  const key = cacheKey(args.scope);
  const cached = spendCache.get(key);
  let spent: number;
  if (cached && cached.expires_at > Date.now()) {
    spent = cached.usd;
  } else {
    try {
      spent = await readDailyLLMUsd();
      spendCache.set(key, { usd: spent, expires_at: Date.now() + SPEND_CACHE_TTL_MS });
    } catch (err) {
      incCounter('maia_llm_budget_check_failures_total', { workload: args.workload });
      logger.warn(
        { err: (err as Error).message, workload: args.workload },
        'llm_gateway.budget_check_failed',
      );
      return;
    }
  }

  if (spent < budget) return;

  incCounter('maia_llm_budget_exhausted_total', {
    tenant_id: args.scope.tenant_id,
    agent_id: args.scope.agent_id,
    workload: args.workload,
  });
  logger.warn(
    {
      tenant_id: args.scope.tenant_id,
      agent_id: args.scope.agent_id,
      workload: args.workload,
      spent_usd: Math.round(spent * 100) / 100,
      budget_usd: budget,
    },
    'llm_gateway.budget_exhausted',
  );
  throw new LLMGatewayError({
    kind: 'budget_exhausted',
    // Sem valores de gasto na mensagem: ela pode chegar a superfícies de
    // usuário, e gasto de tenant é dado do operador.
    detail: 'daily LLM budget exhausted for this tenant/agent',
    workload: args.workload,
  });
}

/**
 * Solta o gasto cacheado de um escopo. Chamado depois de cada chamada bem
 * sucedida para que o próximo check não sirva um número que já ficou velho por
 * causa da própria chamada anterior.
 */
export function invalidateSpendCache(scope?: { tenant_id: string; agent_id: string }): void {
  if (!scope) {
    spendCache.clear();
    return;
  }
  spendCache.delete(cacheKey(scope));
}

export const _internal = { SPEND_CACHE_TTL_MS, spendCache, cacheKey };
