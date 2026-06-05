/**
 * Issue #432 — `company_blacklist_check` (boleto proposal domain stub).
 *
 * Checks whether a company has blocks or special operational notes.
 *
 * STUB. There is NO blacklist store and no `contrapartes.metadata`/`status`
 * blacklist convention today. To avoid a false negative that reads as a
 * cleared/authorized company, this returns `status: 'unknown'` with
 * `blocked: false` (no positive block asserted, but NOT 'clear' either) and
 * `source: 'stub'`. It invents no metadata keys and does not read
 * `contrapartes` (the repo is not tenant-pinned).
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
  blocked: z.boolean(),
  status: z.enum(['clear', 'blocked', 'attention', 'unknown']),
  block_reason: z.string().optional(),
  observations: z.array(z.string()),
  source: z.enum(['metadata', 'stub', 'integration']),
});

export const companyBlacklistCheckTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'company_blacklist_check',
  description:
    'Verifica se uma empresa tem bloqueios ou notas operacionais especiais. STUB: ainda não há base de bloqueios/convenção em contrapartes — retorna status=unknown, blocked=false, source=stub (não afirma que a empresa está liberada).',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['read_company'],
  side_effect: 'read',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'company_blacklist_checked',
  handler: async () => ({
    blocked: false,
    status: 'unknown' as const,
    observations: [],
    source: 'stub' as const,
  }),
};
