/**
 * P02 (spec §5.2, "segundo seam obrigatório") — `routeExistingEngineRun`.
 *
 * ─── O buraco que este módulo fecha ─────────────────────────────────────────
 *
 * Quando um turno volta pelo recovery, o pipeline reexecuta do começo:
 * identidade, debounce, gates, pendências, procedures, skills, e só lá no fim
 * o motor. Isso é correto enquanto o turno não tiver deixado NADA durável para
 * trás. Deixou de ser no instante em que passou a existir um journal de run.
 *
 * Um recovery que só encontra o ledger na altura do reasoner já reexecutou
 * tudo que vem antes dele. As pendências já foram reabertas, as procedures já
 * rodaram de novo, as skills já rodaram de novo — e algumas dessas coisas
 * commitam efeito. Descobrir o run depois disso é descobrir tarde: a
 * informação chega quando o estrago já foi feito.
 *
 * Por isso a pergunta muda de lugar. Ela passa a ser feita logo depois do
 * claim, antes de o pipeline rodar, e a resposta escolhe o CAMINHO — não o
 * desfecho.
 *
 * ─── O que esta função NÃO resolve ──────────────────────────────────────────
 *
 * Ela não desfaz crash de skill ou de preturn que aconteceu ANTES de existir o
 * primeiro run: nesse caso não há binding, e não há o que reconciliar. O §5.2
 * é explícito em que isso pertence a outra fatia, e fingir o contrário aqui
 * daria a impressão de uma cobertura que não existe.
 *
 * Ela também não autoriza ninguém a mexer no run. A leitura é otimista e sem
 * lock; quem for adotar, cancelar ou reconciliar toma o fence do run na
 * operação própria (§5.7.1). O que ela decide é só se vale reexecutar.
 */
import type { EngineRunPhaseV1 } from './contracts.js';
import type {
  EngineRunSnapshot,
  PersistedTurnPin,
  TurnEngineState,
} from '@/db/repositories/engine-repos.js';

/**
 * Para onde o turno vai depois do claim.
 *
 * `run_pipeline` é o caminho de sempre. Os outros dois existem porque
 * "reexecutar" e "reconciliar" deixaram de ser a mesma coisa.
 */
export type TurnRouteV1 =
  | { kind: 'run_pipeline' }
  | {
      kind: 'reconcile_run';
      pin: PersistedTurnPin;
      run: EngineRunSnapshot;
      /** Por que não reexecutar — vai para o log, não para o usuário. */
      reason: 'result_ready' | 'in_flight' | 'submission_unknown' | 'blocked';
    }
  | {
      kind: 'await_operator';
      pin: PersistedTurnPin;
      run: EngineRunSnapshot;
      reason: 'blocked';
    };

/**
 * Fases em que o run ainda pode produzir (ou já produziu) resultado, e por
 * isso reexecutar o pipeline é proibido.
 *
 * `submission_unknown` é o caso que mais importa: não sabemos se o motor
 * aceitou o trabalho. Reexecutar aqui é a definição de duplicar — e é
 * exatamente o que o §5.3.1 chama de tratar ausência de registro como prova de
 * não-aceite.
 */
const FASE_PARA_MOTIVO: Record<
  EngineRunPhaseV1,
  'result_ready' | 'in_flight' | 'submission_unknown' | 'blocked' | null
> = {
  prepared: 'in_flight',
  submitting: 'submission_unknown',
  submission_unknown: 'submission_unknown',
  running: 'in_flight',
  cancelling: 'in_flight',
  reconciling: 'in_flight',
  result_ready: 'result_ready',
  blocked: 'blocked',
  // `closed` não chega aqui: a consulta filtra por fases abertas. O mapa é
  // exaustivo para que uma fase NOVA no contrato quebre o build, em vez de
  // cair num `default` que mandaria reexecutar um run desconhecido.
  closed: null,
};

/**
 * Decide o caminho do turno a partir do que o claim leu.
 *
 * Pura de propósito: a decisão é testável sem banco, e o único jeito de ela
 * mudar é mudando o estado lido — não o relógio, não a rede, não o motor.
 */
export function routeExistingEngineRun(state: TurnEngineState): TurnRouteV1 {
  if (state.kind === 'no_binding') return { kind: 'run_pipeline' };

  // Binding sem run aberto: o turno fixou motor e o run fechou. Quanto ao
  // LEDGER, reexecutar é seguro — não há run em voo para duplicar. Se a
  // primeira tentativa commitou efeito, quem barra é o gate de efeito do
  // turno (`decideTurnAction`), que é onde essa regra mora.
  if (state.kind === 'binding_without_open_run') return { kind: 'run_pipeline' };

  const motivo = FASE_PARA_MOTIVO[state.run.phase];
  // Fase fora do contrato conhecido: NÃO reexecutar. Uma fase que este build
  // não entende pode perfeitamente ter trabalho em voo, e o lado seguro de
  // "não sei" é o mesmo de `submission_unknown`.
  if (motivo === null) {
    return {
      kind: 'reconcile_run',
      pin: state.pin,
      run: state.run,
      reason: 'submission_unknown',
    };
  }

  // `blocked` não é reconciliável por conta própria: alguém já decidiu que
  // este run precisa de gente. Reconciliar em cima disso é passar por cima da
  // decisão (§5.7.1).
  if (motivo === 'blocked') {
    return { kind: 'await_operator', pin: state.pin, run: state.run, reason: 'blocked' };
  }

  return { kind: 'reconcile_run', pin: state.pin, run: state.run, reason: motivo };
}

