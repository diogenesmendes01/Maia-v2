import { z } from 'zod';
import type { Tool } from './_registry.js';
import { transacoesRepo } from '@/db/repositories.js';
import { withTx } from '@/db/client.js';
import { auditTx } from '@/governance/audit.js';

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
  // Issue #366 — cancelling a transaction is a FINANCIAL lifecycle mutation;
  // its audit row is written TRANSACTIONALLY (auditTx inside the withTx below),
  // so the dispatcher must NOT also fire its post-commit audit() (no duplicate).
  audits_in_tx: true,
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
    // Issue #366 — DURABLE audit: the cancel UPDATE and its audit row commit (or
    // roll back) together in ONE withTx. `auditTx` does NOT swallow errors, so a
    // failed audit insert aborts the cancel — the transaction can never flip to
    // 'cancelada' without its audit row. `audits_in_tx` suppresses the
    // dispatcher's post-commit best-effort audit() (no duplicate audit row).
    await withTx(async (txn) => {
      await transacoesRepo.updateTx(txn, tx.id, {
        status: 'cancelada',
        updated_at: new Date(),
      });
      await auditTx(txn, {
        acao: 'transaction_cancelled',
        pessoa_id: ctx.pessoa.id,
        conversa_id: ctx.conversa.id,
        mensagem_id: ctx.mensagem_id,
        entidade_alvo: tx.entidade_id,
        alvo_id: tx.id,
        metadata: { motivo: args.motivo ?? null },
      });
    });
    return { ok: true as const, transacao_id: tx.id };
  },
};
