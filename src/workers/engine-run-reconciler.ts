/**
 * Spec Maia+Hermes §5.8.2/§5.8.4, INV-09 — O RECONCILIADOR de runs do motor.
 *
 * ─── O buraco que este worker fecha ─────────────────────────────────────────
 *
 * `engineRunsRepo.listDueRuns` e `classifyRecovery` existiam sem um único
 * consumidor de produção. Isso não era dívida decorativa: `routeExistingRun`
 * decide que um turno com run ABERTO não reexecuta o pipeline, e `agent/core.ts`
 * marca esse turno como `retry` dizendo, no comentário, que "quem o retoma é o
 * caminho de manutenção (`listDueRuns`), que sabe tomar o fence dele". Como esse
 * caminho não existia, o turno fazia backoff até esgotar `MAX_TURN_ATTEMPTS` e
 * caía em dead letter — sem que ninguém tivesse olhado o run uma vez sequer.
 *
 * Este módulo é o caminho que faltava: a varredura que abre o journal, decide
 * pela política PURA do §5.8.2 e escreve pelas portas que já provam o que
 * afirmam.
 *
 * ─── O fence, e por que ele NÃO é o claim do turno ──────────────────────────
 *
 * Toda operação do caminho do DONO passa por `lockTurnAndCheckFence`: claim
 * token vigente, lease viva, turno em `running`. A manutenção não passa, e não
 * pode passar — o §5.8.4 existe exatamente para quando o turno já não é
 * reivindicável, e `reserveMaintenanceObservation` só concede a reserva quando
 * o dono sumiu (`owner_alive` recusa o contrário). As duas condições são
 * mutuamente exclusivas por construção.
 *
 * O fence desta varredura é outro, e são dois degraus:
 *
 *  1. `reserveMaintenanceObservation` empurra `next_poll_at` para a frente —
 *     quem chegar depois recebe `not_due` e vai embora. Exclusão sem coluna
 *     nova e sem um segundo lease para manter vivo;
 *  2. `recordMaintenanceObservation` faz CAS pela `row_version` reservada. Uma
 *     varredura atrasada, ou uma cuja linha andou entre a leitura e a escrita,
 *     recebe `reservation_stale` e **não escreve nada** — nem a observação, nem
 *     a ação que viria depois dela.
 *
 * Daí a ORDEM aqui: registra a decisão PRIMEIRO, age depois. Não é cosmética.
 * Agir antes de registrar deixaria a ação sem o CAS na frente dela, e uma
 * réplica atrasada conseguiria bloquear ou fechar um run que outra já tinha
 * movido. Registrar primeiro faz da perda de fence uma recusa ANTES de qualquer
 * escrita de estado — que é a propriedade que o §5.8.4 item 4 pede em letras
 * ("falha de CAS exige nova leitura, não payload cego").
 *
 * ─── O que este worker NÃO faz, e por quê ───────────────────────────────────
 *
 * **Não adota terminal e não entrega resposta.** `adoptTerminalResult` exige
 * fence de turno VIVO; a reserva de manutenção só existe quando o dono morreu.
 * A adoção é, pelo §5.8.2, trabalho de "novo owner" — quem reivindica o turno,
 * não quem varre o journal. O que esta varredura faz por um `result_ready` é
 * registrá-lo e, passado o prazo de reconciliação, mandá-lo para `blocked`, que
 * é o que tira o turno do laço de retry e o põe na frente de uma pessoa.
 *
 * **Não chama o motor.** `observe`/`cancel` do `AgentEnginePortV1` são I/O de
 * rede com adapter, credencial e instância pinada; montá-los aqui duplicaria a
 * fiação do caminho de start. As disposições que dependem deles
 * (`query_same_request_key`, `cancel_and_reconcile`, a metade `observe` de
 * `revoke_and_observe`) ficam em OBSERVAÇÃO até o `reconcile_deadline_at`, e
 * depois dele viram `blocked` — que é literalmente a linha do §5.8.2 para o
 * lookup que não conclui: "preservar request key/journal, revogar capacidades;
 * blocked após prazo".
 *
 * **Nunca declara um run morto por ausência de registro.** Nenhum caminho daqui
 * fecha um run em `submitting`/`submission_unknown`. É o INV-06 inteiro: um run
 * que pode ter sido aceito pelo motor não vira `safe_to_retry` porque o
 * varredor não achou prova — ausência de prova não é prova de ausência.
 */
