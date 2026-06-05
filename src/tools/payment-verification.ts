/**
 * Issue #416 — `payment_verification` (boleto proposal vertical, read-only).
 *
 * Confirm whether a boleto was paid: paid/not paid, payment date/amount, and
 * reconciliation status when available. Conservative: side_effect 'read'. Out of
 * scope (#416): a real payment backend — contract-honouring stub.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';

const inputSchema = z
  .object({
    cnpj: z.string().max(20).optional(),
    company_id: z.string().max(64).optional(),
    boleto_id: z.string().max(64).optional(),
    boleto_metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((v) => Boolean(v.boleto_id ?? v.boleto_metadata ?? v.cnpj ?? v.company_id), {
    message: 'a boleto reference or company identifier is required',
  });

const outputSchema = z.object({
  paid: z.boolean(),
  payment_date: z.string().optional(),
  payment_amount: z.number().optional(),
  reconciliation_status: z.string().optional(),
});

export const paymentVerificationTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'payment_verification',
  description:
    'Confirma se um boleto foi pago: pago/não pago, data e valor do pagamento e status de conciliação quando disponível. Apenas leitura.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: [],
  side_effect: 'read',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'payment_verified',
  handler: async () => {
    // Stub: no live payment backend in #416.
    return { paid: false };
  },
};
