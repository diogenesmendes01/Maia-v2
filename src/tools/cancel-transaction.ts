import { z } from 'zod';
import type { Tool } from './_registry.js';
import { transacoesRepo } from '@/db/repositories.js';
import { audit } from '@/governance/audit.js';

const inputSchema = z.object({
  // Required so the dispatcher routes the profile-permission check to the
  // entity that actually owns the transaction. Without it, the dispatcher
  // would fall back to `scope.entidades[0]` and could authorize against the
  // wrong profile (allowing/blocking based on an unrelated entity).
  entidade_id: z.string().uuid(),
  transacao_id: z.string().uuid(),
  motivo: z.string().max(200).optional(),
});

const outputSchema = z.union([
  z.object({ ok: z.literal(true), transacao_id: z.string() }),
  z.object({ error: z.string() }),
]);

export const cancelTransactionTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'cancel_transaction',
  description:
    'Cancela uma transação registrada. Use APENAS quando o dono explicitamente confirmar (via pending edit_review, ou comando direto). Out-of-scope é recusado. `entidade_id` deve ser a entidade dona da transação.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['cancel_transaction'],
  side_effect: 'write',
  redis_required: false,
  operation_type: 'cancel',
  audit_action: 'transaction_cancelled',
  extractAlvoId: (result) =>
    'transacao_id' in result && typeof result.transacao_id === 'string' ? result.transacao_id : null,
  handler: async (args, ctx) => {
    const tx = await transacoesRepo.byId(args.transacao_id);
    if (!tx) return { error: 'not_found' };
    // Defense in depth: even though the dispatcher already authorized
    // `args.entidade_id`, the resource itself must belong to that entity.
    // Otherwise a profile that allows cancel_transaction on entity A could
    // be misused to cancel a transaction owned by entity B.
    if (tx.entidade_id !== args.entidade_id) return { error: 'forbidden' };
    if (!ctx.scope.entidades.includes(tx.entidade_id)) return { error: 'forbidden' };
    if (tx.status === 'cancelada') {
      return { ok: true as const, transacao_id: tx.id };
    }
    await transacoesRepo.update(tx.id, {
      status: 'cancelada',
      updated_at: new Date(),
    });
    await audit({
      acao: 'transaction_cancelled',
      pessoa_id: ctx.pessoa.id,
      conversa_id: ctx.conversa.id,
      mensagem_id: ctx.mensagem_id,
      entidade_alvo: tx.entidade_id,
      alvo_id: tx.id,
      metadata: { motivo: args.motivo ?? null },
    });
    return { ok: true as const, transacao_id: tx.id };
  },
};