/** O pipeline pode rodar? Açúcar para o call site no `core.ts`. */
export function routeAllowsPipeline(route: TurnRouteV1): boolean {
  return route.kind === 'run_pipeline';
}

/**
 * O DESFECHO DURÁVEL da rota — a metade que faltava.
 *
 * ─── Por que "só não reexecutar" não era desfecho ───────────────────────────
 *
 * A primeira versão deste seam decidia o CAMINHO e voltava: quando a rota não
 * era `run_pipeline`, o call site logava e retornava. Isso deixa o turno no
 * estado em que o claim o pôs — `claimed` ou `running` —, e esses dois estão
 * em `RECOVERABLE_TURN_STATUSES`. O recovery rearma; o worker reclama; a rota
 * recusa de novo; ninguém conta tentativa. É um laço sem fim e sem rastro, e o
 * sintoma para quem usa é uma mensagem que nunca é respondida e nunca aparece
 * em lugar nenhum — a falha que o §2 do #503 nomeia como a pior de todas.
 *
 * Então a rota também decide o desfecho. Continua pura: traduz estado lido em
 * intenção, e quem aplica é o `core.ts`, com o fence do turno na mão.
 *
 * ─── Por que `retry` para um run em voo ─────────────────────────────────────
 *
 * Retry aqui NÃO é reexecutar o pipeline: na volta, o claim passa por esta
 * mesma função antes do pipeline e recusa de novo. O que o retry faz é
 * ESPERAR com backoff e com contador — dá ao caminho de reconciliação a
 * janela para fechar o run, e, se ele não fechar, o esgotamento de tentativas
 * leva o turno a dead letter na frente de uma pessoa, em vez de mantê-lo
 * girando para sempre.
 *
 * ─── Por que `blocked` não espera ───────────────────────────────────────────
 *
 * `await_operator` significa que alguém JÁ decidiu que este run precisa de
 * gente (§5.7.1). Marcar retry seria fingir que o tempo resolve o que uma
 * decisão humana travou. E o outcome é `unsafe_to_retry` — não porque se saiba
 * de algum efeito, mas porque não se consegue descartá-lo: o run ficou aberto
 * com trabalho possivelmente em voo, e o §5.3.1 proíbe ler ausência de
 * registro como prova de ausência de efeito.
 */
export type RouteTurnActionV1 =
  /** Segue o caminho de sempre. */
  | { kind: 'run_pipeline' }
  /** Não reexecuta, espera com backoff e conta a tentativa. */
  | { kind: 'retry'; code: RouteErrorCodeV1 }
  /** Não reexecuta e não espera: exige decisão humana. */
  | { kind: 'dead_letter'; code: RouteErrorCodeV1; outcome: 'unsafe_to_retry' };

/**
 * Códigos de erro do turno emitidos por esta rota. Fechados de propósito: eles
 * aparecem em `agent_turns.last_error_code`, em `maia_turn_retries_total` e na
 * classificação de veneno, e um código livre viraria cardinalidade infinita
 * em métrica e um rótulo que ninguém consegue procurar depois.
 */
export type RouteErrorCodeV1 =
  | 'engine_run_result_ready'
  | 'engine_run_in_flight'
  | 'engine_run_submission_unknown'
  | 'engine_run_blocked';

const MOTIVO_PARA_CODIGO: Record<
  'result_ready' | 'in_flight' | 'submission_unknown' | 'blocked',
  RouteErrorCodeV1
> = {
  result_ready: 'engine_run_result_ready',
  in_flight: 'engine_run_in_flight',
  submission_unknown: 'engine_run_submission_unknown',
  blocked: 'engine_run_blocked',
};

export function decideRouteTurnAction(route: TurnRouteV1): RouteTurnActionV1 {
  if (route.kind === 'run_pipeline') return { kind: 'run_pipeline' };

  const code = MOTIVO_PARA_CODIGO[route.reason];

  if (route.kind === 'await_operator') {
    return { kind: 'dead_letter', code, outcome: 'unsafe_to_retry' };
  }

  // `reconcile_run` com motivo `blocked` não é produzido por
  // `routeExistingEngineRun` — o tipo admite, o construtor não. Se um caller
  // novo o construir, a decisão é a do `blocked`, não a do "espera e tenta":
  // o lado seguro de um run travado é sempre a pessoa.
  if (route.reason === 'blocked') {
    return { kind: 'dead_letter', code, outcome: 'unsafe_to_retry' };
  }

  return { kind: 'retry', code };
}
