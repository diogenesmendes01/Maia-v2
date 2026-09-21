/**
 * U-P04.7a (spec §8.2.3, §8.2.5, §8.3) — o CHAMADOR DE PRODUÇÃO do controle
 * humano.
 *
 * ─── Por que este módulo existe ─────────────────────────────────────────────
 *
 * `conversationControlRepo` tem a máquina inteira: pausa, reconciliação e
 * retomada, cada uma transacional, fenceada por epoch e idempotente por
 * comando. E, até aqui, **ninguém a chamava**. Um `grep` por
 * `pauseConversationTx`/`resumeConversationTx` fora do próprio repositório não
 * devolvia nada (C23). O controle humano existia como capacidade do banco e
 * não existia como operação do produto.
 *
 * Este módulo é a porta. Ele não reimplementa nada do que o repositório já faz
 * — e, em particular, **não reaudita**: as linhas `conversation_pause_requested`,
 * `conversation_control_acquired` e `conversation_control_conflict` são
 * escritas DENTRO das transações, no mesmo `tx` da mudança de estado, que é o
 * único lugar onde elas não podem divergir do fato. Auditar de novo aqui
 * produziria duas linhas para um evento, e a segunda seria a mentirosa no dia
 * em que a transação fizesse rollback.
 *
 * ─── O que ele acrescenta ───────────────────────────────────────────────────
 *
 * A SEQUÊNCIA. `pauseConversationTx` devolve `drain_status`, e um `pause` que
 * volta com dreno incompleto não é uma pausa concluída: há efeito de engine em
 * voo, e alguém precisa reconciliar antes de o controle poder ser declarado
 * adquirido. Nenhum chamador fazia isso porque não havia chamador. Aqui a
 * pausa e a reconciliação viram uma operação só, com a reconciliação
 * acontecendo no MESMO epoch que a pausa devolveu.
 *
 * ─── O que ele deliberadamente NÃO faz ──────────────────────────────────────
 *
 * Não decide autorização. Quem pode pausar uma conversa é pergunta da ACL do
 * console (§8.3), e respondê-la aqui criaria um segundo lugar onde a resposta
 * mora. O serviço recebe `requested_by_app_user_id` já autenticado e o repassa
 * — o repositório é quem recusa com `forbidden`.
 *
 * Não faz auto-resume. Nem por timeout, nem por logout do operador, nem por
 * expiração de sessão (§8.2.5). Alerta de abandono não é autorização para o
 * bot voltar, e por isso não existe aqui nenhum caminho que retome sozinho.
 */
import { logger } from '@/lib/logger.js';
import {
  conversationControlRepo,
  type PauseConversationResult,
  type PauseReasonCode,
  type ReconcilePauseResult,
  type ResumeConversationResult,
  type ResumeReasonCode,
} from '@/db/repositories/conversation-control-repo.js';

/** Comando de pausa vindo do console, com o operador já autenticado. */
export type PauseCommandV1 = {
  control_id: string;
  /** Decimal canônico: a coluna é bigint (§8.3.2). */
  expected_epoch: string;
  idempotency_key: string;
  requested_by_app_user_id: string;
  reason_code: PauseReasonCode;
  request_payload: unknown;
};

export type ResumeCommandV1 = {
  control_id: string;
  expected_epoch: string;
  idempotency_key: string;
  requested_by_app_user_id: string;
  reason_code: ResumeReasonCode;
  request_payload: unknown;
};

/**
 * O desfecho da pausa COM a reconciliação já tentada.
 *
 * `acquired` é o único estado em que o operador pode assumir com segurança:
 * a conversa está em modo humano E não há efeito de engine em aberto.
 *
 * `reconciliation_required` NÃO é falha. A pausa valeu — a automação já está
 * barrada —, mas há efeito em voo que ninguém pode declarar resolvido. O
 * console mostra isso como estado, não como erro, e o §8.2.4 é explícito em
 * que entrega em voo conserva `delivery_unknown` sem reenvio cego.
 */
