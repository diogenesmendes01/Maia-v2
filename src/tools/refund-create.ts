/**
 * Issue #416 — `refund_create` (boleto proposal vertical, WRITE).
 *
 * Create an official refund request. The THIRD sensitive write tool of the
 * vertical. Same governance contract as `boleto_cancel` /
 * `company_campaign_remove` (taxonomy §3/§6):
 *
 *   - side_effect: 'write' — never baseline; always through the dispatcher guard
 *     + `constitutionalCheck` (which also encodes the existing
 *     `no_refund_without_validation` hard limit, migration 037).
 *   - Declares intent + side-effect only; confirmation is decided by
 *     `confirm_before_write_policy` (migration 078) + the dispatcher, NOT here.
 *   - required_actions: ['create_refund'] — granular permission key.
 *   - The dispatcher audits (`refund_created`) after execution.
 *
 * Out of scope (#416): a real refund API call — contract-honouring stub.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';

const inputSchema = z
  .object({
    entidade_id: z.string().uuid(),
    cnpj: z.string().max(20).optional(),
    company_id: z.string().max(64).optional(),
    // The refund amount. Required so the dispatcher limit check + canAct can gate
    // the value — a refund with no ceiling must never be accepted by the schema.
    valor: z.number().positive(),
    // Evidence refs are .trim().min(1) so whitespace (" ") cannot satisfy the
    // refine below — an empty/blank string is rejected by the schema.
    related_payment_id: z.string().trim().min(1).max(64).optional(),
    related_boleto_id: z.string().trim().min(1).max(64).optional(),
    // A reference to the validated receipt (see `receipt_validate`).
    receipt_reference: z.string().trim().min(1).max(200).optional(),
    // Normalised PIX or bank data (see `bank_account_validate.normalized`).
    payment_data: z.record(z.string(), z.unknown()).optional(),
    reason: z.string().trim().min(1).max(500),
    dual_approval_granted: z.boolean().optional(),
  })
  // A refund must carry evidence: at least one of a related payment/boleto or a
  // validated receipt reference. Prevents opening a refund with no traceability.
  .refine(
    (v) => Boolean(v.related_payment_id ?? v.related_boleto_id ?? v.receipt_reference),
    {
      message:
        'refund_create requires evidence: related_payment_id, related_boleto_id, or receipt_reference',
      path: ['receipt_reference'],
    },
  );

const outputSchema = z.union([
  z.object({
    ok: z.literal(true),
    protocol: z.string(),
    status: z.string(),
    created_at: z.string(),
  }),
  z.object({ error: z.string() }),
]);

export const refundCreateTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'refund_create',
  description:
    'Cria uma solicitação oficial de reembolso. Operação de ESCRITA: a confirmação é decidida por policy + dispatcher, nunca pelo próprio tool. Requer motivo e a entidade alvo; comprovante e dados bancários quando aplicável.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['create_refund'],
  side_effect: 'write',
  redis_required: false,
  operation_type: 'create',
  audit_action: 'refund_created',
  extractAlvoId: (result) =>
    'protocol' in result && typeof result.protocol === 'string' ? result.protocol : null,
  handler: async () => {
    // Stub: no live refund API in #416. Guard chain already authorised here.
    return {
      ok: true as const,
      protocol: `stub-refund-${Date.now()}`,
      status: 'created',
      created_at: new Date().toISOString(),
    };
  },
};
