/**
 * Issue #633 (fatia D da épica #506) — o CONSUMIDOR da fila de entrega.
 *
 * A #632 entregou o ciclo (`deliverOutbound`) e a identidade determinística do
 * job (`outboundDeliveryJobId`), e declarou a dívida em uma linha: *nenhum
 * consumidor de fila foi registrado*. Este módulo é essa linha.
 *
 * Ele é fino de propósito — três passos e nenhuma decisão:
 *
 *   1. traduzir `outbound_id` no escopo SELADO (fronteira de confiança,
 *      `delivery-scope.ts`);
 *   2. abrir o contexto de tenant desse escopo;
 *   3. chamar `deliverOutbound`, que é onde a política inteira já vive.
 *
 * Tudo que parece política aqui (elegibilidade, reenvio, estado de destino)
 * está deliberadamente ausente: duplicá-la no consumidor criaria um segundo
 * lugar onde ela pode ser escrita errado, e o erro nesse domínio é a mensagem
 * duplicada no telefone do usuário.
 *
 * ─── O que acontece quando o consumidor lança ───────────────────────────────
 *
 * `deliverOutbound` NÃO lança por desfecho de entrega — os sete desfechos são
 * valores. Ele lança só por erro de PLATAFORMA (banco fora, escopo ausente), e
 * é exatamente isso que deve virar retry do job e depois remoção do job. A ROW
 * continua sendo o registro durável: com o job fora, quem rearma é a varredura
 * de recuperação, pelo mesmo `jobId` determinístico.
 *
 * `OutboundScopeUnresolvedError` é a exceção à exceção: ela é ABSORVIDA aqui.
 * Um escopo irresolúvel não melhora com retry — a linha não existe, ou aponta
 * para outro tenant — e deixá-la falhar o job só produziria três tentativas e
 * ruído. A recusa já foi auditada e medida dentro do resolvedor.
 */
import { logger } from '@/lib/logger.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { deliverOutbound, type DeliveryResult } from './delivery.js';
import {
  OutboundScopeUnresolvedError,
  resolveOutboundDeliveryScope,
} from './delivery-scope.js';

/**
 * Processa UM job de entrega. É o `processor` passado a
 * `startOutboundDeliveryWorker`.
 *
 * Devolve o desfecho para que um teste possa afirmá-lo sem inspecionar o
 * banco; o worker da BullMQ ignora o retorno.
 */
export async function consumeOutboundDeliveryJob(
  outbound_id: string,
): Promise<DeliveryResult | { delivered: false; outbound_id: string; reason: 'scope_unresolved' }> {
  let scope;
  try {
    scope = await resolveOutboundDeliveryScope(outbound_id);
  } catch (err) {
    if (err instanceof OutboundScopeUnresolvedError) {
      // Já auditado e medido no resolvedor. Absorver aqui evita três tentativas
      // de um job que não pode melhorar.
      return { delivered: false, outbound_id, reason: 'scope_unresolved' };
    }
    throw err;
  }

  const result = await runWithTenantContext(
    { tenant_id: scope.tenant_id, agent_id: scope.agent_id },
    () =>
      deliverOutbound({
        outbound_id: scope.outbound_id,
        jid: scope.jid,
        channel_id: scope.channel_id,
      }),
  );

  logger.info(
    {
      outbound_id: scope.outbound_id,
      tenant_id: scope.tenant_id,
      agent_id: scope.agent_id,
      delivered: result.delivered,
      reason: 'reason' in result ? result.reason : null,
    },
    'outbound_delivery.job_done',
  );
  return result;
}
