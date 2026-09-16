/**
 * P07 (spec §5.8.1, §6.4.2, §6.7.2, §6.7.3, §6.11; gate G-LIFE) — a POLÍTICA do
 * supervisor Hermes, num módulo PURO.
 *
 * ─── A pergunta que este arquivo responde ───────────────────────────────────
 *
 * O supervisor tem três verbos (§5.3.1): `start`, `observe`, `cancel`. Cada um
 * termina numa decisão, e é a decisão — não o encanamento — que carrega as
 * garantias do gate G-LIFE: "crash/retry/lease/ACK/drop/cancel preservam os
 * ledgers e não reexecutam efeito desconhecido".
 *
 * Este módulo é só a decisão. Ele não cria processo, não arma temporizador, não
 * abre pipe, não lê banco. Recebe um INSTANTÂNEO explícito e devolve uma
 * disposição de vocabulário fechado.
 *
 * ─── Por que PURO (a mesma razão de `recovery.ts` e `poison-policy.ts`) ─────
 *
 * Os desfechos que esta etapa existe para acertar são os AMBÍGUOS: o ACK de
 * admissão que se perdeu, a queda entre reservar e lançar, o status remoto que
 * sumiu depois de um restart, a lease que venceu no meio do trabalho. Se a
 * política vivesse dentro do supervisor real, exercitar cada um desses casos
 * exigiria um subprocesso de verdade morrendo num ponto exato — e o teste
 * mediria o escalonador do sistema operacional em vez da regra. Com a decisão
 * isolada num instantâneo, cada ambiguidade vira um caso determinístico.
 *
 * O relógio entra como PARÂMETRO pelo mesmo motivo: uma política de prazo que
 * lesse a hora do processo só seria testável congelando tempo.
 *
 * ─── Como isto se COMPÕE com `recovery.ts`, sem duplicá-lo ──────────────────
 *
 * `src/runtime/engines/recovery.ts` (P03.8b) já é a tabela do §5.8.2: dado um
 * instantâneo do JOURNAL depois de uma queda, o que é seguro fazer com o run.
 * A pergunta daqui é outra — o que a TENTATIVA VIVA pode fazer agora, com o que
 * o canal acabou de dizer. As duas não se sobrepõem e os vocabulários são
 * DISJUNTOS de propósito: um nome repetido significaria duas tabelas decidindo a
 * mesma coisa, e a próxima mudança teria de acertar as duas.
 *
 * A junta entre elas é explícita. `DEFERS_TO_RECOVERY` lista as disposições cujo
 * próximo passo NÃO é desta política: elas nomeiam uma incerteza durável e
 * entregam a decisão a `classifyRecovery`, que é quem conhece o journal. Esta
 * política nunca responde "o que fazer com o run" — ela responde "o que fazer
 * com esta tentativa".
 *
 * ─── O que o vocabulário NÃO CONSEGUE dizer ─────────────────────────────────
 *
 * INV-09 ("crash de processo não retoma automaticamente a sequência de
 * ferramentas") atravessa a fronteira: não existe aqui membro que signifique
 * "lance de novo" ou "retome". A ausência é o mecanismo, exatamente como a
 * ausência de `resume_tools` em `RECOVERY_DISPOSITIONS` — enquanto o tipo não
 * conseguir expressar a ação proibida, nenhum call site consegue pedi-la.
 *
 * O §6.7.3 item 5 acrescenta a irmã dessa regra: cancelar não prova ausência de
 * efeito. Por isso também não existe membro que signifique "seguro repetir" —
 * nem no cancelamento, nem na observação.
 */
import type { CancelFrame } from './protocol.js';

/**
 * Categoria do cancelamento. É o MESMO vocabulário do frame `cancel` do wire
 * (§6.4.2, "categoria enumerada"), tomado de `protocol.ts` em vez de redigitado:
 * uma segunda lista divergiria no primeiro acréscimo, e a categoria que viaja no
 * pipe tem de ser a mesma que a política reconhece.
 */
export type CancelReasonV1 = CancelFrame['reason'];

/**
 * Estado OBSERVADO do executor (§6.11). O parágrafo é explícito sobre o que
 * estes valores NÃO são: "separado de efeito e entrega; não são valores de
 * engine_runs.phase. O enum durável é o do capítulo 5".
 *
 * `unknown` é membro de primeira classe e não um apelido de falha: "Se não for
 * possível saber se P existe ou se a API externa concluiu, preservar `unknown` e
 * bloquear fallback duplicador".
 */
