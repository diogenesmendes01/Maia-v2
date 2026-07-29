/**
 * Issue #416 — `campaign_status_lookup` (boleto proposal vertical, read-only).
 *
 * Check whether a company is active/eligible for proposal campaigns.
 * Conservative: side_effect 'read'. Out of scope (#416): a real campaign
 * backend — contract-honouring stub.
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
  .describe('Consulta status de campanha. Informe cnpj OU company_id (ao menos um).');

const outputSchema = z.object({
  status: z.enum(['active', 'removed', 'unknown']),
  campaign_status: z.string().optional(),
  campaign_metadata: z.record(z.string(), z.unknown()).optional(),
});

export const campaignStatusLookupTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'campaign_status_lookup',
  description:
    'Verifica se uma empresa está ativa/elegível para campanhas de proposta e retorna o status e metadados relevantes da campanha. Apenas leitura.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: [],
  side_effect: 'read',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'campaign_status_looked_up',
  handler: async () => {
    // Stub: no live campaign backend in #416.
    return { status: 'unknown' as const };
  },
};