export type PauseOutcomeV1 =
  | {
      kind: 'acquired';
      control_id: string;
      epoch: string;
      idempotent: boolean;
      command_id: string;
    }
  | {
      kind: 'reconciliation_required';
      control_id: string;
      epoch: string;
      command_id: string;
      inflight_effects: number;
      unknown_deliveries: number;
      /** O dreno mede SÓ egresso de origem engine — ver `ReconcilePauseResult`. */
      drain_scope: 'engine_originated_only';
    }
  | { kind: 'refused'; reason: string; current_epoch?: string; current_mode?: string };

export type ResumeOutcomeV1 =
  | {
      kind: 'resumed';
      control_id: string;
      epoch: string;
      idempotent: boolean;
      command_id: string;
      /** Watermark: só inbound DEPOIS dele volta a ser automatizado (§8.2.5). */
      resume_after_ingress_seq: string;
      backlog_cancelled: number;
    }
  | { kind: 'refused'; reason: string; current_epoch?: string; current_mode?: string };

function recusaDaPausa(r: Extract<PauseConversationResult, { ok: false }>): PauseOutcomeV1 {
  return {
    kind: 'refused',
    reason: r.reason,
    ...(r.current_epoch !== undefined ? { current_epoch: r.current_epoch } : {}),
    ...(r.current_mode !== undefined ? { current_mode: r.current_mode } : {}),
  };
}

/**
 * Pausa a conversa e leva o dreno até onde ele der, numa operação só.
 *
 * A reconciliação usa o epoch DEVOLVIDO pela pausa, nunca o `expected_epoch`
 * do comando: a pausa incrementa o epoch, e reconciliar com o valor antigo
 * seria recusado por `epoch_mismatch` — uma falha que pareceria corrida e
 * seria só erro de sequenciamento nosso.
 */
export async function pauseConversation(cmd: PauseCommandV1): Promise<PauseOutcomeV1> {
  const pausa = await conversationControlRepo.pauseConversationTx({
    control_id: cmd.control_id,
    expected_epoch: cmd.expected_epoch,
    idempotency_key: cmd.idempotency_key,
    requested_by_app_user_id: cmd.requested_by_app_user_id,
    reason_code: cmd.reason_code,
    request_payload: cmd.request_payload,
  });

  if (!pausa.ok) {
    logger.warn(
      { control_id: cmd.control_id, reason: pausa.reason, operator: cmd.requested_by_app_user_id },
      'conversation_control.pause_refused',
    );
    return recusaDaPausa(pausa);
  }

  // Dreno já completo na própria pausa: nada em voo, controle adquirido.
  if (pausa.drain_status === 'complete') {
    return {
      kind: 'acquired',
      control_id: pausa.control_id,
      epoch: pausa.epoch,
      idempotent: pausa.idempotent,
      command_id: pausa.command_id,
    };
  }

  const reconciliacao: ReconcilePauseResult = await conversationControlRepo.reconcilePauseTx({
    control_id: pausa.control_id,
    expected_epoch: pausa.epoch,
    // Chave DERIVADA da do comando, e estável: um retry do mesmo comando de
    // pausa tem de reencontrar a MESMA reconciliação, não abrir outra.
    idempotency_key: `${cmd.idempotency_key}:reconcile`,
    requested_by_app_user_id: cmd.requested_by_app_user_id,
  });

  if (!reconciliacao.ok) {
    // A PAUSA valeu — a automação está barrada e o epoch subiu. O que falhou
    // foi só a tentativa de declarar o dreno concluído, então o desfecho
    // honesto é "precisa de reconciliação", e não uma recusa que sugeriria
    // que a conversa continua com o bot.
    logger.warn(
      {
        control_id: pausa.control_id,
        epoch: pausa.epoch,
        reason: reconciliacao.reason,
      },
      'conversation_control.reconcile_after_pause_refused',
    );
    return {
      kind: 'reconciliation_required',
      control_id: pausa.control_id,
      epoch: pausa.epoch,
      command_id: pausa.command_id,
      inflight_effects: pausa.inflight_effects,
      unknown_deliveries: pausa.unknown_deliveries,
      drain_scope: 'engine_originated_only',
    };
  }

  if (reconciliacao.drain_status === 'complete') {
    return {
      kind: 'acquired',
      control_id: pausa.control_id,
      epoch: reconciliacao.epoch,
      idempotent: pausa.idempotent,
      command_id: pausa.command_id,
    };
  }

  return {
    kind: 'reconciliation_required',
    control_id: pausa.control_id,
    epoch: reconciliacao.epoch,
    command_id: pausa.command_id,
    inflight_effects: reconciliacao.inflight_effects,
    unknown_deliveries: reconciliacao.unknown_deliveries,
    drain_scope: reconciliacao.drain_scope,
  };
}