export const EXECUTOR_OBSERVED_STATES = [
  'admitted',
  'running',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'unknown',
] as const;

export type ExecutorObservedStateV1 = (typeof EXECUTOR_OBSERVED_STATES)[number];

/**
 * Estados em que o executor já não está trabalhando. Note `unknown` aqui: não
 * saber é tão pouco "em voo" quanto ter terminado, e tratá-lo como "ainda
 * rodando" faria o supervisor esperar para sempre por um processo que talvez não
 * exista.
 */
const SETTLED_EXECUTOR_STATES = [
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'unknown',
] as const;

type SettledExecutorState = (typeof SETTLED_EXECUTOR_STATES)[number];

function isSettledExecutorState(state: ExecutorObservedStateV1): state is SettledExecutorState {
  return (SETTLED_EXECUTOR_STATES as readonly string[]).includes(state);
}

// ─── admissão (`start`) ─────────────────────────────────────────────────────

/**
 * As disposições da ADMISSÃO.
 *
 *  - `admit_new` — §6.11, "Registrar state `admitted` antes do spawn (…) Só uma
 *    lease válida pode lançar". É a ÚNICA que autoriza criar processo, e por isso
 *    está sozinha em `SPAWNS_PROCESS`;
 *  - `return_existing` — §6.11, "Mesmo pedido de admissão retorna a mesma
 *    execução/estado". É o desfecho do ACK de admissão perdido: o retry idêntico
 *    encontra o que já existe em vez de abrir outra tentativa;
 *  - `conflict_payload` — §6.11, mesma frase: "payload diferente é conflito".
 *    Também §6.5.4: "repetição da mesma chave com payload diferente é conflito";
 *  - `reconcile_admitted_not_executed` — §6.11, "Crash antes de `start`: nenhuma
 *    autoridade de tools concedida; supervisor pode encerrar filho encontrado e
 *    abrir nova tentativa APÓS RECONCILIAÇÃO. Não resetar o registro anterior
 *    como se nunca tivesse existido". Note o que o nome diz e o que ele não diz:
 *    ele NOMEIA o estado, e não autoriza lançar nada;
 *  - `refuse` — recusa com motivo distinguível.
 */
export const ADMISSION_DISPOSITIONS = [
  'admit_new',
  'return_existing',
  'conflict_payload',
  'reconcile_admitted_not_executed',
  'refuse',
] as const;

export type AdmissionDisposition = (typeof ADMISSION_DISPOSITIONS)[number];

/**
 * A ÚNICA disposição que autoriza criar um processo filho.
 *
 * Exportada para que o invariante "nenhum segundo processo" (T09, T10) seja
 * verificável por varredura, e não por leitura: qualquer instantâneo que já
 * tenha execução registrada tem de decidir algo diferente disto.
 */
export const SPAWNS_PROCESS: AdmissionDisposition = 'admit_new';

/**
 * Motivos de recusa. Distinguíveis porque a resposta operacional de cada um é
 * diferente: posse perdida pede novo claim, controle humano pede que ninguém
 * faça nada, run aberto pede que o journal feche o anterior primeiro.
 */
export type AdmissionRefusalV1 =
  | 'human_control'
  | 'stale_claim'
  | 'deadline_exceeded'
  | 'open_run_exists';

export type AdmissionDecisionV1 =
  | { kind: 'admit_new' }
  | { kind: 'return_existing' }
  | { kind: 'conflict_payload' }
  | { kind: 'reconcile_admitted_not_executed' }
  | { kind: 'refuse'; reason: AdmissionRefusalV1 };

/** O registro de execução já admitido para ESTE `execution_id`, se houver. */
export interface AdmittedExecutionV1 {
  execution_id: string;
  /**
   * Digest canônico do pedido congelado (§6.11, "fingerprint imutável de
   * input/bundle/manifest"). Quem deriva é o chamador, com `canonicalDigest`;
   * a política só compara.
   */
  request_fingerprint: string;
  executor_state: ExecutorObservedStateV1;
  /** O processo chegou a ser criado? É o que separa T11 de uma execução real. */
  spawned: boolean;
}

