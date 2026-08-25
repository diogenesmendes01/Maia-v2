/**
 * Issue #633 (fatia D da épica #506) — o REARMAMENTO MANUAL de uma saída
 * outbound, como operação de operador.
 *
 * A issue-mãe chama isto de falha #12 e a descreve com precisão: *o operador
 * rearma um item incerto e duplica mensagem para o usuário*. Esta é a operação
 * que torna isso difícil de fazer por acidente — e impossível de fazer sem
 * deixar rastro.
 *
 * Irmão de `src/ops/turn-replay.ts` (#504), com a mesma divisão: a lógica mora
 * aqui, para que exista um call site de PRODUÇÃO testável, e `scripts/dlq.ts` é
 * só o adaptador de linha de comando (parse de flags e impressão). Um teste que
 * reimplementasse a sequência abaixo estaria medindo a si mesmo.
 *
 * ─── A ordem dos quatro passos é a garantia ─────────────────────────────────
 *
 *  1. **Resolver o dono** pela fronteira de confiança
 *     (`resolveOutboundDeliveryScope`). O operador digita um `outbound_id`; ele
 *     NÃO digita um tenant, e não deveria — deixar o operador escolher o escopo
 *     é deixar um erro de digitação virar escrita cross-tenant.
 *  2. **Calcular o RISCO DE DUPLICATA** a partir do estado real da linha
 *     (`manualRearmDuplicateRisk`): o desfecho registrado é da família
 *     desconhecida E o provedor não honra chave idempotente para este
 *     `payload_type`? As duas condições, juntas. Um `audio` incerto é risco; um
 *     `text` incerto não é (o Baileys aceita `messageId` em `sendText`); uma
 *     linha que morreu por teto de tentativas sem nunca ter registrado desfecho
 *     também não é.
 *  3. **Recusar sem a confirmação**, quando há risco. `manualRearmRefusal` é
 *     fail-closed: `undefined` (flag esquecida, campo ausente do JSON) é
 *     recusa, não permissão.
 *  4. **Transicionar por CAS auditado e SÓ ENTÃO rearmar o transporte.**
 *     Rearmar antes — ou sem olhar o resultado — armaria um job para uma linha
 *     que outro worker pode estar entregendo: duas tentativas concorrentes, que
 *     é precisamente o que a épica fecha.
 *
 * O rearme usa `enqueueOutboundDelivery`, que remove o job retido em
 * `completed`/`failed` com o mesmo `jobId` determinístico antes de adicionar.
 * Sem esse passo a BullMQ ignoraria o `add` (id já existente) e a linha ficaria
 * em `retryable` para sempre — o "job retido bloqueia rearmamento legítimo" que
 * a issue lista como risco.
 */
import { runWithTenantContext } from '@/db/tenant-context.js';
import { enqueueOutboundDelivery } from '@/gateway/queue.js';
import { logger } from '@/lib/logger.js';
import { counter } from '@/observability/metrics.js';
import { METRIC } from '@/observability/taxonomy.js';
import { outboundRecoveryRepo } from '@/db/repositories/outbound-recovery-repo.js';
import { resolveOutboundDeliveryScope } from '@/runtime/outbound/delivery-scope.js';
import {
  manualRearmDuplicateRisk,
  manualRearmRefusal,
  rearmIdempotencyNote,
  type ManualRearmRefusal,
} from '@/runtime/outbound/recovery-contract.js';
import type { OutboundProviderChannel } from '@/runtime/outbound/contract.js';

/** O canal de egresso desta fatia — fechado, como em `delivery.ts`. */
const EGRESS_CHANNEL: OutboundProviderChannel = 'whatsapp';

export type OutboundRearmOutcome =
  | {
      rearmed: true;
      outbound_id: string;
      tenant_id: string;
      agent_id: string;
      from_status: string;
      duplicate_risk: boolean;
    }
  | {
      rearmed: false;
      outbound_id: string;
      refusal: ManualRearmRefusal;
      /** O que o operador precisa ler antes de tentar de novo. */
      detail: string;
    };

/**
 * Inspeção READ-ONLY, para o operador decidir ANTES de agir.
 *
 * Existe como operação própria porque a confirmação de risco só é uma decisão
 * se houver como VER o risco. Uma flag `--confirm-risk` que se digita sem
 * conseguir consultar o que ela reconhece é um ritual, não um controle.
 */
export async function inspectOutboundForOperator(outbound_id: string): Promise<{
  outbound_id: string;
  tenant_id: string;
  agent_id: string;
  status: string;
  attempt: number;
  payload_type: string;
  delivery_outcome: string | null;
  last_error_code: string | null;
  created_at: Date;
  duplicate_risk: boolean;
  idempotency_note: string;
} | null> {
  const scope = await resolveOutboundDeliveryScope(outbound_id);
  return runWithTenantContext(
    { tenant_id: scope.tenant_id, agent_id: scope.agent_id },
    async () => {
      const row = await outboundRecoveryRepo.findForOperator(scope.outbound_id);
      if (!row) return null;
      const risk = manualRearmDuplicateRisk({
        outcome: row.delivery_outcome,
        channel: EGRESS_CHANNEL,
        payload_type: row.payload_type,
      });
      return {
        outbound_id: row.outbound_id,
        tenant_id: scope.tenant_id,
        agent_id: scope.agent_id,
        status: row.status,
        attempt: row.attempt,
        payload_type: row.payload_type,
        delivery_outcome: row.delivery_outcome,
        last_error_code: row.last_error_code,
        created_at: row.created_at,
        duplicate_risk: risk,
        idempotency_note: rearmIdempotencyNote(EGRESS_CHANNEL, row.payload_type).note,
      };
    },
  );
}

