/**
 * Issue #504 — propagação do `TurnExecutionContext` (o FENCE) pelo pipeline.
 *
 * ## Por que AsyncLocalStorage, e não um parâmetro
 *
 * A issue exige que o contexto "chegue aos limites stateful e de efeito lateral
 * relevantes". O caminho de execução de um turno atravessa `agent/core.ts`,
 * o dispatcher de tools, o engine de decisão e o outbound — dezenas de
 * fronteiras, muitas delas com callbacks de terceiros no meio. Threadar um
 * parâmetro por todas elas seria uma mudança mecânica gigante cujo efeito
 * colateral mais provável é o pior possível: UM caminho esquecido, que grava
 * sem fence e parece seguro porque compila.
 *
 * ALS inverte o risco. Quem precisa do fence PEDE (`currentTurnExecution()`);
 * quem não precisa não muda. Um caminho novo que esqueça de pedir grava sem
 * fence — mas isso é detectável por revisão e por teste, enquanto um parâmetro
 * esquecido no meio de uma cadeia de 12 chamadas não é.
 *
 * É o MESMO padrão de `src/observability/correlation.ts` (#514), com uma
 * diferença de contrato deliberada: correlação é diagnóstica e degrada para
 * `null`; o fence é de SEGURANÇA. Por isso existem duas leituras —
 * `currentTurnExecution()` (opcional, para quem só quer enriquecer log) e
 * `requireTurnExecution()` (fail-closed, para quem vai gravar).
 *
 * ## O que este módulo NÃO faz
 *
 * Não renova lease, não fala com o banco e não decide se o fence ainda vale.
 * Ele carrega o contexto; a validade é do PostgreSQL (o `claim_token` no WHERE)
 * e do detentor da lease (`src/runtime/turns/lease.ts`).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { TurnLeaseLostError, type TurnExecutionContext } from './claim.js';

const storage = new AsyncLocalStorage<TurnExecutionContext>();

/** Roda `fn` com o contexto de fencing instalado. */
export function runWithTurnExecution<T>(ctx: TurnExecutionContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

/** O contexto corrente, ou `null` fora de uma tentativa reivindicada. */
export function currentTurnExecution(): TurnExecutionContext | null {
  return storage.getStore() ?? null;
}

/**
 * O `claim_token` corrente, quando a tentativa é dona do turno indicado.
 *
 * O casamento por `turn_id` é o detalhe que impede o pior modo de falha do ALS:
 * uma escrita sobre o turno X herdando, por acidente de aninhamento, o token do
 * turno Y. Fence de outro turno não é fence — é dano.
 */
export function currentClaimTokenFor(turn_id: string): string | null {
  const ctx = storage.getStore();
  return ctx && ctx.turn_id === turn_id ? ctx.claim_token : null;
}

/**
 * Contexto obrigatório. Usado por caminhos que só existem dentro de uma
 * tentativa reivindicada e cuja execução sem fence seria um bug silencioso.
 */
export function requireTurnExecution(operation: string): TurnExecutionContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error(
      `${operation}: nenhum TurnExecutionContext ativo — esta operação só pode rodar ` +
        `dentro de uma tentativa que venceu o claim atômico (issue #504)`,
    );
  }
  return ctx;
}

/**
 * Ponto de checagem COOPERATIVO: lança `TurnLeaseLostError` se a lease já foi
 * perdida.
 *
 * Chamar isto ANTES de um efeito colateral externo é o que reduz (não elimina)
 * a janela do cenário 6 da issue — "uma ferramenta produz efeito externo antes
 * de a perda de ownership ser percebida". Eliminar exige idempotência do lado
 * de fora (outbox, idempotency key), que é escopo de #506 e de cada integração.
 */
export function assertTurnNotCancelled(operation: string): void {
  const ctx = storage.getStore();
  if (!ctx) return;
  if (ctx.signal.aborted) {
    throw new TurnLeaseLostError({ turn_id: ctx.turn_id, reason: 'taken_over' });
  }
  void operation;
}

/** Campos seguros do contexto para log estruturado — nunca conteúdo. */
export function turnExecutionLogFields(): Record<string, unknown> {
  const ctx = storage.getStore();
  if (!ctx) return {};
  return {
    turn_id: ctx.turn_id,
    attempt: ctx.attempt,
    worker_id: ctx.worker_id,
  };
}