export interface AdmissionSnapshotV1 {
  execution_id: string;
  request_fingerprint: string;
  /** O registro encontrado para `execution_id`, ou `null` se não há nenhum. */
  existing: AdmittedExecutionV1 | null;
  /**
   * Já existe run NÃO fechado para o turno. Espelha o predicado da unique
   * parcial `engine_runs_one_open_turn_uq` (§5.6.2) — a política não inventa a
   * regra, ela recusa cedo o que o banco recusaria depois.
   */
  open_run_for_turn: boolean;
  lease_alive: boolean;
  /** `conversation_controls.mode`. Qualquer coisa fora de `bot` é humano. */
  control_mode: string;
  deadline_exceeded: boolean;
}

/**
 * Decide se o supervisor pode lançar um processo para este pedido. Função TOTAL.
 *
 * ─── Por que a CLASSIFICAÇÃO do registro vem antes dos gates de posse ───────
 *
 * Porque quem cai entre reservar e lançar perde a lease junto — é o mesmo
 * evento. Se o gate de posse viesse primeiro, o T11 receberia `refuse` por claim
 * vencido e a informação "esta execução foi admitida e NUNCA executou" morreria
 * dentro de uma recusa genérica. É exatamente a distinção que o T11 manda
 * preservar, e ela é um fato durável do registro, não uma questão de postura.
 *
 * Os gates continuam valendo para o que eles de fato protegem: LANÇAR. E lançar
 * só acontece no último ramo.
 */
export function decideAdmission(s: AdmissionSnapshotV1): AdmissionDecisionV1 {
  const existing = s.existing;

  if (existing !== null) {
    // O instantâneo modela "o registro encontrado para ESTE execution_id".
    // Um id divergente não é um estado do mundo: é consulta na linha errada.
    // Devolver uma disposição faria esse defeito parecer uma decisão.
    if (existing.execution_id !== s.execution_id) {
      throw new TypeError(
        'supervisor: registro de outra execução no instantâneo de admissão ' +
          '— o snapshot deve trazer a linha do próprio execution_id (§6.11)',
      );
    }

    // 1. Payload divergente é conflito, e domina: §6.11 e §6.5.4.
    if (existing.request_fingerprint !== s.request_fingerprint) {
      return { kind: 'conflict_payload' };
    }

    // 2. Admitido e nunca lançado — o estado que o T11 manda distinguir.
    if (existing.executor_state === 'admitted' && !existing.spawned) {
      return { kind: 'reconcile_admitted_not_executed' };
    }

    // 3. Mesmo pedido, mesma execução: devolve o que já existe (T10).
    return { kind: 'return_existing' };
  }

  // 4. Controle humano fecha a admissão de ação do bot (§8.2, §6.9.1 item 2).
  if (s.control_mode !== 'bot') {
    return { kind: 'refuse', reason: 'human_control' };
  }

  // 5. §6.11: "Só uma lease válida pode lançar."
  if (!s.lease_alive) {
    return { kind: 'refuse', reason: 'stale_claim' };
  }

  // 6. Prazo vencido não ganha processo novo (§5.8.1).
  if (s.deadline_exceeded) {
    return { kind: 'refuse', reason: 'deadline_exceeded' };
  }

  // 7. §5.7.1: "Há no máximo um run não fechado por turno." A "regra explícita"
  //    que o T11 exige para uma nova execução é justamente esta porta: cunhar
  //    novo `execution_id` DEPOIS de o journal ter fechado o run anterior.
  if (s.open_run_for_turn) {
    return { kind: 'refuse', reason: 'open_run_exists' };
  }

  return { kind: 'admit_new' };
}

// ─── observação (`observe`) ─────────────────────────────────────────────────

/**
 * As disposições da OBSERVAÇÃO.
 *
 *  - `ignore_stale_result` — §5.7.1, "Novo owner pode consultar/cancelar/
 *    reconciliar run antigo sob seu token; não pode (…) adotar o run em voo como
 *    nova autoridade". Ignorar aqui significa NÃO ADOTAR; a reconciliação segue;
 *  - `treat_as_unknown` — §6.11, "preservar `unknown` e bloquear fallback
 *    duplicador"; §5.8.2 proíbe "converter 404 em definitely_not_accepted";
 *  - `conflict_terminal` — §6.11, "outro resultado para mesma execução é
 *    conflito";
 *  - `repeat_result_ack` — §6.11, "Resultado recebido sem ACK pode ser repetido
 *    no mesmo canal com mesmo digest";
 *  - `hold_effect_unknown` — §5.8.4 item 3 e §6.7.3 item 6: efeito não
 *    conciliado barra saída que afirme sucesso;
 *  - `accept_terminal` — o único desfecho que deixa o terminal virar candidato;
 *  - `start_cancellation` — o prazo venceu e a escada do §6.7.3 começa;
 *  - `keep_observing` — nada mudou o bastante para decidir.
 */
