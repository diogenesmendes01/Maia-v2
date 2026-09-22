/**
 * Spec Maia+Hermes §8.3 — a SUPERFÍCIE DE CONSOLE do controle humano de
 * conversa: pausa, reconciliação e retomada.
 *
 * ─── O que este router acrescenta, e o que ele NÃO acrescenta ───────────────
 *
 * `src/runtime/conversation-control/service.ts` foi escrito como "a porta que
 * os endpoints vão chamar" e ficou sem chamador. Este arquivo é o chamador. Ele
 * acrescenta exatamente três coisas, e nenhuma delas é regra de negócio:
 *
 *   1. **Autorização.** O serviço diz, em letras, que não decide quem pode
 *      pausar: "responder isso aqui criaria um segundo lugar onde a resposta
 *      mora". A ACL do §8.3 mora aqui, ao lado das outras do console;
 *   2. **Escopo.** `conversationControlRepo` lê tenant e agente do ALS, então
 *      toda chamada entra em `runWithTenantContext`. O tenant NUNCA vem do
 *      corpo da requisição — `resolveTenantId` trata `input.tenantId` como
 *      conferência, e só `founder` opera cross-tenant;
 *   3. **Tradução de recusa.** O serviço devolve união tipada; o console fala
 *      `TRPCError`. A tradução é um `switch` exaustivo, não um `catch`.
 *
 * ─── O que ele NÃO faz, e por quê (não é esquecimento) ──────────────────────
 *
 * **Não audita.** `conversation_pause_requested`, `conversation_control_acquired`
 * e `conversation_control_conflict` são gravadas DENTRO das transações do
 * repositório, no mesmo `tx` da mudança de estado. Uma segunda linha escrita
 * aqui seria a que mente no dia em que a transação der rollback — o `auditTx`
 * de lá é deliberadamente sem try/catch por essa razão.
 *
 * **Não faz auto-resume.** Nem por timeout, nem por logout, nem por sessão
 * expirada (§8.2.5). Não existe rota aqui que devolva a conversa ao bot sem um
 * operador assinando o comando.
 *
 * **Não expõe o composer do §8.3.4.** A ação de auditoria
 * `operator_reply_committed` e a origem `outbound_messages.origin = 'operator'`
 * existem esperando por ele, mas a semântica dele não está fixada na spec
 * disponível. Inventá-la aqui seria fabricar contrato.
 *
 * ─── O detalhe de contrato que NÃO pode ser colapsado ───────────────────────
 *
 * `reconciliation_required` **não é recusa**, e por isso não vira `TRPCError`.
 * A pausa VALEU: a automação já está barrada e o epoch subiu. O que ficou em
 * aberto é o dreno de efeito em voo. Responder `refused` diria ao operador que
 * a conversa continua com o bot — o oposto exato do que aconteceu, e a forma
 * mais cara de erro que esta tela pode cometer. Ele volta como ESTADO, com as
 * contagens e o escopo do dreno, e a UI mostra estado, não erro.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../server.js';
import { resolveTenantId } from '../tenant-resolver.js';
import { assertRateLimit } from '../rate-limit.js';
import { runWithTenantContext } from '../../../db/tenant-context.js';
import {
  pauseConversation,
  reconcilePause,
  resumeConversation,
  type PauseOutcomeV1,
  type ResumeOutcomeV1,
} from '../../../runtime/conversation-control/service.js';
import {
  PAUSE_REASON_CODES,
  RESUME_REASON_CODES,
} from '../../../db/repositories/conversation-control-repo.js';

/**
 * Quem pode tomar uma conversa.
 *
 * `analyst` e `viewer` ficam de fora: tomar a conversa INTERROMPE o
 * atendimento automático de um cliente real e muda o que o sistema responde —
 * é operação, não leitura. `compliance_officer` entra porque o §8.3.2 lista
 * `safety_review` entre os motivos de pausa, e quem faz revisão de segurança
 * precisa conseguir parar a automação sem pedir a alguém.
 */
const OPERADORES = ['founder', 'owner', 'compliance_officer'] as const;

/**
 * Epoch é decimal canônico em string, nunca `number`: a coluna é `bigint` e um
 * contador de banco não deve depender de 2^53 (§8.3.2). O regex recusa zeros à
 * esquerda porque o valor viaja para dentro de um digest de idempotência —
 * `"07"` e `"7"` produziriam hashes diferentes para o mesmo epoch.
 */
const EpochSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/, 'expectedEpoch deve ser decimal canônico (bigint)');

/**
 * A chave de idempotência vem do CLIENTE e tem de ser estável entre retries do
 * MESMO comando: é ela que faz um duplo clique, ou um retry de rede, reencontrar
 * a pausa que já aconteceu em vez de abrir outra. O repositório protege o resto
 * — reuso divergente (outra conversa, outro epoch, outro operador) cai em
 * `payload_conflict`, e não em um replay aceito por acaso.
 */
