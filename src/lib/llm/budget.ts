/**
 * Orçamento diário de LLM por `tenant_id + agent_id` (issue #508).
 *
 * ## Por que RESERVA e não checagem
 *
 * A primeira versão fazia check-then-act: lia o gasto acumulado, comparava com
 * o teto e seguia. Com gasto 4,99 e teto 5, N chamadas simultâneas liam o
 * MESMO valor, todas passavam, e cada uma depois sobrescrevia o incremento das
 * outras no ledger (read-modify-write absoluto). O resultado é gasto
 * ilimitado e subcontabilização — e acontece exatamente no cenário em que a
 * quota existe para proteger: retry storm, fan-out de workers, rajada de
 * turnos concorrentes.
 *
 * Agora o fluxo é reserva → chamada → liquidação:
 *
 *   1. `reserveBudget()` INCREMENTA atomicamente um contador diário por
 *      `(tenant_id, agent_id)` com uma ESTIMATIVA do custo, e só então
 *      compara. Se o novo total estourar, a reserva é devolvida e a chamada é
 *      recusada. Duas chamadas concorrentes nunca leem o mesmo valor: o
 *      `INCRBYFLOAT` do Redis serializa.
 *   2. `settleReservation()` ajusta o contador para o gasto ACUMULADO, e é
 *      chamada uma vez por TENTATIVA ENVIADA — não só pela resposta final.
 *
 * ## Por que por tentativa, e não só pela resposta final
 *
 * A versão anterior liquidava com o custo da resposta bem sucedida e devolvia
 * a reserva inteira quando a chamada falhava. Mas uma tentativa que CHEGOU ao
 * provider já consumiu tokens de entrada: o prompt foi transmitido e cobrado,
 * mesmo que a resposta tenha morrido no meio. Tratá-la como custo zero fazia o
 * gasto real divergir do contabilizado exatamente no retry storm — o cenário
 * que a quota existe para conter, onde há muitas tentativas e poucas respostas.
 *
 * Agora: toda tentativa que entrou em `provider.call()` soma custo (entrada
 * sempre; saída quando há evidência dela no `usage` da resposta ou do erro), e
 * retries e fallback ACUMULAM. Devolução integral só quando nenhuma requisição
 * saiu — recusa por quota, ausência de scope, ou abort antes do primeiro envio.
 *
 * A verdade contábil continua no ledger em Postgres; o contador do Redis é o
 * mecanismo de admissão. Na primeira escrita do dia ele é semeado a partir do
 * ledger, então reinício de processo não zera a quota.
 *
 * ## Escopo (invariante 1)
 *
 * A chave carrega `tenant_id + agent_id` e o dia. O gateway já rejeita chamada
 * sem ALS (`missing_tenant_context`), então não existe caminho anônimo.
 *
 * ## Postura de falha (deliberada, documentada)
 *
 *  - Orçamento EXCEDIDO → `budget_exhausted` (não retentável). Fail-closed:
 *    gastar é o efeito colateral, e efeito colateral sem orçamento não ocorre.
 *  - Redis INDISPONÍVEL → fail-OPEN com `maia_llm_budget_check_failures_total`.
 *    Custo é controle financeiro, não de segurança: derrubar todo o tráfego de
 *    um tenant por um hiccup de cache é incidente pior que estourar a quota por
 *    alguns minutos. O counter é o que torna a degradação alertável em vez de
 *    invisível.
 */
import { config } from '@/config/env.js';
import { estimateLLMCostUsd, readDailyLLMUsd } from '@/lib/cost-ledger.js';
import { redis } from '@/lib/redis.js';
import { incCounter } from '@/lib/metrics.js';
import { logger } from '@/lib/logger.js';
import { LLMGatewayError } from './errors.js';
import type { LLMMessage, LLMWorkload } from './types.js';

/** 36h cobre a virada do dia e desvio de relógio entre réplicas. */
const KEY_TTL_SECONDS = 36 * 60 * 60;