export const OBSERVATION_DISPOSITIONS = [
  'ignore_stale_result',
  'treat_as_unknown',
  'conflict_terminal',
  'repeat_result_ack',
  'hold_effect_unknown',
  'accept_terminal',
  'start_cancellation',
  'keep_observing',
] as const;

export type ObservationDisposition = (typeof OBSERVATION_DISPOSITIONS)[number];

export interface ObservationSnapshotV1 {
  executor_state: ExecutorObservedStateV1;
  /** Resultado da CONSULTA de status, separado do estado observado. */
  lookup: 'found' | 'not_found' | 'unavailable';
  lease_alive: boolean;
  /**
   * A encarnação do supervisor e a geração do worker batem com as registradas
   * no run (§6.11, "reaper usa identidade de processo/geração, não PID
   * isolado"). É outra coisa que a lease: protege contra filho tardio, não
   * contra perda de posse do turno.
   */
  fence_matches: boolean;
  deadline_exceeded: boolean;
  /** Digest do terminal JÁ persistido para esta execução, ou `null`. */
  persisted_terminal_digest: string | null;
  /** Digest do terminal que ESTE frame trouxe, ou `null` se não veio terminal. */
  incoming_terminal_digest: string | null;
  /** Chamadas cujo efeito não foi conciliado (`effect_unknown`). */
  unreconciled_effect_calls: number;
}

/**
 * Decide o que fazer com o que o canal acabou de dizer. Função TOTAL.
 *
 * ─── Por que a POSSE domina tudo ────────────────────────────────────────────
 *
 * Porque um terminal impecável de uma tentativa que já não é dona é exatamente o
 * caso perigoso: ele parece adotável. O §5.7.3 é explícito — "Persistência de
 * resultado por tentativa sem posse não é permitida como 'atalho para não
 * perder'". Fence e lease são verificados como condições INDEPENDENTES porque
 * protegem coisas diferentes, e uma política que checasse só uma delas passaria
 * despercebida se os testes só as exercitassem juntas.
 */
export function decideObservation(s: ObservationSnapshotV1): ObservationDisposition {
  // 1. Sem posse ou sem fence, nada do que chegou é adotável (T15).
  if (!s.fence_matches || !s.lease_alive) return 'ignore_stale_result';

  // 2. Não achar não é prova de não ter executado (T14). §5.7.1: "Timeout de
  //    rede não é negativo de efeito."
  if (s.lookup !== 'found') return 'treat_as_unknown';

  // 3. Veio terminal: decidir entre repetição, conflito, retenção e adoção.
  const incoming = s.incoming_terminal_digest;
  if (incoming !== null) {
    const persisted = s.persisted_terminal_digest;
    if (persisted !== null) {
      // Digest diferente para a mesma execução é conflito; igual é redelivery,
      // e repetir o ACK não duplica custo nem outbound porque não reabre adoção.
      return persisted === incoming ? 'repeat_result_ack' : 'conflict_terminal';
    }
    // Um terminal íntegro NÃO libera efeito que ninguém conciliou (T13, T16).
    // Mesma régua de `recovery.ts`: a evidência de efeito domina o desfecho
    // aparente, porque ela é fato durável e o desfecho é proposta.
    if (s.unreconciled_effect_calls > 0) return 'hold_effect_unknown';
    return 'accept_terminal';
  }

  // 4. Executor assentado SEM proposta terminal. §6.7.2 item 8: "Falha de
  //    close/exit é condição observável, não 'done' por recebimento de result."
  if (isSettledExecutorState(s.executor_state)) return 'treat_as_unknown';

  // 5. EXAUSTIVIDADE, e não um default. Sobraram exatamente os três estados em
  //    voo; um membro novo em `EXECUTOR_OBSERVED_STATES` quebra a build AQUI, em
  //    vez de cair calado num ramo genérico. É o idioma que `recovery.ts` usa.
  switch (s.executor_state) {
    case 'admitted':
    case 'running':
    case 'cancelling':
      break;
    default: {
      const _never: never = s.executor_state;
      void _never;
      throw new TypeError(
        `supervisor: estado de executor sem regra declarada (${String(s.executor_state)}) — ver §6.11`,
      );
    }
  }

  // 6. Prazo vencido abre a escada de encerramento (T16).
  if (s.deadline_exceeded) return 'start_cancellation';

  return 'keep_observing';
}

