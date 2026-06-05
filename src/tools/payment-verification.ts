/**
 * Issue #432 — `payment_verification` (boleto proposal domain stub).
 *
 * Confirms whether a boleto/payment was actually paid.
 *
 * STUB. No payment-reconciliation integration exists. CRITICAL: this returns
 * `paid: null` — NEVER `false` — absent real evidence. `false` would assert a
 * confirmed non-payment (a dangerous false certainty that could justify a
 * second charge / dunning); `null` correctly means "unknown, not verified".
 * `source: 'stub'`.
 *
 * side_effect: 'read', operation_type: 'read'.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';

const inputSchema = z
  .object({
    company_id: z.string().max(120).optional(),
    cnpj: z.string().max(40).optional(),
    boleto_id: z.string().max(120).optional(),
    payment_reference: z.string().max(200).optional(),
    amount: z.number().optional(),
  })
  .strip();

const outputSchema = z.object({
  // boolean | null — null is the ONLY stub value (never false). A real
  // integration may later set true/false from evidence.
  paid: z.boolean().nullable(),
  payment_date: z.string().optional(),
  payment_amount: z.number().optional(),
  reconciliation_status: z.string().optional(),
  source: z.enum(['stub', 'integration', 'local']),
});

export const paymentVerificationTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'payment_verification',
  description:
    'Verifica se um boleto/pagamento foi efetivamente pago. STUB: ainda não há reconciliação de pagamentos — retorna paid=null (NUNCA false, para não afirmar falsamente que NÃO foi pago) com source=stub.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['read_balance'],
  side_effect: 'read',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'payment_verified',
  handler: async () => ({
    paid: null,
    source: 'stub' as const,
  }),
};
