/**
 * Issue #416 — `company_search` (boleto proposal vertical, read-only).
 *
 * Locate a company using an ALREADY-resolved identifier (CNPJ, company id, legal
 * name, trade name, or partner name). Distinct from `company_identity_resolver`,
 * which disambiguates fuzzy/informal input first.
 *
 * Conservative: side_effect 'read'. Out of scope (#416): a real company-registry
 * integration — the handler is a contract-honouring stub.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';

const inputSchema = z
  .object({
    cnpj: z.string().max(20).optional(),
    company_id: z.string().max(64).optional(),
    legal_name: z.string().max(200).optional(),
    trade_name: z.string().max(200).optional(),
    partner_name: z.string().max(200).optional(),
  })
  .refine(
    (v) =>
      Boolean(v.cnpj ?? v.company_id ?? v.legal_name ?? v.trade_name ?? v.partner_name),
    { message: 'at least one search identifier is required' },
  );

const outputSchema = z.object({
  found: z.boolean(),
  company: z
    .object({
      company_id: z.string(),
      cnpj: z.string().optional(),
      legal_name: z.string().optional(),
      trade_name: z.string().optional(),
      status: z.string().optional(),
      internal_ids: z.array(z.string()).default([]),
    })
    .optional(),
});

export const companySearchTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'company_search',
  description:
    'Localiza uma empresa por identificador resolvido (CNPJ, id, razão social, nome fantasia ou sócio) e retorna dados cadastrais, status e identificadores internos. Apenas leitura.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: [],
  side_effect: 'read',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'company_searched',
  handler: async () => {
    // Stub: no live registry integration in #416.
    return { found: false };
  },
};
