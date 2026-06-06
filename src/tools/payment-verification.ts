/**
 * Issue #432 — `payment_verification` (boleto proposal vertical, read-only).
 *
 * Confirm whether a boleto was actually paid. Conservative: side_effect 'read'.
 *
 * HONEST STUB (issue #432): there is NO payment-reconciliation backend yet, so
 * this returns `paid: null` — NEVER `false`. `false` would assert a CONFIRMED
 * non-payment (a dangerous false certainty that could justify a second charge or
 * dunning); `null` correctly means "unknown — not verified". `source: 'stub'`
 * flags the absence of a real integration. A future integration may set
 * true/false from real evidence; the stub never does. The governance metadata
 * (audit_action `payment_verified`, side_effect 'read') is unchanged from #416.
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
  // boolean | null — `null` is the ONLY value the stub emits (never `false`,
  // which would assert a confirmed non-payment without evidence). A real
  // integration may later set true/false from reconciliation evidence.
  paid: z.boolean().nullable(),
  payment_date: z.string().optional(),
  payment_amount: z.number().optional(),
  reconciliation_status: z.string().optional(),
  source: z.enum(['stub', 'integration', 'local']),
});

export const paymentVerificationTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'payment_verification',
  description:
    'Verifica se um boleto foi efetivamente pago. STUB (#432): ainda não há reconciliação de pagamentos — retorna paid=null (NUNCA false, para não afirmar sem evidência que NÃO foi pago) com source=stub. Apenas leitura.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: [],
  side_effect: 'read',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'payment_verified',
  handler: async () => {
    // Honest stub (#432): no payment-reconciliation backend yet. Return
    // paid=null (uncertain), NEVER false — `false` would falsely assert a
    // confirmed non-payment.
    return { paid: null, source: 'stub' as const };
  },
};