/** Heurística de tokens por caractere — suficiente para uma ESTIMATIVA. */
const CHARS_PER_TOKEN = 4;

export type LLMScope = { tenant_id: string; agent_id: string };

/**
 * Handle opaco devolvido pela reserva e exigido pela liquidação.
 *
 * `reserved_usd` é MUTÁVEL de propósito: `settleReservation` pode ser chamada
 * várias vezes durante a mesma chamada de LLM (uma vez por tentativa enviada),
 * sempre com o total corrido, e atualiza este campo para que a próxima
 * liquidação aplique só o delta. Sem isso, liquidar por tentativa somaria o
 * mesmo gasto repetidas vezes.
 */
export type BudgetReservation = {
  key: string;
  reserved_usd: number;
  /** `false` quando a quota está desligada ou degradou aberta. */
  active: boolean;
};

/** Fábrica, não constante compartilhada: o handle é mutado na liquidação. */
function noReservation(): BudgetReservation {
  return { key: '', reserved_usd: 0, active: false };
}

function dailyBudgetUsd(): number {
  return config.LLM_DAILY_BUDGET_USD;
}

// NOTA: `redis` e o ledger entram por import ESTÁTICO de propósito. A versão
// dinâmica (para evitar abrir socket quando a quota está desligada) não é
// interceptada de forma confiável por `vi.mock` nos specs — o cliente REAL era
// carregado e os comandos ficavam enfileirados para sempre contra um Redis
// inexistente. Um módulo que só é testável por acidente não vale a economia
// de um socket que o runtime abre de qualquer jeito.

