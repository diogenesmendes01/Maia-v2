/**
 * Issue #432 — `refund_lookup` (boleto proposal domain stub).
 *
 * Consults the status of a refund request.
 *
 * STUB. No refund repository/integration exists (validated in the #432 audit).
 * Returns `found: false`, `source: 'stub'`.
 *
 * side_effect: 'read', operation_type: 'read'.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';

const inputSchema = z
  .object({
    protocol: z.string().max(200).optional(),
    company_id: z.string().max(120).optional(),
    cnpj: z.string().max(40).optional(),
  })
  .strip();

const outputSchema = z.object({
  found: z.boolean(),
  current_status: z.string().optional(),
  expected_date: z.string().optional(),
  history: z.array(z.unknown()),
  pending_items: z.array(z.string()),
  final_receipt_ref: z.string().optional(),
  source: z.enum(['stub', 'integration', 'local']),
});

export const refundLookupTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'refund_lookup',
  description:
    'Consulta o status de uma solicitação de reembolso (por protocolo ou empresa). STUB: ainda não há repositório/integração de reembolsos — retorna found=false, source=stub.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['read_balance'],
  side_effect: 'read',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'refund_lookup_completed',
  handler: async () => ({
    found: false,
    history: [],
    pending_items: [],
    source: 'stub' as const,
  }),
};