import { logger } from '@/lib/logger.js';
import { incCounter } from '@/lib/metrics.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { classifyRecovery, type RecoveryDisposition } from '@/runtime/engines/recovery.js';
import { RECOVERABLE_TURN_STATUSES } from '@/runtime/turns/contract.js';
import type {
  DueRun,
  DueScopeCursor,
  DueRunCursor,
  RunRecoveryFacts,
  engineRunsRepo,
} from '@/db/repositories/engine-repos.js';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

/**
 * As portas do journal que esta varredura usa. `Pick` sobre o repositório real,
 * e não uma interface redigitada: uma assinatura que mude no repositório tem de
 * quebrar o build AQUI, e não passar despercebida porque a cópia local ainda
 * compila.
 */
export type EngineJournalMaintenancePortV1 = Pick<
  typeof engineRunsRepo,
  | 'enumerateDueScopes'
  | 'listDueRuns'
  | 'readRecoveryFacts'
  | 'reserveMaintenanceObservation'
  | 'recordMaintenanceObservation'
  | 'revokeRunCapabilities'
  | 'markRunBlocked'
  | 'closeRunAfterHandoff'
>;

export type ReconcilerDepsV1 = {
  repo: EngineJournalMaintenancePortV1;
  /** O escopo por par. Injetável para que a política seja exercitável sem ALS. */
  withScope: <T>(
    scope: { tenant_id: string; agent_id: string },
    fn: () => Promise<T>,
  ) => Promise<T>;
};

/**
 * Os três tetos deste worker são CONSTANTES, e não variáveis de ambiente.
 *
 * O contrato de configuração (#515) proíbe ler `process.env` direto, e a porta
 * legítima seria declarar as três em `src/config/contract.ts` — o que regenera
 * `.env.example`, `docs/configuration.md`, schema, manifesto e fixtures, com
 * gate de drift próprio. Pagar isso por um número que ninguém ainda precisou
 * mudar seria inventar superfície de operação antes de existir o problema que
 * ela resolve. Se um dia houver motivo medido para ajustá-los em produção, a
 * mudança é declará-los no contrato, e ela será visível.
 */

/** Pares por tick. Teto de JUSTIÇA, não de correção — o resto drena no próximo. */
const SCOPE_LIMIT = 50;
/** Runs por par, por tick. Mesmo raciocínio de `SWEEP_LIMIT_PER_SCOPE` (#633). */
const RUN_LIMIT_PER_SCOPE = 100;
/**
 * Janela da reserva de manutenção.
 *
 * É o tempo em que este run fica FORA da vista das outras réplicas. Curta
 * demais e duas varreduras disputam a mesma linha; longa demais e um run
 * legítimo espera por nada depois de a réplica reservante morrer. Um minuto
 * casa com a cadência do tick: no pior caso, uma réplica que caia logo após
 * reservar custa um tick de atraso, não um minuto de indisponibilidade.
 */
const RESERVATION_WINDOW_MS = 60_000;

/**
 * Identidade desta encarnação, para `actor_ref`.
 *
 * `hostname:pid` sozinho não basta — o PID é reciclado, e duas encarnações no
 * mesmo container apareceriam como o mesmo ator no journal. Mesmo raciocínio
 * (e mesma forma) de `turnWorkerId`, sem reusá-lo porque aquele id carrega
 * `:turn:` e afirmaria, no evento, que quem agiu foi o dono do turno.
 */
let cachedActorRef: string | null = null;
function reconcilerActorRef(): string {
  cachedActorRef ??= `${hostname()}:${process.pid}:engine-reconciler:${randomUUID().slice(0, 8)}`;
  return cachedActorRef;
}

/** Só para teste: força uma nova identidade (simula outra réplica). */
export function __resetReconcilerActorRefForTest(): void {
  cachedActorRef = null;
}

/**
 * Os códigos que a varredura grava em `engine_run_events` e conta em métrica.
 *
 * FECHADOS de propósito, pela mesma razão de `RouteErrorCodeV1`: um código
 * livre vira cardinalidade infinita em Prometheus e um rótulo que ninguém
 * consegue procurar no journal depois.
 */