const IdempotencySchema = z.string().min(8).max(200);

const BaseInput = z.object({
  tenantId: z.string().optional(),
  agentId: z.string().min(1),
  controlId: z.string().uuid(),
  expectedEpoch: EpochSchema,
  idempotencyKey: IdempotencySchema,
  /** Texto livre do operador; entra no payload canônico do comando. */
  note: z.string().max(2000).optional(),
});

const PauseInput = BaseInput.extend({
  reasonCode: z.enum(PAUSE_REASON_CODES),
});

const ReconcileInput = z.object({
  tenantId: z.string().optional(),
  agentId: z.string().min(1),
  controlId: z.string().uuid(),
  expectedEpoch: EpochSchema,
  idempotencyKey: IdempotencySchema,
});

const ResumeInput = BaseInput.extend({
  reasonCode: z.enum(RESUME_REASON_CODES),
});

/**
 * Teto anti-loop, não teto de capacidade.
 *
 * Mesma implementação mínima em memória de `channelLines` e com a mesma
 * consequência declarada: com N réplicas do console o limite efetivo é N×max.
 * Aceitável porque a trava DURA é outra — o epoch e a chave de idempotência no
 * Postgres —, e esta serve só para um botão em loop não abrir centenas de
 * transações de pausa.
 */
const CONTROL_RULE = { max: 30, windowMs: 60_000 };

/**
 * Traduz a recusa do serviço no erro do console.
 *
 * `switch` sobre os motivos que o repositório declara, e não um `default`
 * simpático: um motivo NOVO tem de aparecer como `INTERNAL_SERVER_ERROR` com o
 * nome dele no texto, e não ser silenciosamente apresentado como conflito
 * comum. O operador precisa distinguir "você está desatualizado"
 * (`epoch_mismatch`, releia a tela) de "isto não se aplica aqui"
 * (`mode_not_allowed`, outra pessoa já assumiu) — colapsar os dois faria as
 * duas situações contarem a mesma história.
 */
function recusaParaErro(reason: string, detalhe: { epoch?: string; mode?: string }): TRPCError {
  const sufixo = [
    detalhe.epoch === undefined ? null : `epoch atual ${detalhe.epoch}`,
    detalhe.mode === undefined ? null : `modo atual ${detalhe.mode}`,
  ]
    .filter((p): p is string => p !== null)
    .join(', ');
  const com = (texto: string): string => (sufixo === '' ? texto : `${texto} (${sufixo})`);

  switch (reason) {
    case 'control_not_found':
      return new TRPCError({ code: 'NOT_FOUND', message: 'Conversa não encontrada neste escopo' });
    case 'forbidden':
      return new TRPCError({
        code: 'FORBIDDEN',
        message: 'Este operador não pode controlar esta conversa',
      });
    case 'epoch_mismatch':
      return new TRPCError({
        code: 'CONFLICT',
        message: com('O controle da conversa mudou desde que a tela carregou; recarregue e repita'),
      });
    case 'mode_not_allowed':
      return new TRPCError({
        code: 'CONFLICT',
        message: com('A conversa não admite esta transição no modo em que está'),
      });
    case 'payload_conflict':
      return new TRPCError({
        code: 'CONFLICT',
        message:
          'Esta chave de idempotência já foi usada com outro comando; gere uma nova para uma operação diferente',
      });
    case 'reconciliation_required':
      // Vem do repositório como RECUSA de um comando NOVO enquanto o dreno
      // anterior não fechou — diferente do desfecho `reconciliation_required`
      // do serviço, que é sucesso. Aqui é precondição, e o remédio é
      // `reconcile`, não repetir a pausa.
      return new TRPCError({
        code: 'PRECONDITION_FAILED',
        message:
          'Há efeito em voo desta conversa que ninguém reconciliou; rode a reconciliação antes',
      });
    default:
      return new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: `Controle de conversa recusado: ${reason}`,
      });
  }
}

/** O desfecho da pausa/reconciliação como o console o lê. */
function desfechoDaPausa(outcome: PauseOutcomeV1) {
  if (outcome.kind === 'refused') {
    throw recusaParaErro(outcome.reason, {
      ...(outcome.current_epoch !== undefined ? { epoch: outcome.current_epoch } : {}),
      ...(outcome.current_mode !== undefined ? { mode: outcome.current_mode } : {}),
    });
  }

  if (outcome.kind === 'acquired') {
    return {
      status: 'acquired' as const,
      control_id: outcome.control_id,
      epoch: outcome.epoch,
      idempotent: outcome.idempotent,
      identity: outcome.identity,
    };
  }

  // NÃO é erro. Ver o cabeçalho: a pausa valeu, o dreno não fechou. As
  // contagens e o `drain_scope` viajam porque "0 efeitos" só significa alguma
  // coisa quando se sabe o que foi contado — `drain_scope` declara que a
  // medição cobre APENAS egresso de origem engine.
  return {
    status: 'reconciliation_required' as const,
    control_id: outcome.control_id,
    epoch: outcome.epoch,
    identity: outcome.identity,
    inflight_effects: outcome.inflight_effects,
    unknown_deliveries: outcome.unknown_deliveries,
    drain_scope: outcome.drain_scope,
  };
}

