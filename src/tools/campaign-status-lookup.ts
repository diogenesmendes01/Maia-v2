/**
 * Issue #432 — `campaign_status_lookup` (boleto proposal domain stub).
 *
 * Checks whether a company is active/eligible for proposal campaigns.
 *
 * STUB. There is NO campaign store and no `contrapartes.metadata` campaign
 * convention today (`proposalsUnifiedRepo` is governance proposals, not
 * campaigns). Returns `found: false`, `source: 'stub'`, and invents no
 * metadata keys.
 *
 * side_effect: 'read', operation_type: 'read'.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';

const inputSchema = z
  .object({
    company_id: z.string().max(120).optional(),
    cnpj: z.string().max(40).optional(),
  })
  .strip();

const outputSchema = z.object({
  found: z.boolean(),
  active: z.boolean().optional(),
  removed: z.boolean().optional(),
  campaign_status: z.string().optional(),
  metadata: z.unknown().optional(),
  source: z.enum(['metadata', 'stub', 'integration']),
});

export const campaignStatusLookupTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'campaign_status_lookup',
  description:
    'Verifica se uma empresa está ativa/elegível para campanhas de proposta. STUB: ainda não há base de campanhas/convenção em contrapartes — retorna found=false, source=stub.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['read_company'],
  side_effect: 'read',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'campaign_status_lookup_completed',
  handler: async () => ({
    found: false,
    source: 'stub' as const,
  }),
};