export const RECONCILE_CODES = [
  /** Run já resolvido pela porta própria: nada a decidir. */
  'nothing_to_do',
  /** O dono está vivo e resolve; a varredura não disputa (§5.8.2, `running`). */
  'owner_alive',
  /** Terminal persistido esperando um NOVO DONO que o adote (§5.8.2). */
  'awaiting_owner_adoption',
  /** Submetido sem ID: só um lookup pela MESMA `request_key` resolve. */
  'awaiting_engine_lookup',
  /** Cancelamento pedido e não observado até terminal (§5.7.2). */
  'awaiting_engine_cancel',
  /** Capacidades revogadas agora, ou já revogadas antes (monotônico). */
  'capabilities_revoked',
  /** Há chamada com efeito que ninguém conciliou (§5.8.4 item 3). */
  'effect_unreconciled',
  /** A conversa é de um humano: nova geração está fora de questão (§8.2). */
  'human_control',
  /** Turno já comprometido ou terminal: só metadata (§5.8.4 item 1). */
  'metadata_only',
  /** Órfão fechado como `safe_to_retry` pelo scanner (§5.7.3 item 5). */
  'orphan_closed',
  /** O prazo de reconciliação passou e ninguém concluiu: vai para gente. */
  'blocked_after_deadline',
  /** A política já mandou parar (`blocked` no journal, ou dead letter com efeito). */
  'blocked_by_policy',
] as const;

export type ReconcileCodeV1 = (typeof RECONCILE_CODES)[number];

/**
 * O que fazer com um run depois de reservado.
 *
 * `observe` é a ação MAIS COMUM e não é um não-fazer: ela carimba
 * `last_observed_at`, empurra a próxima visita e deixa no journal a linha
 * `reconcile_decision` que um operador lê depois. A ausência de um membro
 * "retomar a sequência de ferramentas" é a mesma ausência deliberada de
 * `RECOVERY_DISPOSITIONS` — enquanto o tipo não conseguir expressar a ação
 * proibida pelo INV-09, nenhum call site consegue pedi-la.
 */
export type ReconcileActionV1 =
  | { kind: 'observe'; code: ReconcileCodeV1 }
  | { kind: 'revoke'; code: ReconcileCodeV1 }
  | { kind: 'close_orphan'; code: ReconcileCodeV1 }
  | { kind: 'block'; code: ReconcileCodeV1 };

const TURNOS_REIVINDICAVEIS = new Set<string>(RECOVERABLE_TURN_STATUSES);

/**
 * O órfão do §5.7.3 item 5 — "o scanner fecha órfãos com `actor_kind=recovery`".
 *
 * Quatro condições, e cada uma tira uma afirmação falsa da boca do fechamento:
 *
 *  - turno FORA de `RECOVERABLE_TURN_STATUSES`: nenhum dono novo virá, então
 *    deixar o run aberto não preserva nada para ninguém;
 *  - `outbound_rows === 0`: `safe_to_retry` AFIRMA que não houve saída, e uma
 *    linha de egresso desmente a afirmação (o repositório recusa com
 *    `outbound_present`, mas pedir o que se sabe impossível é ruído);
 *  - `unreconciled_calls === 0` e `effect_unknown_calls === 0`: invariante 7 —
 *    retry seguro exige efeito reconciliado E ausente.
 *
 * O repositório REPROVA tudo isto de novo sob lock, e com um predicado mais
 * largo (`effect_evidence <> 'none'` pega a chamada `completed` que mexeu no
 * mundo). Esta função não é a garantia: ela evita pedir o que já se sabe que
 * será recusado. A garantia mora onde as linhas estão travadas.
 */
function orfaoFechavel(f: RunRecoveryFacts): boolean {
  return (
    !TURNOS_REIVINDICAVEIS.has(f.turn_status) &&
    f.outbound_rows === 0 &&
    f.unreconciled_calls === 0 &&
    f.effect_unknown_calls === 0
  );
}

/**
 * Traduz a disposição do §5.8.2 na ação que ESTA varredura consegue executar.
 * Função TOTAL e pura — testável sem banco, sem relógio e sem motor.
 *
 * ─── Por que o prazo é o eixo ───────────────────────────────────────────────
 *
 * Quatro disposições (`query_same_request_key`, `cancel_and_reconcile`,
 * `revoke_and_observe`, `adopt_terminal`) pedem algo que este worker não faz:
 * falar com o motor, ou reivindicar o turno. Se elas só observassem, o run
 * ficaria em observação para sempre e o turno no laço de retry — o mesmo limbo
 * que este módulo existe para acabar, agora com um evento por minuto por cima.
 *
 * O `reconcile_deadline_at` é o que corta isso, e não é invenção: o §5.8.2 dá
 * `blocked` explicitamente como desfecho do lookup inconclusivo "após prazo", e
 * o §5.7.1 trata `blocked` como a porta que exige gente. Um run `blocked` faz
 * `routeExistingEngineRun` devolver `await_operator`, e `decideRouteTurnAction`
 * manda o turno para dead letter com `unsafe_to_retry` — que é o desfecho
 * honesto para trabalho que pode ter tocado o mundo e ninguém conseguiu
 * confirmar.
 *
 * `reconcile_only` também bloqueia após o prazo: efeito desconhecido que
 * ninguém conciliou dentro da janela é precisamente o caso do §5.8.4 item 6.
 *
 * `maintenance_only` NUNCA bloqueia, e a exceção é deliberada. Ela cobre dois
 * casos normais — conversa em mão humana e turno já comprometido/terminal — e
 * nenhum dos dois é anomalia: mandar um handover de atendimento para a fila de
 * intervenção encheria a DLQ de eventos que já têm dono.
 */