/**
 * Executa o rearmamento manual. Propaga `OutboundScopeUnresolvedError` quando o
 * escopo não pôde ser resolvido — o chamador (CLI) traduz para mensagem de
 * operador e exit code.
 *
 * `rearm: false` existe para o operador que quer apenas devolver a linha ao
 * estado `retryable` e deixar a varredura de recuperação armá-la no próximo
 * tick. O default é rearmar, porque com `FEATURE_OUTBOUND_RECOVERY` desligada
 * — que é o default hoje — nada mais o faria.
 */
export async function rearmOutboundByOperator(args: {
  outbound_id: string;
  actor: string;
  reason: string;
  acknowledge_duplicate_risk?: boolean;
  rearm?: boolean;
}): Promise<OutboundRearmOutcome> {
  const scope = await resolveOutboundDeliveryScope(args.outbound_id);

  return runWithTenantContext(
    { tenant_id: scope.tenant_id, agent_id: scope.agent_id },
    async (): Promise<OutboundRearmOutcome> => {
      const row = await outboundRecoveryRepo.findForOperator(scope.outbound_id);
      if (!row) {
        return {
          rearmed: false,
          outbound_id: scope.outbound_id,
          refusal: 'not_found',
          detail: 'a linha não existe no escopo resolvido',
        };
      }

      const duplicate_risk = manualRearmDuplicateRisk({
        outcome: row.delivery_outcome,
        channel: EGRESS_CHANNEL,
        payload_type: row.payload_type,
      });
      const refusal = manualRearmRefusal({
        status: row.status,
        reason: args.reason,
        ...(args.acknowledge_duplicate_risk !== undefined
          ? { acknowledge_duplicate_risk: args.acknowledge_duplicate_risk }
          : {}),
        duplicate_risk,
      });
      if (refusal !== null) {
        logger.warn(
          {
            outbound_id: scope.outbound_id,
            actor: args.actor,
            refusal,
            status: row.status,
            duplicate_risk,
            ops_alert: true,
          },
          'outbound.manual_rearm_refused',
        );
        return {
          rearmed: false,
          outbound_id: scope.outbound_id,
          refusal,
          detail: detailFor(refusal, row.status, EGRESS_CHANNEL, row.payload_type),
        };
      }

      // CAS auditado. Recusa aqui significa que o estado mudou entre a leitura
      // e a escrita — outro operador, ou a varredura. NADA é rearmado.
      const moved = await outboundRecoveryRepo.rearmManuallyTx({
        outbound_id: scope.outbound_id,
        conversa_id: row.conversa_id,
        in_reply_to: row.in_reply_to,
        actor: args.actor,
        reason: args.reason,
        from_status: row.status,
        duplicate_risk,
        acknowledged_duplicate_risk: args.acknowledge_duplicate_risk === true,
      });
      if (!moved.rearmed) {
        return {
          rearmed: false,
          outbound_id: scope.outbound_id,
          refusal: 'status_not_rearmable',
          detail:
            `o estado mudou entre a leitura (${row.status}) e a escrita — outro operador ou a ` +
            `varredura agiu primeiro. NADA foi rearmado.`,
        };
      }

      if (args.rearm !== false) {
        await enqueueOutboundDelivery(scope.outbound_id);
        counter(METRIC.OUTBOUND_REARM, { origin: 'replay' });
      }
      logger.info(
        {
          outbound_id: scope.outbound_id,
          tenant_id: scope.tenant_id,
          agent_id: scope.agent_id,
          actor: args.actor,
          from_status: row.status,
          duplicate_risk,
          rearmed: args.rearm !== false,
        },
        'outbound.manual_rearm_done',
      );
      return {
        rearmed: true,
        outbound_id: scope.outbound_id,
        tenant_id: scope.tenant_id,
        agent_id: scope.agent_id,
        from_status: row.status,
        duplicate_risk,
      };
    },
  );
}

/** Mensagem ACIONÁVEL por recusa — o que o operador faz a seguir. */
function detailFor(
  refusal: ManualRearmRefusal,
  status: string,
  channel: OutboundProviderChannel,
  payload_type: Parameters<typeof rearmIdempotencyNote>[1],
): string {
  switch (refusal) {
    case 'status_not_rearmable':
      return (
        `estado '${status}' não admite rearmamento. Só dead_letter, reconciling e ` +
        `delivery_unknown admitem — 'failed_terminal' é recusa DEFINITIVA do provedor ` +
        `(rearmar é pedir a mesma recusa) e os estados concluídos já entregaram.`
      );
    case 'duplicate_risk_unacknowledged':
      return (
        `RISCO DE DUPLICATA: ${rearmIdempotencyNote(channel, payload_type).note}. ` +
        `Se quiser assumir o risco, repita com o reconhecimento explícito — ele vai para a ` +
        `auditoria junto com o seu --reason.`
      );
    case 'reason_missing':
      return '--reason é obrigatório: ele vai para a auditoria, e um rearmamento sem motivo registrado é uma intervenção que ninguém consegue reconstruir depois.';
    case 'not_found':
      return 'a linha não existe no escopo resolvido';
    default: {
      const _never: never = refusal;
      void _never;
      return 'recusa fora do contrato';
    }
  }
}
