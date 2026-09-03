import { workflowsRepo, workflowStepsRepo } from '@/db/repositories.js';
import { db } from '@/db/client.js';
import { workflow_steps } from '@/db/schema.js';
import { getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';
import { and, eq } from 'drizzle-orm';
import { logger } from '@/lib/logger.js';
import { audit } from '@/governance/audit.js';
import { expireDueDualApprovals } from './dual-approval.js';
import { expireDueApprovals } from '@/governance/approval-requests.js';
import { enqueueProactiveNotice } from '@/runtime/outbound/proactive-notice.js';

export async function tickEngine(): Promise<{ processed: number; expired: number }> {
  // Fase 0 cap. 2/3 — expira requests do store backend (approval_requests),
  // com audit + notificação best-effort ao requester. Roda ANTES da varredura
  // legada: as duas são independentes e o contrato observado pelos testes de
  // isolamento (#345) é o UPDATE de workflows como última mutação do tick.
  // Issue #506 — o aviso de expiração vira LINHA DE LEDGER.
  //
  // O que havia aqui era `forCurrentAgentChannel(null)` + `line.sendText(...)`
  // sob exceção de egresso declarada. O tick do engine é o pior lugar possível
  // para um envio best-effort sem registro: ele roda a cada minuto, marca o
  // request como expirado no MESMO tick, e a expiração é irreversível. Se o
  // envio falhasse, o requester nunca saberia que o pedido morreu — e não havia
  // segunda chance, porque o request já não estava mais na varredura.
  //
  // Agora o aviso é comprometido em `outbox_messages` (chave derivada do UUID
  // do request, uma expiração = um aviso) e o drain o entrega com retry e DLQ.
  const notify = async (input: {
    jid: string;
    text: string;
    dedupe_key: string;
  }): Promise<unknown> => enqueueProactiveNotice(input);
  const expiredApprovals = await expireDueApprovals(notify).catch((err) => {
    logger.warn({ err: (err as Error).message }, 'engine.approval_expiry_failed');
    return 0;
  });
  // Legacy: expira workflows dual_approval antigos (rows pré-migration 095).
  const expiredLegacy = await expireDueDualApprovals();
  // Fase 0 cap. 3 (auditoria P0): o bloco que marcava workflows dual_approval
  // 'em_andamento' como CONCLUÍDOS e auditava `dual_approval_executed` SEM
  // executar intent algum foi REMOVIDO — o audit afirmava uma execução que
  // nunca aconteceu. A execução pós-aprovação agora acontece exclusivamente
  // no dispatcher, contra evidência persistida (claim → execute → consume),
  // e `dual_approval_executed`/`approval_consumed` só são auditados após o
  // efeito real.
  return { processed: 0, expired: expiredLegacy + expiredApprovals };
}

/**
 * Roll a workflow back: mark any step that did not finish as 'cancelada' and
 * the workflow itself as 'falhou'. Compensating actions for already-executed
 * steps are recorded in audit_log so a human can review them — we never
 * automatically reverse a financial side effect.
 */
export async function rollbackWorkflow(workflow_id: string, reason: string): Promise<void> {
  const wf = await workflowsRepo.byId(workflow_id);
  if (!wf) return;
  if (wf.status === 'concluido' || wf.status === 'falhou' || wf.status === 'cancelada') return;
  const steps = await workflowStepsRepo.byWorkflow(workflow_id);
  for (const step of steps) {
    if (step.status === 'concluida') {
      await audit({
        acao: 'workflow_compensation_required',
        alvo_id: workflow_id,
        metadata: { step_id: step.id, ordem: step.ordem, descricao: step.descricao },
      });
      continue;
    }
    if (step.status === 'pendente' || step.status === 'em_andamento') {
      // Issue #345 (Phase 4, defense-in-depth): self-enforce tenant scope on the
      // mutation. The step ids come from `workflowStepsRepo.byWorkflow()` for a
      // workflow already verified against the current tenant+agent via
      // `workflowsRepo.byId()`, so binding the ALS (tenant_id, agent_id) here is
      // a no-op for legitimate calls — it cannot match a row the caller did not
      // already own. But the project's inviolable cross-tenant isolation standard
      // requires EVERY mutation to scope itself (consistent with `updateStateTx`
      // #337, `conversasRepo.close`/`expireDue` #350), so an id-only WHERE is not
      // acceptable even when the surrounding context makes it safe today.
      await db
        .update(workflow_steps)
        .set({ status: 'cancelada', concluido_em: new Date() })
        .where(
          and(
            eq(workflow_steps.tenant_id, getCurrentTenant()),
            eq(workflow_steps.agent_id, getCurrentAgent()),
            eq(workflow_steps.id, step.id),
          ),
        );
    }
  }
  await workflowsRepo.setStatus(workflow_id, 'falhou');
  await audit({
    acao: 'workflow_rolled_back',
    alvo_id: workflow_id,
    metadata: { reason },
  });
  logger.warn({ workflow_id, reason }, 'engine.workflow.rolled_back');
}