export function planRunReconciliation(
  disposition: RecoveryDisposition,
  facts: RunRecoveryFacts,
): ReconcileActionV1 {
  const prazoVencido = facts.reconcile_deadline_passed;

  switch (disposition) {
    case 'nothing_to_do':
      return { kind: 'observe', code: 'nothing_to_do' };

    // O dono vivo resolve. Chegar aqui é raro (a reserva recusa com
    // `owner_alive`), mas a política é quem decide e não a reserva.
    case 'resume_owner':
      return { kind: 'observe', code: 'owner_alive' };

    case 'maintenance_only':
      if (orfaoFechavel(facts)) return { kind: 'close_orphan', code: 'orphan_closed' };
      return {
        kind: 'observe',
        code: facts.control_mode === 'bot' ? 'metadata_only' : 'human_control',
      };

    case 'reconcile_only':
      return prazoVencido
        ? { kind: 'block', code: 'blocked_after_deadline' }
        : { kind: 'observe', code: 'effect_unreconciled' };

    case 'adopt_terminal':
      return prazoVencido
        ? { kind: 'block', code: 'blocked_after_deadline' }
        : { kind: 'observe', code: 'awaiting_owner_adoption' };

    // INV-06 EM UMA LINHA: `submitting`/`submission_unknown` observam e, no
    // limite, bloqueiam. NUNCA fecham. Fechar aqui seria ler "não encontrei
    // registro do run" como "o motor não aceitou o trabalho".
    case 'query_same_request_key':
      return prazoVencido
        ? { kind: 'block', code: 'blocked_after_deadline' }
        : { kind: 'observe', code: 'awaiting_engine_lookup' };

    case 'cancel_and_reconcile':
      return prazoVencido
        ? { kind: 'block', code: 'blocked_after_deadline' }
        : { kind: 'observe', code: 'awaiting_engine_cancel' };

    // A revogação é a metade que NÃO precisa do motor, e é monotônica: pedi-la
    // de novo sobre um run já revogado preservaria o carimbo original, mas
    // gastaria uma transação por tick para não mudar nada.
    case 'revoke_and_observe':
      if (prazoVencido) return { kind: 'block', code: 'blocked_after_deadline' };
      return facts.capabilities_revoked
        ? { kind: 'observe', code: 'capabilities_revoked' }
        : { kind: 'revoke', code: 'capabilities_revoked' };

    case 'block':
      return { kind: 'block', code: 'blocked_by_policy' };

    default: {
      // EXAUSTIVIDADE provada pelo compilador, como em `classifyRecovery`: uma
      // disposição nova quebra a build aqui em vez de cair num ramo genérico
      // que agiria sobre um estado que este build não entende.
      const _never: never = disposition;
      void _never;
      throw new TypeError(
        `engine-run-reconciler: disposição sem plano (${String(disposition)}) — ver §5.8.2`,
      );
    }
  }
}

function conta(result: string, code: string): void {
  incCounter('maia_engine_reconciler_runs_total', { result, code });
}

export type ReconcileRunOutcomeV1 = {
  /** `skipped` = a reserva recusou; nenhuma escrita aconteceu. */
  result: 'acted' | 'skipped' | 'refused' | 'failed';
  code: string;
};

/**
 * Reconcilia UM run. Reserva → lê → decide → registra → age.
 *
 * O `expected_row_version` do fechamento é a `row_version` que a GRAVAÇÃO da
 * observação devolveu, não a da reserva: o registro já consumiu a reserva e
 * incrementou a versão, então repassar a da reserva produziria um
 * `version_conflict` garantido. O fence continua encadeado — quem perdeu a
 * corrida perdeu no registro e nunca chega ao fechamento.
 */
