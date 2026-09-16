/**
 * P04.3b (spec §8.2.1, §8.2.3) — a transação de PAUSA do controle humano.
 *
 * Nome no SINGULAR por C21: o capítulo 10 grafa `conversation-controls-repo.ts`
 * e o §8.2.3 grafa `conversation-control-repo.ts`; adoto o do §8.2.3, que é a
 * seção NORMATIVA que descreve a operação, e que mantém o par coerente com o
 * `control-service.ts` do mesmo parágrafo.
 *
 * ─── O que esta transação garante ──────────────────────────────────────────
 *
 * O §8.2.3 diz que "não confundir SELECT com fence atômico": um
 * `if (epochMatches) await handler()` tem janela de corrida. Por isso tudo aqui
 * acontece sob o MESMO lock e na MESMA transação — o controle é trancado com
 * `lockControlByIdSql` (P04.3a, dono único do SQL de lock, para não existirem
 * dois ordenamentos) e só então o epoch é conferido e incrementado.
 *
 * A ordem das recusas é a do §8.2.3 passo 3 — "conferir `expectedEpoch`,
 * conversa vigente e modo permitido" —, e ela não é arbitrária: o epoch é o
 * marcador de AUTORIDADE. Uma conversa já pausada por outro operador recusa por
 * `epoch_mismatch` quando quem chega traz epoch velho, e por `mode_not_allowed`
 * quando o epoch está em dia mas o modo não admite a transição. Colapsar os
 * dois faria "você está desatualizado" e "isto não se aplica aqui" contarem a
 * mesma história.
 *
 * ─── Auditoria AQUI, e por quê ─────────────────────────────────────────────
 *
 * O cabeçalho de `engine-repos.ts` diz que auditoria não acontece em
 * repositório — mas aquela é uma regra DAQUELE arquivo, não da casa:
 * `ops-repos.ts`, `outbound-delivery-repo.ts` e `outbound-outbox-repo.ts`
 * chamam `auditTx` de dentro da transação, exatamente quando a garantia exige
 * atomicidade. É o caso aqui: o §8.2.3 passo 4 manda gravar "comando e
 * auditoria durável na MESMA transação", e o `auditTx` é deliberadamente SEM
 * try/catch para que a falha da trilha desfaça a escrita que a originou.
 *
 * O destino é `audit_log` (SINGULAR). O §8.6.1 escreve `audit_logs`, tabela que
 * não existe — ver C40. `conversa_id` fica NULO: a coluna tem FK para
 * `conversas`, e um controle pode existir antes de a conversa ser resolvida
 * (§8.2.1: "`conversa_id` pode ser nulo no inbound"). Os identificadores viajam
 * no `metadata`, que é também o vínculo com `admin_audit_log` que o §8.6.1 pede.
 *
 * ─── O que esta fatia NÃO faz ──────────────────────────────────────────────
 *
 * Não drena. `barrier_committed=true` com `drain_status='pending'` é o retorno
 * honesto do §8.2.3: "barreira estabelecida, drenagem pendente" — e o §8.2.3 é
 * explícito em que `barrierCommitted=true` NÃO significa `drainStatus`
 * completo. A reconciliação (`pausing → human`), os fences das dez fronteiras
 * de egresso do §8.2.4 e o `resume` são unidades próprias.
 */
import { sql } from 'drizzle-orm';
import { db, withTx } from '../client.js';
import { getCurrentAgent, getCurrentTenant } from '../tenant-context.js';
import { lockControlByIdSql } from './conversation-control-sql.js';
import { auditTx } from '@/governance/audit.js';
import { canonicalDigest } from '@/integrations/hermes/canonical-json.js';

type Executor = typeof db;

function scope(): { tenant_id: string; agent_id: string } {
  return { tenant_id: getCurrentTenant(), agent_id: getCurrentAgent() };
}

function linhas<T>(res: { rows: unknown }): T[] {
  return Array.from(res.rows as unknown as T[]);
}

/** Motivos de PAUSA do §8.3.2 — os de resume são outros, e o CHECK separa. */
export const PAUSE_REASON_CODES = [
  'operator_takeover',
  'customer_requested',
  'safety_review',
  'handoff_accepted',
] as const;

export type PauseReasonCode = (typeof PAUSE_REASON_CODES)[number];

export type PauseConversationInput = {
  control_id: string;
  /** Decimal canônico, nunca `number`: a coluna é bigint (§8.3.2). */
  expected_epoch: string;
  idempotency_key: string;
  requested_by_app_user_id: string;
  reason_code: PauseReasonCode;
  /** Payload validado do comando; entra no `request_hash` canônico. */
  request_payload: unknown;
};

