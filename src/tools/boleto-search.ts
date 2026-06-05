/**
 * Issue #416 — `boleto_search` (boleto proposal vertical, read-only).
 *
 * Find boletos related to a company (by CNPJ/company id, boleto number/id, or
 * amount). Conservative: side_effect 'read'. Out of scope (#416): a real boleto
 * backend — contract-honouring stub.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';

const inputSchema = z
  .object({
    cnpj: z.string().max(20).optional(),
    company_id: z.string().max(64).optional(),
    boleto_number: z.string().max(64).optional(),
    boleto_id: z.string().max(64).optional(),
    amount: z.number().nonnegative().optional(),
  })
  .refine(
    (v) =>
      Boolean(
        v.cnpj ?? v.company_id ?? v.boleto_number ?? v.boleto_id ?? v.amount !== undefined,
      ),
    { message: 'at least one search criterion is required' },
  );

const outputSchema = z.object({
  boletos: z
    .array(
      z.object({
        boleto_id: z.string(),
        boleto_number: z.string().optional(),
        status: z.string(),
        due_date: z.string().optional(),
        issue_date: z.string().optional(),
        amount: z.number().optional(),
      }),
    )
    .default([]),
});

export const boletoSearchTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'boleto_search',
  description:
    'Localiza boletos de uma empresa (por CNPJ/id, número/id do boleto ou valor) e retorna status, datas e valores. Apenas leitura.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: [],
  side_effect: 'read',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'boleto_searched',
  handler: async () => {
    // Stub: no live boleto backend in #416.
    return { boletos: [] };
  },
};