export async function reconcileDueRun(
  repo: EngineJournalMaintenancePortV1,
  due: DueRun,
): Promise<ReconcileRunOutcomeV1> {
  const actor = { kind: 'recovery' as const, actor_ref: reconcilerActorRef() };

  const reserva = await repo.reserveMaintenanceObservation({
    run_id: due.run_id,
    window_ms: RESERVATION_WINDOW_MS,
    actor,
  });
  if (!reserva.ok) {
    // Nenhuma das quatro recusas é erro: `not_due` e `owner_alive` são a
    // exclusão funcionando, `phase_conflict` é o run já fechado por outra
    // porta, `not_found` é a linha que sumiu entre a listagem e a reserva.
    conta('skipped', reserva.reason);
    return { result: 'skipped', code: reserva.reason };
  }

  const facts = await repo.readRecoveryFacts({ run_id: due.run_id });
  if (facts === null) {
    conta('skipped', 'facts_not_found');
    return { result: 'skipped', code: 'facts_not_found' };
  }

  /**
   * `last_observation: null` é uma AFIRMAÇÃO, não um placeholder: esta
   * varredura não pergunta ao motor, então ela não observou nada. O §5.8.2
   * proíbe confundir "não perguntei" com `definitely_not_accepted`, e
   * `classifyRecovery` trata os dois de forma diferente — com `null` um
   * `submission_unknown` vira `query_same_request_key` (alguém ainda precisa
   * perguntar), e não `reconcile_only`.
   */
  const disposition = classifyRecovery({ ...facts, last_observation: null });
  const plano = planRunReconciliation(disposition, facts);

  // A DECISÃO ANTES DA AÇÃO. O CAS pela `row_version` reservada é o fence: se
  // ele falhar, saímos sem tocar em fase, capacidades ou fechamento.
  const registro = await repo.recordMaintenanceObservation({
    run_id: due.run_id,
    reserved_row_version: reserva.reserved_row_version,
    actor,
    observation: {
      code: plano.code,
      detail: {
        disposition,
        action: plano.kind,
        phase: facts.phase,
        turn_status: facts.turn_status,
        control_mode: facts.control_mode,
        unreconciled_calls: facts.unreconciled_calls,
        effect_unknown_calls: facts.effect_unknown_calls,
        outbound_rows: facts.outbound_rows,
        reconcile_deadline_passed: facts.reconcile_deadline_passed,
      },
    },
  });
  if (!registro.ok) {
    conta('refused', registro.reason);
    logger.warn(
      { run_id: due.run_id, turn_id: due.turn_id, reason: registro.reason, disposition },
      'engine_run_reconciler.fence_lost',
    );
    return { result: 'refused', code: registro.reason };
  }

  if (plano.kind === 'observe') {
    conta('acted', plano.code);
    return { result: 'acted', code: plano.code };
  }

  if (plano.kind === 'revoke') {
    const r = await repo.revokeRunCapabilities({
      run_id: due.run_id,
      turn_id: facts.turn_id,
      actor,
      reason_code: 'recovery_owner_lost',
    });
    if (!r.ok) {
      conta('refused', `revoke_${r.reason}`);
      return { result: 'refused', code: `revoke_${r.reason}` };
    }
    conta('acted', plano.code);
    return { result: 'acted', code: plano.code };
  }

  if (plano.kind === 'close_orphan') {
    const r = await repo.closeRunAfterHandoff({
      run_id: due.run_id,
      turn_id: facts.turn_id,
      decision: 'safe_to_retry',
      actor,
      expected_row_version: registro.row_version,
    });
    if (!r.ok) {
      // A recusa é o repositório PROVANDO que o fechamento era falso. Ela fica
      // contada e logada, e o run continua aberto — que é o desfecho certo.
      conta('refused', `close_${r.reason}`);
      logger.warn(
        { run_id: due.run_id, turn_id: due.turn_id, reason: r.reason },
        'engine_run_reconciler.orphan_close_refused',
      );
      return { result: 'refused', code: `close_${r.reason}` };
    }
    conta('acted', plano.code);
    return { result: 'acted', code: plano.code };
  }

  const r = await repo.markRunBlocked({
    run_id: due.run_id,
    turn_id: facts.turn_id,
    actor,
    error_code: plano.code,
    evidence: {
      disposition,
      phase: facts.phase,
      turn_status: facts.turn_status,
      remote_run_id_known: facts.remote_run_id_known,
      effect_unknown_calls: facts.effect_unknown_calls,
      unreconciled_calls: facts.unreconciled_calls,
      reconcile_deadline_passed: facts.reconcile_deadline_passed,
    },
  });
  if (!r.ok) {
    conta('refused', `block_${r.reason}`);
    return { result: 'refused', code: `block_${r.reason}` };
  }
  // `ops_alert` porque `blocked` é o único desfecho desta varredura que EXIGE
  // uma pessoa: o turno vai para dead letter e a conversa fica sem resposta.
  logger.error(
    {
      run_id: due.run_id,
      turn_id: due.turn_id,
      disposition,
      phase: facts.phase,
      already_blocked: r.already_blocked,
      ops_alert: true,
    },
    'engine_run_reconciler.run_blocked',
  );
  conta('acted', plano.code);
  return { result: 'acted', code: plano.code };
}