/** O modelo de retorno do §8.2.3, com `epoch` como string decimal. */
export type PauseConversationResult =
  | {
      ok: true;
      idempotent: boolean;
      command_id: string;
      control_id: string;
      mode: string;
      epoch: string;
      barrier_committed: boolean;
      drain_status: string | null;
      inflight_effects: number;
      unknown_deliveries: number;
      updated_at: Date;
    }
  | {
      ok: false;
      reason:
        | 'payload_conflict'
        | 'epoch_mismatch'
        | 'mode_not_allowed'
        | 'control_not_found'
        | 'forbidden'
        | 'reconciliation_required';
      command_id?: string;
      current_epoch?: string;
      current_mode?: string;
    };

/** Os motivos de recusa, extraídos para o ramo do desfecho persistido usá-los. */
export type PauseConversationRefusal =
  | 'payload_conflict'
  | 'epoch_mismatch'
  | 'mode_not_allowed'
  | 'control_not_found'
  | 'forbidden'
  | 'reconciliation_required';

type ComandoRow = {
  id: string;
  request_hash: string;
  status: string;
  outcome_code: string | null;
  result_epoch: string | null;
  barrier_committed: boolean;
  drain_status: string | null;
  inflight_effects: number;
  unknown_deliveries: number;
  updated_at: Date;
};

type ControleAtualizado = {
  mode: string;
  control_epoch: string;
  updated_at: Date;
};