/**
 * Reconcilia uma pausa que ficou com dreno em aberto.
 *
 * Separada da pausa porque o operador volta a ela DEPOIS — o efeito em voo
 * termina no seu tempo, não no da transação de pausa.
 */
export async function reconcilePause(cmd: {
  control_id: string;
  expected_epoch: string;
  idempotency_key: string;
  requested_by_app_user_id: string;
}): Promise<PauseOutcomeV1> {
  const r = await conversationControlRepo.reconcilePauseTx(cmd);
  if (!r.ok) {
    return {
      kind: 'refused',
      reason: r.reason,
      ...(r.current_epoch !== undefined ? { current_epoch: r.current_epoch } : {}),
      ...(r.current_mode !== undefined ? { current_mode: r.current_mode } : {}),
    };
  }
  if (r.drain_status === 'complete') {
    return {
      kind: 'acquired',
      control_id: r.control_id,
      epoch: r.epoch,
      idempotent: r.idempotent,
      command_id: cmd.idempotency_key,
    };
  }
  return {
    kind: 'reconciliation_required',
    control_id: r.control_id,
    epoch: r.epoch,
    command_id: cmd.idempotency_key,
    inflight_effects: r.inflight_effects,
    unknown_deliveries: r.unknown_deliveries,
    drain_scope: r.drain_scope,
  };
}

/**
 * Devolve a conversa à automação.
 *
 * `resume_policy` é fixo em `future_only` e não é parâmetro: o §8.2.5 admite
 * um valor só na V1, e expor o campo aqui convidaria um caller a pedir replay
 * do backlog — que é comando separado, posterior, e com prova de ausência de
 * efeito. O campo existe no repositório para a recusa ser tipada, não para
 * ser escolhido.
 */
export async function resumeConversation(cmd: ResumeCommandV1): Promise<ResumeOutcomeV1> {
  const r: ResumeConversationResult = await conversationControlRepo.resumeConversationTx({
    control_id: cmd.control_id,
    expected_epoch: cmd.expected_epoch,
    idempotency_key: cmd.idempotency_key,
    requested_by_app_user_id: cmd.requested_by_app_user_id,
    reason_code: cmd.reason_code,
    resume_policy: 'future_only',
    request_payload: cmd.request_payload,
  });

  if (!r.ok) {
    logger.warn(
      { control_id: cmd.control_id, reason: r.reason, operator: cmd.requested_by_app_user_id },
      'conversation_control.resume_refused',
    );
    return {
      kind: 'refused',
      reason: r.reason,
      ...(r.current_epoch !== undefined ? { current_epoch: r.current_epoch } : {}),
      ...(r.current_mode !== undefined ? { current_mode: r.current_mode } : {}),
    };
  }

  logger.info(
    {
      control_id: r.control_id,
      epoch: r.epoch,
      resume_after_ingress_seq: r.resume_after_ingress_seq,
      backlog_cancelled: r.backlog_cancelled,
    },
    'conversation_control.resumed',
  );

  return {
    kind: 'resumed',
    control_id: r.control_id,
    epoch: r.epoch,
    idempotent: r.idempotent,
    command_id: r.command_id,
    resume_after_ingress_seq: r.resume_after_ingress_seq,
    backlog_cancelled: r.backlog_cancelled,
  };
}
