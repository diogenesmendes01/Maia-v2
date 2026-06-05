/**
 * Issue #416 — `company_identity_resolver` (boleto proposal vertical, read-only).
 *
 * Resolve an incomplete or informal company identity (a trade name, a nickname,
 * a partner's name, free-text from the customer) into a concrete company
 * candidate BEFORE a formal `company_search`. This is deliberately DISTINCT from
 * `company_search` (acceptance criterion): the resolver disambiguates fuzzy
 * input and decides whether user confirmation is needed; `company_search`
 * locates a company by an already-resolved identifier.
 *
 * Conservative by construction:
 *   - side_effect: 'read' — it reads/interprets identity signals; it never
 *     mutates a record.
 *   - It returns `needs_confirmation` + a `question` when ambiguous; whether the
 *     turn then confirms is a POLICY/agent-loop decision, NOT an `if` in a tool
 *     (taxonomy §3/§6 — "confirmation is a policy decision").
 *
 * Out of scope (#416): a real identity/CNPJ lookup integration. The handler is a
 * contract-honouring stub that echoes the resolution shape so #415's skills can
 * compose against a stable Zod contract.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';

const inputSchema = z.object({
  partial_company_name: z.string().max(200).optional(),
  trade_name: z.string().max(200).optional(),
  partial_legal_name: z.string().max(200).optional(),
  partner_name: z.string().max(200).optional(),
  customer_message: z.string().max(2000).optional(),
  phone: z.string().max(40).optional(),
  conversation_context: z.string().max(4000).optional(),
});

const candidateSchema = z.object({
  company_id: z.string(),
  name: z.string(),
  cnpj: z.string().optional(),
});

const outputSchema = z.object({
  resolved: z.boolean(),
  confidence: z.enum(['high', 'medium', 'low']),
  company_id: z.string().optional(),
  cnpj: z.string().optional(),
  matched_by: z.array(z.string()).default([]),
  needs_confirmation: z.boolean(),
  candidates: z.array(candidateSchema).default([]),
  alternatives: z.array(candidateSchema).default([]),
  question: z.string().optional(),
});

export const companyIdentityResolverTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'company_identity_resolver',
  description:
    'Resolve uma identidade de empresa incompleta/informal (nome fantasia, apelido, nome de sócio, texto livre do cliente) em um candidato concreto ANTES da busca formal. Distinta de company_search: desambigua e decide se precisa confirmação. Apenas leitura.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: [],
  side_effect: 'read',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'company_identity_resolved',
  handler: async () => {
    // Stub: no live identity integration in #416. Return a conservative
    // "unresolved, needs confirmation" shape so the agent asks rather than
    // guessing — the safe default until #415's skills + a real resolver land.
    return {
      resolved: false,
      confidence: 'low' as const,
      matched_by: [],
      needs_confirmation: true,
      candidates: [],
      alternatives: [],
    };
  },
};
