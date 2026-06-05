/**
 * Issue #416 — `refund_lookup` (boleto proposal vertical, read-only).
 *
 * Consult refund status: current status, expected date, history, pending items,
 * and the final comprovante when available. Conservative: side_effect 'read'.
 * Out of scope (#416): a real refund backend — contract-honouring stub.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';

const inputSchema = z
  .object({
    protocol: z.string().max(128).optional(),
    cnpj: z.string().max(20).optional(),
    company_id: z.string().max(64).optional(),
  })
  .refine((v) => Boolean(v.protocol ?? v.cnpj ?? v.company_id), {
    message: 'a protocol or company identifier is required',
  });

const outputSchema = z.object({
  found: z.boolean(),
  status: z.string().optional(),
  expected_date: z.string().optional(),
  history: z.array(z.object({ date: z.string().optional(), event: z.string().optional() })).default([]),
  pending_items: z.array(z.string()).default([]),
  final_receipt_reference: z.string().optional(),
});

export const refundLookupTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'refund_lookup',
  description:
    'Consulta o status de um reembolso: status atual, data prevista, histórico, pendências e comprovante final quando disponível. Apenas leitura.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: [],
  side_effect: 'read',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'refund_looked_up',
  handler: async () => {
    // Stub: no live refund backend in #416.
    return { found: false, history: [], pending_items: [] };
  },
};