export function isBudgetEnabled(): boolean {
  return dailyBudgetUsd() > 0;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Chave do contador. Os ids entram serializados como JSON array — um
 * separador escolhido à mão poderia, em tese, aparecer dentro de um id e
 * colidir duas tuplas distintas no mesmo contador, que é precisamente o tipo
 * de vazamento cross-tenant que o invariante de isolamento existe para impedir.
 */
function budgetKey(scope: LLMScope, day = todayKey()): string {
  return `maia:llm:budget:${day}:${JSON.stringify([scope.tenant_id, scope.agent_id])}`;
}

/** Tokens estimados do payload de entrada (system + mensagens). */
export function estimateInputTokens(system: string, messages: LLMMessage[]): number {
  let chars = system.length;
  for (const m of messages) {
    if (typeof m.content === 'string') {
      chars += m.content.length;
      continue;
    }
    for (const block of m.content) {
      if (block.type === 'text') chars += block.text.length;
      else if (block.type === 'tool_result') chars += block.content.length;
      else if (block.type === 'tool_use') chars += JSON.stringify(block.input ?? {}).length;
      // Imagem: base64 não é tokenizado por caractere. Usa-se o teto de
      // tokens de imagem da Anthropic (~1.6k) como estimativa conservadora.
      else if (block.type === 'image') chars += 1600 * CHARS_PER_TOKEN;
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Reserva o custo ESTIMADO da chamada no orçamento do dia, atomicamente.
 *
 * A estimativa é conservadora de propósito: entrada medida pelo payload real,
 * saída assumida no teto (`max_tokens`). Superestimar é o lado seguro — a
 * liquidação devolve a diferença logo em seguida.
 *
 * Lança `budget_exhausted` (terminal) quando a reserva estouraria o teto —
 * devolvendo antes o que havia incrementado, para que uma recusa não consuma
 * quota.
 */
export async function reserveBudget(args: {
  scope: LLMScope;
  workload: LLMWorkload;
  model: string;
  system: string;
  messages: LLMMessage[];
  max_tokens?: number;
}): Promise<BudgetReservation> {
  const budget = dailyBudgetUsd();
  // Quota desligada: nada a estimar, nada a reservar, nenhum I/O.
  if (budget <= 0) return noReservation();

  const key = budgetKey(args.scope);

  let delta: number;
  let total: number;
  try {
    delta = Math.max(
      0,
      await estimateLLMCostUsd({
        model: args.model,
        tokens_input: estimateInputTokens(args.system, args.messages),
        tokens_output: args.max_tokens ?? 1024,
      }),
    );
    // ATÔMICO. É a linha inteira do fix: o valor lido já reflete todas as
    // reservas concorrentes, então duas chamadas nunca decidem sobre o mesmo
    // número.
    total = Number(await redis.incrbyfloat(key, delta));

    // Chave nova (o total voltou igual ao delta): semeia com o gasto já
    // registrado no ledger para que restart de processo não zere a quota, e
    // marca o TTL. Duas réplicas podem semear na mesma janela; o erro é
    // limitado a uma dose e o TTL o descarta no fim do dia.
    if (Math.abs(total - delta) < 1e-9) {
      await redis.expire(key, KEY_TTL_SECONDS);
      const alreadySpent = await readDailyLLMUsd().catch(() => 0);
      if (alreadySpent > 0) total = Number(await redis.incrbyfloat(key, alreadySpent));
    }
  } catch (err) {
    // Fail-OPEN documentado — ver cabeçalho do módulo.
    incCounter('maia_llm_budget_check_failures_total', { workload: args.workload });
    logger.warn(
      { err: (err as Error).message, workload: args.workload },
      'llm_gateway.budget_reserve_failed',
    );
    return noReservation();
  }

  if (total <= budget) return { key, reserved_usd: delta, active: true };

  // Estourou: devolve a própria reserva antes de recusar. Sem isto, cada
  // recusa deixaria a estimativa presa no contador e a quota encolheria a
  // cada tentativa negada.
  await redis.incrbyfloat(key, -delta).catch(() => undefined);

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
      budget_usd: budget,
    },
    'llm_gateway.budget_exhausted',
  );
  throw new LLMGatewayError({
    kind: 'budget_exhausted',
    // Sem números de gasto na mensagem: ela pode chegar a superfícies de
    // usuário, e gasto de tenant é dado do operador.
    detail: 'daily LLM budget exhausted for this tenant/agent',
    workload: args.workload,
  });
}

/**
 * Ajusta o contador para o gasto ACUMULADO da chamada até agora.
 *
 * Idempotente e CUMULATIVA: pode ser invocada uma vez por tentativa enviada,
 * sempre com o total corrido, porque aplica só o delta contra o que já estava
 * reservado e então move `reserved_usd` para o novo total. Chamar duas vezes
 * com o mesmo valor é no-op.
 *
 * `actual_total_usd = 0` devolve a reserva inteira — reservado para o caso em
 * que NENHUMA requisição chegou ao provider (recusa por quota, ausência de
 * scope, abort antes do primeiro envio).
 *
 * Nunca lança: uma falha aqui não pode derrubar um turno que já teve sucesso.
 * A consequência de perder um ajuste é um contador levemente conservador até
 * o TTL — o lado seguro.
 */
export async function settleReservation(
  reservation: BudgetReservation,
  actual_total_usd: number,
): Promise<void> {
  if (!reservation.active) return;
  const total = Math.max(0, actual_total_usd);
  const delta = total - reservation.reserved_usd;
  if (Math.abs(delta) < 1e-9) return;
  // Move o handle ANTES do I/O: se o `incrbyfloat` falhar, a próxima
  // liquidação não repete este mesmo delta em cima do anterior.
  reservation.reserved_usd = total;
  try {
    await redis.incrbyfloat(reservation.key, delta);
  } catch (err) {
    incCounter('maia_llm_budget_settle_failures_total', {});
    logger.warn({ err: (err as Error).message }, 'llm_gateway.budget_settle_failed');
  }
}

export const _internal = { budgetKey, estimateInputTokens, KEY_TTL_SECONDS, CHARS_PER_TOKEN };
