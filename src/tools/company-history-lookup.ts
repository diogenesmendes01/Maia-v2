/**
 * Issue #416 — `company_history_lookup` (boleto proposal vertical, read-only).
 *
 * Read the relationship history for a company: prior service interactions,
 * complaints, refunds, and operational notes. Conservative: side_effect 'read'.
 * Out of scope (#416): a real CRM/history integration — contract-honouring stub.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';

const inputSchema = z
  .object({
    cnpj: z.string().max(20).optional(),
    company_id: z.string().max(64).optional(),
  })
  .refine((v) => Boolean(v.cnpj ?? v.company_id), {
    message: 'cnpj or company_id is required',
  })
  // Issue #509 §6 — regra cross-field sem keyword JSON Schema; Zod é a autoridade.
  .describe('Histórico de interações da empresa. Informe cnpj OU company_id (ao menos um).');

const outputSchema = z.object({
  company_id: z.string().optional(),
  interactions: z
    .array(
      z.object({
        date: z.string().optional(),
        channel: z.string().optional(),
        summary: z.string().optional(),
      }),
    )
    .default([]),
  complaints: z.array(z.object({ date: z.string().optional(), summary: z.string().optional() })).default([]),
  refunds: z.array(z.object({ protocol: z.string().optional(), status: z.string().optional() })).default([]),
  operational_notes: z.array(z.string()).default([]),
});

export const companyHistoryLookupTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'company_history_lookup',
  description:
    'Lê o histórico de relacionamento de uma empresa: atendimentos anteriores, reclamações, reembolsos e notas operacionais. Apenas leitura.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: [],
  side_effect: 'read',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'company_history_looked_up',
  handler: async () => {
    // Stub: no live history integration in #416.
    return { interactions: [], complaints: [], refunds: [], operational_notes: [] };
  },
};
