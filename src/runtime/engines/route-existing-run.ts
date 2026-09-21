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
