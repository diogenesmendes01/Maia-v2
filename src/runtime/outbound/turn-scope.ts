/**
 * Issue #631 (fatia B da épica #506) — o TURNO visível para o dispatcher de
 * saída.
 *
 * ─── O problema concreto ────────────────────────────────────────────────────
 *
 * O commit transacional precisa de quatro fatos que só o `TurnHandle` tem:
 * `turn_id`, `state_version` (o CAS), o `claim_token` vigente (o fence) e a
 * `conversa_id`. O handle nasce em `src/agent/core.ts` e desce por parâmetro
 * até `concludeTurn`. `dispatchOutput`/`sendOutbound`
 * (`src/agent/output-dispatch.ts`) NÃO o recebem — e não deveriam: a fronteira
 * pública deles é chamada de skills, do ReAct, do fallback do Decision Engine
 * e do fallback de TTS, e acrescentar um parâmetro obrigatório a todos
 * significaria um call site esquecido em algum ramo — que é um limite de
 * efeito SEM commit, ou seja, o defeito de volta.
 *
 * ─── Por que AsyncLocalStorage, e não um parâmetro ──────────────────────────
 *
 * É a mesma decisão, pela mesma razão, que `src/runtime/turns/execution-context.ts`
 * já tomou para o `AbortSignal` da tentativa (#504), e que
 * `src/db/tenant-context.ts` tomou para `tenant_id`/`agent_id`. O escopo abre
 * uma vez, no ponto onde a posse é estabelecida, e todo limite de efeito a
 * jusante o encontra sem que ninguém precise lembrar de passá-lo adiante.
 *
 * ─── Por que um módulo próprio, e não um campo em `TurnExecutionContext` ────
 *
 * `TurnExecutionContext` (`src/runtime/turns/claim.ts`) é um valor IMUTÁVEL,
 * fotografado no instante do claim. O que o commit precisa é o oposto: o
 * `state_version` MUDA a cada transição, e o handle é justamente o objeto vivo
 * que carrega essa mudança. Guardar uma cópia congelada do `state_version` no
 * contexto de execução produziria um CAS que já nasce velho na segunda
 * gravação do turno.
 *
 * Por isso o store aqui é o PRÓPRIO handle, por referência — a mesma
 * referência que `concludeTurn` vai ler depois. Quando o commit avança o
 * estado, ele avança o handle, e a conclusão seguinte enxerga a versão nova.
 * Guardar uma cópia era o defeito silencioso mais provável desta fatia: o
 * commit passaria, e a conclusão do turno seria recusada por `state_mismatch`
 * logo em seguida — o turno ficaria preso em `outbound_pending` para sempre.
 *
 * FORA de um turno (`getOutboundTurnScope() === null`) não há o que commitar:
 * workers de agenda, playground, testes e o regime de rollback de #503. Esse
 * caso é tratado em `commit.ts`, não aqui.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { TurnHandle } from '@/runtime/turns/lifecycle.js';

const storage = new AsyncLocalStorage<TurnHandle>();

/**
 * Abre o escopo do turno para os limites de saída.
 *
 * Chamado por `src/agent/core.ts` no MESMO ponto em que `runWithTurnExecution`
 * abre o escopo da tentativa — depois da barreira do claim. Coincidir os dois
 * escopos é o que garante que "tem posse" e "tem turno para commitar" sejam a
 * mesma região do código, por construção.
 */
export function runWithOutboundTurnScope<T>(
  handle: TurnHandle,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(handle, fn);
}

/** O handle do turno corrente, ou `null` fora de um turno. */
export function getOutboundTurnScope(): TurnHandle | null {
  return storage.getStore() ?? null;
}
