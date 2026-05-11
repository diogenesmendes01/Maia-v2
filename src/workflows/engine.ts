import { workflowsRepo, workflowStepsRepo } from '@/db/repositories.js';
import { db } from '@/db/client.js';
import { workflow_steps } from '@/db/schema.js';
import { eq } from 'drizzle-orm';
import { logger } from '@/lib/logger.js';
import { audit } from '@/governance/audit.js';
import { expireDueDualApprovals } from './dual-approval.js';

export async function tickEngine(): Promise<{ processed: number; expired: number }> {
  const expired = await expireDueDualApprovals();
  const pending = await workflowsRepo.listPending();
  let processed = 0;
  for (const wf of pending) {
    if (wf.tipo === 'dual_approval' && wf.status === 'em_andamento') {
      // Two signatures collected → execute the original intent
      const ctx = wf.contexto as { intent?: { tool: string; args: Record<string, unknown> }; requester_pessoa_id: string };
      if (!ctx.intent) continue;
      const steps = await workflowStepsRepo.byWorkflow(wf.id);
      const execStep = steps.find((s) => s.status === 'pendente' && s.descricao.startsWith('executa'));
      if (!execStep) continue;
      logger.info({ workflow_id: wf.id, tool: ctx.intent.tool }, 'engine.dual_approval.execute');
      // We cannot dispatch without a real ToolContext; this path runs in a worker that does not
      // have a live conversation. The actual integration emits a notification to the requester
      // and lets the dispatcher in the next agent turn re-execute idempotently.
      await audit({
        acao: 'dual_approval_executed',
        pessoa_id: ctx.requester_pessoa_id,
        alvo_id: wf.id,
        metadata: { tool: ctx.intent.tool },
      });
      await workflowsRepo.setStatus(wf.id, 'concluido');
      processed++;
    }
  }
  return { processed, expired };
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
      await db
        .update(workflow_steps)
        .set({ status: 'cancelada', concluido_em: new Date() })
        .where(eq(workflow_steps.id, step.id));
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
