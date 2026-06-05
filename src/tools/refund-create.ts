/**
 * Issue #432 — `refund_create` (boleto proposal domain WRITE stub).
 *
 * Creates an official refund request.
 *
 * STUB. There is NO refund repository/integration, so this creates NO refund:
 * it returns `executed: false`, `status: 'stub_not_executed'` and NO fake
 * `refund_protocol`. Declares `side_effect: 'write'` +
 * `operation_type: 'create'` (for the dispatcher's idempotency key) and
 * auto-audits from `audit_action`.
 *
 * Governance fields are ACCEPTED but NOT enforced (the gate is #416's policy
 * slice). NO `extractEffect` (no real external effect at stub stage).
 *
 * side_effect: 'write', operation_type: 'create'.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';

const inputSchema = z
  .object({
    company_id: z.string().max(120).optional(),
    cnpj: z.string().max(40).optional(),
    related_payment: z.unknown().optional(),
    related_boleto: z.unknown().optional(),
    receipt: z.unknown().optional(),
    pix_or_bank_data: z.unknown().optional(),
    reason: z.string().min(1).max(2000),
    actor_context: z.unknown().optional(),
    confirmation_id: z.string().max(200).optional(),
    dual_approval_granted: z.boolean().optional(),
  })
  .strip();

const outputSchema = z.object({
  executed: z.boolean(),
  status: z.enum([
    'stub_not_executed',
    'created',
    'requires_confirmation',
    'blocked',
    'failed',
  ]),
  refund_protocol: z.string().optional(),
  created_at: z.string().optional(),
  message: z.string().optional(),
});

export const refundCreateTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'refund_create',
  description:
    'Cria uma solicitação oficial de reembolso. STUB: ainda não há repositório/integração de reembolsos — NÃO cria reembolso, retorna executed=false, status=stub_not_executed (sem protocolo falso). Write governado por política (#416).',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['create_refund'],
  side_effect: 'write',
  redis_required: false,
  operation_type: 'create',
  audit_action: 'refund_create_requested',
  handler: async () => ({
    executed: false,
    status: 'stub_not_executed' as const,
    message: 'Criação de reembolso ainda não implementada (stub): nenhum reembolso foi criado.',
  }),
};