// ─── cancelamento (`cancel`) ────────────────────────────────────────────────

/**
 * As disposições do CANCELAMENTO. A ordem delas É a ordem obrigatória do §6.7.3.
 *
 *  - `revoke_capabilities` — item 1: "Maia marca cancelamento/revogação e
 *    invalida fence/epoch/eligibilidade de saída (…); fecha a admissão de novas
 *    tools e de inferência". Vem primeiro, sempre;
 *  - `send_cancel` — item 2: só depois o supervisor emite o frame `cancel`;
 *  - `await_grace` — item 3: "Não cancelar somente o `Future` (…). Aguardar
 *    retorno real do executor; `cancel_ack` não o substitui";
 *  - `kill_process_group` — item 4: "Depois da tolerância configurada, terminar o
 *    processo/grupo/sandbox e aguardar o SO confirmar exit";
 *  - `reconcile_effects` — item 5/6: efeitos ficam `none`/`committed`/`unknown`
 *    num ledger separado, e os desconhecidos são conciliados antes de qualquer
 *    fallback ou nova tentativa;
 *  - `settle_cancelled` — item 5: "Marcar `cancelled` somente para o estado do
 *    executor RESOLVIDO".
 *
 * Nenhum membro significa "seguro repetir", e isso é o mecanismo, não um
 * esquecimento: cancelamento não prova ausência de efeito.
 */
export const CANCELLATION_DISPOSITIONS = [
  'revoke_capabilities',
  'send_cancel',
  'await_grace',
  'kill_process_group',
  'reconcile_effects',
  'settle_cancelled',
] as const;

export type CancellationDisposition = (typeof CANCELLATION_DISPOSITIONS)[number];

export interface CancellationSnapshotV1 {
  /** Categoria fechada do wire. Texto de cliente nunca vira instrução (§6.4.2). */
  reason: CancelReasonV1;
  capabilities_revoked: boolean;
  cancel_sent: boolean;
  /** Recebido — e deliberadamente SEM poder de encerrar (§6.4.2). */
  cancel_ack_received: boolean;
  grace_exceeded: boolean;
  /** O sistema operacional confirmou o exit? É o único fim aceitável. */
  process_exit_confirmed: boolean;
  unreconciled_effect_calls: number;
}

/**
 * Decide o próximo passo do encerramento. Função TOTAL.
 *
 * ─── Por que `cancel_ack_received` não aparece em nenhuma condição ──────────
 *
 * Porque ele não muda decisão nenhuma, e essa é a regra. O §6.4.2 define
 * `cancel_ack` como "controle recebido; não prova de interrupção ou ausência de
 * efeito", e o §5.7.2 manda "não fechar com base só no ACK". O campo fica no
 * instantâneo por ser observável e auditável; deixá-lo influenciar a escada é
 * precisamente o erro que a spec descreve. Um ACK com o processo ainda vivo
 * continua em `await_grace`.
 *
 * A `reason` também não altera a escada: revogar, pedir, esperar, matar e
 * conciliar valem para deadline, takeover, shutdown e rollback de política
 * igualmente.
 */
export function decideCancellation(s: CancellationSnapshotV1): CancellationDisposition {
  // 1. Revogar ANTES de pedir: a ordem inversa deixaria uma janela em que o
  //    filho ainda consegue pedir ferramenta (§6.7.3 item 1).
  if (!s.capabilities_revoked) return 'revoke_capabilities';

  // 2. Só então o frame de controle sai (§6.7.3 item 2).
  if (!s.cancel_sent) return 'send_cancel';

  // 3/4. Quem encerra é o EXIT confirmado, não o ACK e não o relógio.
  if (!s.process_exit_confirmed) {
    return s.grace_exceeded ? 'kill_process_group' : 'await_grace';
  }

  // 5. Processo morto NÃO converte efeito desconhecido em ausência de efeito
  //    (§6.11: "Não deduzir 'nenhum efeito' pela falta de callback/result").
  if (s.unreconciled_effect_calls > 0) return 'reconcile_effects';

  return 'settle_cancelled';
}

// ─── prazo e tolerância ─────────────────────────────────────────────────────

/** A escada de prazo: dentro, cancelar, matar. */
export type DeadlinePostureV1 = 'within_deadline' | 'cancel_due' | 'kill_due';