export const conversationControlRouter = router({
  /**
   * Pausa a conversa e leva o dreno até onde ele der (§8.2.3 + §8.2.4).
   *
   * Uma chamada, duas transações — a pausa e a reconciliação — sequenciadas
   * pelo serviço com o epoch DEVOLVIDO pela pausa. Não é o router que sabe
   * disso, e é por isso que ele não reimplementa a sequência.
   */
  pause: protectedProcedure.input(PauseInput).mutation(async ({ input, ctx }) => {
    ctx.assertRole(...OPERADORES);
    const tenantId = resolveTenantId(ctx, input.tenantId);
    assertRateLimit(`conversation-control:${ctx.userId}`, CONTROL_RULE);

    const outcome = await runWithTenantContext(
      { tenant_id: tenantId, agent_id: input.agentId },
      () =>
        pauseConversation({
          control_id: input.controlId,
          expected_epoch: input.expectedEpoch,
          idempotency_key: input.idempotencyKey,
          requested_by_app_user_id: ctx.userId,
          reason_code: input.reasonCode,
          request_payload: { note: input.note ?? null },
        }),
    );

    return desfechoDaPausa(outcome);
  }),

  /**
   * Reconcilia uma pausa cujo dreno ficou em aberto.
   *
   * Operação SEPARADA porque o efeito em voo termina no tempo dele, não no da
   * transação de pausa: o operador volta a esta rota depois, quantas vezes for
   * preciso, com a mesma chave de idempotência.
   */
  reconcile: protectedProcedure.input(ReconcileInput).mutation(async ({ input, ctx }) => {
    ctx.assertRole(...OPERADORES);
    const tenantId = resolveTenantId(ctx, input.tenantId);
    assertRateLimit(`conversation-control:${ctx.userId}`, CONTROL_RULE);

    const outcome = await runWithTenantContext(
      { tenant_id: tenantId, agent_id: input.agentId },
      () =>
        reconcilePause({
          control_id: input.controlId,
          expected_epoch: input.expectedEpoch,
          idempotency_key: input.idempotencyKey,
          requested_by_app_user_id: ctx.userId,
        }),
    );

    return desfechoDaPausa(outcome);
  }),

  /**
   * Devolve a conversa à automação (§8.2.5).
   *
   * `resume_policy` não é parâmetro desta rota, e a ausência é o contrato: o
   * serviço o fixa em `future_only`, e expor o campo convidaria um caller a
   * pedir replay do backlog — que é comando separado, posterior, e com prova
   * de ausência de efeito.
   */
  resume: protectedProcedure.input(ResumeInput).mutation(async ({ input, ctx }) => {
    ctx.assertRole(...OPERADORES);
    const tenantId = resolveTenantId(ctx, input.tenantId);
    assertRateLimit(`conversation-control:${ctx.userId}`, CONTROL_RULE);

    const outcome: ResumeOutcomeV1 = await runWithTenantContext(
      { tenant_id: tenantId, agent_id: input.agentId },
      () =>
        resumeConversation({
          control_id: input.controlId,
          expected_epoch: input.expectedEpoch,
          idempotency_key: input.idempotencyKey,
          requested_by_app_user_id: ctx.userId,
          reason_code: input.reasonCode,
          request_payload: { note: input.note ?? null },
        }),
    );

    if (outcome.kind === 'refused') {
      throw recusaParaErro(outcome.reason, {
        ...(outcome.current_epoch !== undefined ? { epoch: outcome.current_epoch } : {}),
        ...(outcome.current_mode !== undefined ? { mode: outcome.current_mode } : {}),
      });
    }

    return {
      status: 'resumed' as const,
      control_id: outcome.control_id,
      epoch: outcome.epoch,
      idempotent: outcome.idempotent,
      command_id: outcome.command_id,
      /**
       * A watermark viaja para a tela porque ela é a resposta à pergunta que o
       * operador de fato faz ao soltar a conversa: "o que o bot vai ver?".
       * Só inbound DEPOIS deste `ingress_seq` volta a ser automatizado, e o
       * backlog retido foi descartado — `backlog_cancelled` diz quanto.
       */
      resume_after_ingress_seq: outcome.resume_after_ingress_seq,
      backlog_cancelled: outcome.backlog_cancelled,
    };
  }),
});
