/**
 * Issue #432 — `company_history_lookup` (boleto proposal domain stub).
 *
 * Reads relationship history for a company (previous service interactions,
 * complaints, refunds, operational notes).
 *
 * STUB. There is NO history table/integration AND no `contrapartes.metadata`
 * history convention today (validated in the #432 tech-lead audit). So this
 * returns empty arrays with `source: 'stub'` and invents no metadata keys. It
 * does NOT read `contrapartes` (the repo's `byId`/`byScope` are not tenant-
 * pinned; a real read path would have to add tenant_id + agent_id first).
 *
 * side_effect: 'read', operation_type: 'read' — pure (stub) read.
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
  previous_service_interactions: z.array(z.unknown()),
  complaints: z.array(z.unknown()),
  refunds: z.array(z.unknown()),
  operational_notes: z.array(z.string()),
  source: z.enum(['metadata', 'stub', 'integration']),
});

export const companyHistoryLookupTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'company_history_lookup',
  description:
    'Lê o histórico de relacionamento de uma empresa (atendimentos anteriores, reclamações, reembolsos, notas operacionais). STUB: ainda não há tabela/integração de histórico — retorna listas vazias com source=stub.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['read_company'],
  side_effect: 'read',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'company_history_lookup_completed',
  handler: async () => ({
    found: false,
    previous_service_interactions: [],
    complaints: [],
    refunds: [],
    operational_notes: [],
    source: 'stub' as const,
  }),
};