async function pauseInTx(
  tx: Executor,
  input: PauseConversationInput,
): Promise<PauseConversationResult> {
  const { tenant_id, agent_id } = scope();
  const request_hash = canonicalDigest(input.request_payload ?? null);

  // PASSO 2 do §8.2.3 — idempotência ANTES de tocar no controle. Um retry não
  // pode chegar sequer a trancar a row: o §8.2.1 manda devolver "o resultado do
  // mesmo comando, sem novo incremento".
  const existente = linhas<ComandoRow>(
    await tx.execute(sql`
      SELECT id, request_hash, status, outcome_code,
             result_epoch::text AS result_epoch,
             barrier_committed, drain_status, inflight_effects,
             unknown_deliveries, updated_at
        FROM conversation_control_commands
       WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id}
         AND idempotency_key = ${input.idempotency_key}
       FOR UPDATE`),
  )[0];

  if (existente) {
    // Mesma chave com payload divergente é CONFLITO, nunca última-escrita-vence
    // (§8.2.4). Guardar só a chave tornaria os dois indistinguíveis.
    if (existente.request_hash !== request_hash) {
      await auditTx(tx, {
        acao: 'conversation_control_conflict',
        metadata: {
          command_id: existente.id,
          control_id: input.control_id,
          outcome_code: 'payload_conflict',
        },
      });
      return { ok: false, reason: 'payload_conflict', command_id: existente.id };
    }
    if (existente.status !== 'accepted') {
      // O payload BATEU — o que há é um comando guardado que não foi aceito.
      // Devolver `payload_conflict` aqui seria mentir sobre a causa, e era o
      // que a primeira versão desta função fazia: um ramo sem teste, com o
      // tipo satisfeito e a semântica errada. O desfecho correto é o que está
      // PERSISTIDO, e o `_outcome_chk` da 141 garante que ele existe — status
      // `conflict`/`failed` exige `outcome_code` não nulo.
      //
      // Esta fatia só escreve `accepted`, então hoje o ramo é alcançável
      // apenas por linha escrita por outra fatia (ou à mão). "Inalcançável
      // hoje" não é razão para devolver resposta errada: é a mesma régua que
      // me fez recusar o argumento no C39.
      return {
        ok: false,
        reason: (existente.outcome_code ??
          'forbidden') as PauseConversationRefusal,
        command_id: existente.id,
      };
    }
    // Replay: devolve o MESMO desfecho e NÃO audita de novo — a operação não
    // aconteceu de novo (mesma régua de `requestCommandWithAuditInTx`).
    return {
      ok: true,
      idempotent: true,
      command_id: existente.id,
      control_id: input.control_id,
      mode: 'pausing',
      epoch: existente.result_epoch ?? '0',
      barrier_committed: existente.barrier_committed,
      drain_status: existente.drain_status,
      inflight_effects: Number(existente.inflight_effects),
      unknown_deliveries: Number(existente.unknown_deliveries),
      updated_at: existente.updated_at,
    };
  }

  // PASSO 3 — o controle é o PRIMEIRO degrau da ordem de locks (§5.6.3,
  // §8.2.3). O SQL vem de `conversation-control-sql.ts`, dono único.
  const controle = linhas<{ id: string; mode: string; control_epoch: string }>(
    await tx.execute(
      lockControlByIdSql({ tenant_id, agent_id, control_id: input.control_id }),
    ),
  )[0];

  if (!controle) {
    // Nenhuma linha de comando é criada: o comando não tem a que se referir, e
    // a FK composta o recusaria de qualquer forma.
    return { ok: false, reason: 'control_not_found' };
  }

  // Epoch ANTES de modo: o epoch é o marcador de autoridade, e quem chega com
  // epoch velho está desatualizado — fato diferente de "a transição não se
  // aplica a este modo".
  if (controle.control_epoch !== input.expected_epoch) {
    await auditTx(tx, {
      acao: 'conversation_control_conflict',
      metadata: {
        control_id: controle.id,
        outcome_code: 'epoch_mismatch',
        expected_epoch: input.expected_epoch,
        current_epoch: controle.control_epoch,
      },
    });
    return {
      ok: false,
      reason: 'epoch_mismatch',
      current_epoch: controle.control_epoch,
      current_mode: controle.mode,
    };
  }

  if (controle.mode !== 'bot') {
    await auditTx(tx, {
      acao: 'conversation_control_conflict',
      metadata: {
        control_id: controle.id,
        outcome_code: 'mode_not_allowed',
        current_mode: controle.mode,
      },
    });
    return {
      ok: false,
      reason: 'mode_not_allowed',
      current_epoch: controle.control_epoch,
      current_mode: controle.mode,
    };
  }

  // PASSO 4 — a transição COMPLETA. Os CHECKs `_owner_chk` e `_paused_chk` da
  // 140 tornam impossível sair de `bot` sem dono e sem carimbo: uma
  // implementação que esquecesse qualquer um dos dois não passaria com campo
  // nulo, quebraria.
  const command_id = crypto.randomUUID();
  const atualizado = linhas<ControleAtualizado>(
    await tx.execute(sql`
      UPDATE conversation_controls
         SET mode = 'pausing',
             control_epoch = control_epoch + 1,
             owner_app_user_id = ${input.requested_by_app_user_id},
             paused_at = now(),
             reason_code = ${input.reason_code},
             last_command_id = ${command_id},
             updated_at = now()
       WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id}
         AND id = ${input.control_id}
   RETURNING mode, control_epoch::text AS control_epoch, updated_at`),
  )[0];

  if (!atualizado) return { ok: false, reason: 'control_not_found' };

  const comando = linhas<ComandoRow>(
    await tx.execute(sql`
      INSERT INTO conversation_control_commands
        (id, tenant_id, agent_id, control_id, kind, idempotency_key, request_hash,
         expected_epoch, result_epoch, requested_by_app_user_id, status,
         barrier_committed, drain_status, summary_json)
      VALUES
        (${command_id}, ${tenant_id}, ${agent_id}, ${input.control_id}, 'pause',
         ${input.idempotency_key}, ${request_hash},
         ${input.expected_epoch}::bigint, ${atualizado.control_epoch}::bigint,
         ${input.requested_by_app_user_id}, 'accepted',
         true, 'pending', ${JSON.stringify({ reason_code: input.reason_code })}::jsonb)
   RETURNING id, request_hash, status, result_epoch::text AS result_epoch,
             barrier_committed, drain_status, inflight_effects,
             unknown_deliveries, updated_at`),
  )[0]!;

  // PASSO 4, segunda metade: a trilha durável, na MESMA transação.
  await auditTx(tx, {
    acao: 'conversation_pause_requested',
    metadata: {
      command_id: comando.id,
      control_id: input.control_id,
      epoch_before: input.expected_epoch,
      epoch_after: atualizado.control_epoch,
      reason_code: input.reason_code,
      requested_by: input.requested_by_app_user_id,
    },
  });

  return {
    ok: true,
    idempotent: false,
    command_id: comando.id,
    control_id: input.control_id,
    mode: atualizado.mode,
    epoch: atualizado.control_epoch,
    barrier_committed: comando.barrier_committed,
    drain_status: comando.drain_status,
    inflight_effects: Number(comando.inflight_effects),
    unknown_deliveries: Number(comando.unknown_deliveries),
    updated_at: atualizado.updated_at,
  };
}

export const conversationControlRepo = {
  /**
   * A pausa numa transação própria — o atalho para quem não tem transação em
   * mãos.
   */
  async pauseConversationTx(
    input: PauseConversationInput,
  ): Promise<PauseConversationResult> {
    return withTx((tx) => pauseInTx(tx, input));
  },

  /**
   * A MESMA pausa, na transação de QUEM CHAMA. Existe pelo motivo que
   * `requestCommandWithAuditInTx` documenta: um caller que já está numa
   * transação precisa que a barreira entre no MESMO commit da decisão que a
   * autorizou — pausar por fora, em transação própria, faria o efeito preceder
   * a decisão. Os dois compartilham este corpo, então não há como divergirem.
   */
  async pauseConversationInTx(
    tx: Executor,
    input: PauseConversationInput,
  ): Promise<PauseConversationResult> {
    return pauseInTx(tx, input);
  },
};
