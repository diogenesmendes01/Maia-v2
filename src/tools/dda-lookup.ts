/**
 * Issue #432 — `dda_lookup` (boleto proposal domain stub).
 *
 * Checks a boleto's status inside the DDA (débito direto autorizado) flow.
 *
 * STUB. There is NO DDA integration (and no integrations/clients dir at all,
 * per the #432 audit). Returns `found: false`, `source: 'stub'`.
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
    boleto_metadata: z.unknown().optional(),
  })
  .strip();

const outputSchema = z.object({
  found: z.boolean(),
  current_dda_situation: z.string().optional(),
  sync_status: z.string().optional(),
  baixa_information: z.unknown().optional(),
  source: z.enum(['stub', 'integration']),
});

export const ddaLookupTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'dda_lookup',
  description:
    'Consulta a situação de um boleto no fluxo de DDA (débito direto autorizado). STUB: ainda não há integração de DDA — retorna found=false, source=stub.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['read_balance'],
  side_effect: 'read',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'dda_lookup_completed',
  handler: async () => ({
    found: false,
    source: 'stub' as const,
  }),
};
