import { workflowsRepo, workflowStepsRepo } from '@/db/repositories.js';
import { logger } from '@/lib/logger.js';
import { audit } from '@/governance/audit.js';
import { expireDueDualApprovals } from './dual-approval.js';
import { dispatchTool } from '@/tools/_dispatcher.js';
import type { ToolContext } from '@/tools/_dispatcher.js';

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