export interface DeadlineSnapshotV1 {
  now_ms: number;
  /** Prazo ABSOLUTO de execução (§5.3.1, `limits.deadline_at`). */
  execution_deadline_ms: number;
  /** Horizonte MÓVEL da lease atual (§5.8.1). */
  lease_horizon_ms: number;
  /** Tolerância entre pedir cancelamento e matar (§6.7.3 item 4). */
  grace_ms: number;
}

/**
 * Calcula a postura de prazo. Função TOTAL sobre entradas válidas; entrada
 * inválida é defeito de programação e falha ALTO.
 *
 * ─── Por que o prazo efetivo é o MÍNIMO dos dois ────────────────────────────
 *
 * §5.8.1, em letras: "`ctx.deadline` para tools no NOVO contexto deve ser getter
 * `min(deadline_execucao_absoluto, horizonte_lease_atual)`. Não capturar o
 * vencimento inicial em snapshot e congelá-lo por todo o run."
 *
 * As duas metades são necessárias e nenhuma implica a outra. A lease pode vencer
 * antes do prazo de execução (o dono perdeu a posse e continuar seria trabalhar
 * sem autoridade); e o prazo de execução vence mesmo com heartbeat saudável — a
 * mesma seção diz isso explicitamente, porque um orçamento de raciocínio não é
 * renovado por uma lease que está sendo bem renovada.
 */
export function deadlinePosture(s: DeadlineSnapshotV1): DeadlinePostureV1 {
  for (const [nome, valor] of [
    ['now_ms', s.now_ms],
    ['execution_deadline_ms', s.execution_deadline_ms],
    ['lease_horizon_ms', s.lease_horizon_ms],
    ['grace_ms', s.grace_ms],
  ] as const) {
    if (!Number.isFinite(valor)) {
      throw new TypeError(`deadlinePosture: ${nome} precisa ser um número finito`);
    }
  }
  if (s.grace_ms < 0) {
    throw new TypeError('deadlinePosture: grace_ms não pode ser negativo');
  }

  const effective = Math.min(s.execution_deadline_ms, s.lease_horizon_ms);
  if (s.now_ms < effective) return 'within_deadline';
  if (s.now_ms < effective + s.grace_ms) return 'cancel_due';
  return 'kill_due';
}

// ─── rollback de engine ─────────────────────────────────────────────────────

/**
 * Pode este turno cair para o motor local? Só depois de reconciliação.
 *
 * §6.11: "Rollback altera engine somente de novos turnos ou de tentativa
 * explicitamente reautorizada APÓS RECONCILIAÇÃO; não rodar MaiaEngine em
 * paralelo para 'cobrir' uma HermesEngine que pode ter produzido efeito."
 *
 * As duas condições são independentes e ambas necessárias. `run_closed` é a
 * palavra do JOURNAL (quem a dá é `closeRunAfterHandoff`, em `engine-repos.ts`),
 * não desta política — é mais uma junta onde este módulo consome a decisão de
 * outro em vez de recontá-la.
 */
export function mayFallBackToLocalEngine(s: {
  run_closed: boolean;
  unreconciled_effect_calls: number;
}): boolean {
  return s.run_closed && s.unreconciled_effect_calls === 0;
}

// ─── a junta com `recovery.ts` ──────────────────────────────────────────────

/**
 * As disposições cujo PRÓXIMO PASSO não pertence a esta política.
 *
 * Cada uma nomeia uma incerteza DURÁVEL — admitido sem executar, resultado sem
 * posse, status que sumiu, efeito não conciliado, dois terminais divergentes. A
 * pergunta seguinte ("o que é seguro fazer com o run?") é a do §5.8.2, e quem a
 * responde é `classifyRecovery`, que enxerga o journal inteiro.
 *
 * A lista existe para que essa entrega seja VERIFICÁVEL em vez de convencional:
 * sem ela, "compõe com recovery" seria uma frase de comentário. O complemento
 * também importa — `accept_terminal`, `keep_observing`, `admit_new` e
 * `settle_cancelled` ficam de fora porque o supervisor os resolve sozinho, e uma
 * lista que contivesse tudo não distinguiria nada.
 */
export const DEFERS_TO_RECOVERY = [
  'reconcile_admitted_not_executed',
  'conflict_payload',
  'ignore_stale_result',
  'treat_as_unknown',
  'conflict_terminal',
  'hold_effect_unknown',
  'reconcile_effects',
] as const;

export type DefersToRecovery = (typeof DEFERS_TO_RECOVERY)[number];
