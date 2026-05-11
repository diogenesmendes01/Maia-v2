import { z } from 'zod';
import { workflowsRepo } from '@/db/repositories.js';
import { audit } from '@/governance/audit.js';
import type { Tool } from './_registry.js';

const inputSchema = z.object({
  workflow_id: z.string().uuid(),
  reason: z.string().max(280).optional(),
  cancel_chain: z.boolean().default(true),
});

const outputSchema = z.object({
  cancelled_ids: z.array(z.string()),
  chain_cancelled: z.boolean(),
});

/**
 * Cancels a workflow. When `cancel_chain` is true (default) and the target
 * workflow has a `chain_id`, cancels every workflow in the chain — stopping
 * the recurring series in one call. Only the workflow's `pessoa_envolvida`
 * (creator) can invoke this; permission gate enforced upstream.
 */
export const cancelWorkflowTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'cancel_workflow',
  description:
    'Cancela um workflow agendado (pagamento recorrente, outreach recorrente, etc.). Se cancel_chain=true (default) e o workflow tem chain_id, cancela toda a série recorrente de uma vez.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['schedule_reminder'],
  side_effect: 'write',
  redis_required: false,
  operation_type: 'cancel',
  audit_action: 'workflow_cancelled',
  handler: async (args, ctx) => {
    const wf = await workflowsRepo.byId(args.workflow_id);
    if (!wf) return { cancelled_ids: [], chain_cancelled: false };
    if (wf.pessoa_envolvida && wf.pessoa_envolvida !== ctx.pessoa.id) {
      throw new Error('apenas o criador do workflow pode cancelá-lo');
    }

    const targets: typeof wf[] = [];
    if (args.cancel_chain && wf.chain_id) {
      targets.push(...(await workflowsRepo.listByChain(wf.chain_id)));
    } else {
      targets.push(wf);
    }

    const cancelled_ids: string[] = [];
    for (const t of targets) {
      if (t.status === 'concluido' || t.status === 'cancelada' || t.status === 'falhou') continue;
      await workflowsRepo.setStatus(t.id, 'cancelada');
      cancelled_ids.push(t.id);
      await audit({
        acao: 'workflow_cancelled',
        pessoa_id: ctx.pessoa.id,
        conversa_id: ctx.conversa.id,
        mensagem_id: ctx.mensagem_id,
        alvo_id: t.id,
        metadata: { reason: args.reason ?? null, chain_id: t.chain_id ?? null },
      });
    }
    return {
      cancelled_ids,
      chain_cancelled: Boolean(args.cancel_chain && wf.chain_id),
    };
  },
};