export type TickStats = {
  scopes: number;
  scopes_failed: number;
  runs_seen: number;
  acted: number;
  skipped: number;
  refused: number;
  failed: number;
};

async function reconcileScope(
  repo: EngineJournalMaintenancePortV1,
  stats: TickStats,
): Promise<void> {
  let cursor: DueRunCursor | null = null;
  let restante = RUN_LIMIT_PER_SCOPE;

  while (restante > 0) {
    const pagina = await repo.listDueRuns({
      limit: Math.min(restante, 50),
      cursor,
    });
    if (pagina.runs.length === 0) return;

    for (const due of pagina.runs) {
      stats.runs_seen++;
      restante--;
      try {
        const outcome = await reconcileDueRun(repo, due);
        stats[outcome.result]++;
      } catch (err) {
        // Fail-isolated por RUN: um journal corrompido não pode parar a
        // varredura dos outros. Mesmo regime de `procedure-execution-reaper`.
        stats.failed++;
        conta('failed', 'exception');
        logger.warn(
          { run_id: due.run_id, turn_id: due.turn_id, err: (err as Error).message },
          'engine_run_reconciler.run_failed',
        );
      }
    }

    cursor = pagina.next_cursor;
    if (cursor === null) return;
  }
}

/**
 * O tick.
 *
 * Duas varreduras encaixadas, e a fronteira entre elas é o ISOLAMENTO:
 * `enumerateDueScopes` roda CROSS-TENANT e sem ALS (é a única operação do
 * repositório que não pode chamar `scope()`), e devolve pares e cursor, nunca
 * conteúdo. Tudo que vem depois roda DENTRO de `runWithTenantContext`, por par,
 * onde `listDueRuns` volta a exigir escopo e a lançar sem ele.
 *
 * Sem lock global, de propósito. O que impede duas réplicas de agirem sobre o
 * mesmo run é a reserva (`next_poll_at` empurrado) mais o CAS do registro — no
 * lock de row do PostgreSQL, não em disciplina de código. Um advisory lock
 * global aqui não acrescentaria garantia e custaria justamente o que mais
 * importa: a recuperação precisa continuar rodando quando uma réplica adoece.
 */
export async function runEngineRunReconciler(deps?: Partial<ReconcilerDepsV1>): Promise<TickStats> {
  const repo = deps?.repo ?? (await import('@/db/repositories/engine-repos.js')).engineRunsRepo;
  const withScope = deps?.withScope ?? runWithTenantContext;

  const stats: TickStats = {
    scopes: 0,
    scopes_failed: 0,
    runs_seen: 0,
    acted: 0,
    skipped: 0,
    refused: 0,
    failed: 0,
  };

  let cursor: DueScopeCursor | null = null;
  let restante = SCOPE_LIMIT;

  while (restante > 0) {
    const pagina = await repo.enumerateDueScopes({
      limit: Math.min(restante, 25),
      cursor,
    });
    if (pagina.scopes.length === 0) break;

    for (const escopo of pagina.scopes) {
      restante--;
      try {
        await withScope(escopo, () => reconcileScope(repo, stats));
        stats.scopes++;
      } catch (err) {
        // Fail-isolated por PAR, como reflection-batch (#251) e o reaper: um
        // tenant doente não cala a varredura dos outros.
        stats.scopes_failed++;
        logger.warn(
          { ...escopo, err: (err as Error).message },
          'engine_run_reconciler.scope_failed',
        );
      }
    }

    cursor = pagina.next_cursor;
    if (cursor === null) break;
  }

  if (stats.runs_seen > 0 || stats.scopes_failed > 0) {
    logger.info(stats, 'engine_run_reconciler.done');
  }
  return stats;
}
