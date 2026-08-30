/**
 * Issue #416 — `dda_lookup` (boleto proposal vertical, read-only).
 *
 * Check a boleto's status inside the DDA (Débito Direto Autorizado) flow:
 * current DDA situation, sync status, baixa info. Conservative: side_effect
 * 'read'. Out of scope (#416): a real DDA integration — contract-honouring stub.
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
  })
  // Issue #509 §6 — regra cross-field sem keyword JSON Schema; Zod é a autoridade.
  .describe(
    'Consulta DDA. Informe AO MENOS UM: boleto_id, boleto_metadata, cnpj ou company_id.',
  );

const outputSchema = z.object({
  dda_situation: z.string(),
  sync_status: z.string().optional(),
  baixa_info: z
    .object({
      baixado: z.boolean().optional(),
      baixa_date: z.string().optional(),
    })
    .optional(),
});

export const ddaLookupTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'dda_lookup',
  description:
    'Consulta o status de um boleto no fluxo DDA: situação atual, status de sincronização e informações de baixa. Apenas leitura.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: [],
  side_effect: 'read',
  effect_class: 'abort_safe',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'dda_looked_up',
  handler: async () => {
    // Stub: no live DDA integration in #416.
    return { dda_situation: 'unknown' };
  },
};
