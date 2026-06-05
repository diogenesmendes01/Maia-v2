/**
 * Issue #416 — `boleto_cancel` (boleto proposal vertical, WRITE).
 *
 * Performs the operational cancellation / baixa of a boleto. This is one of the
 * THREE sensitive write tools of the vertical (with `company_campaign_remove`
 * and `refund_create`). Per the capability taxonomy (§3, §6) and the issue:
 *
 *   - side_effect: 'write' — so it can NEVER be a baseline tool and ALWAYS flows
 *     through the dispatcher guard + `constitutionalCheck` (invariant #2/#5).
 *   - It declares INTENT + side-effect only. It does NOT decide confirmation —
 *     `confirm_before_write_policy` (migration 078) + the dispatcher decide
 *     whether the write executes. There is deliberately NO `if (needsConfirm)`
 *     branch here (anti-pattern §7).
 *   - required_actions: ['cancel_boleto'] — a granular permission key the
 *     dispatcher's `canAct` enforces (distinct from finance keys, so the
 *     boleto-proposta role is authorised for boleto baixa WITHOUT generic
 *     financial grants).
 *   - The dispatcher audits the decision (`boleto_cancelled`) after execution
 *     (invariant #4); we do NOT open a parallel write path.
 *
 * Out of scope (#416): a real cancellation API call — the handler is a
 * contract-honouring stub that returns the confirmation/protocol shape.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';

const inputSchema = z.object({
  // Required so the dispatcher routes the profile-permission check to the entity
  // that owns the boleto (mirrors cancel_transaction's entidade_id discipline).
  entidade_id: z.string().uuid(),
  boleto_id: z.string().max(64),
  cnpj: z.string().max(20).optional(),
  company_id: z.string().max(64).optional(),
  reason: z.string().min(1).max(500),
  // The dispatcher reads this when a governing policy / constitutional rule
  // requires a second approver; the tool itself does not branch on it.
  dual_approval_granted: z.boolean().optional(),
});

const outputSchema = z.union([
  z.object({
    ok: z.literal(true),
    boleto_id: z.string(),
    protocol: z.string(),
    resulting_status: z.string(),
  }),
  z.object({ error: z.string() }),
]);

export const boletoCancelTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'boleto_cancel',
  description:
    'Executa a baixa/cancelamento operacional de um boleto. Operação de ESCRITA: declara intenção e efeito; a confirmação é decidida por policy + dispatcher, nunca pelo próprio tool. Requer motivo e a entidade dona do boleto.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['cancel_boleto'],
  side_effect: 'write',
  redis_required: false,
  operation_type: 'cancel',
  audit_action: 'boleto_cancelled',
  extractAlvoId: (result) =>
    'boleto_id' in result && typeof result.boleto_id === 'string' ? result.boleto_id : null,
  handler: async (args) => {
    // Stub: no live cancellation API in #416. The guard chain (constitutional +
    // canAct + policy) has already authorised execution by the time we get here.
    return {
      ok: true as const,
      boleto_id: args.boleto_id,
      protocol: `stub-cancel-${args.boleto_id}`,
      resulting_status: 'cancelado',
    };
  },
};
