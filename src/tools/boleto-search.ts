/**
 * Issue #432 — `boleto_search` (boleto proposal domain stub).
 *
 * Finds OPERATIONAL boleto records related to a company. This is NOT
 * `parse_boleto`: `parse_boleto` OCRs a boleto image/PDF into
 * `linha_digitavel`/`valor`/`vencimento`/… (`src/tools/parse-boleto.ts`);
 * `boleto_search` queries a boleto record store keyed by company/number/id —
 * which does not exist yet.
 *
 * STUB. No boleto repository/integration exists (validated in the #432 audit;
 * every "boleto" hit in the tree is OCR). Returns empty matches with
 * `source: 'stub'`. Reuses NO parser logic.
 *
 * side_effect: 'read', operation_type: 'read'.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';

const inputSchema = z
  .object({
    company_id: z.string().max(120).optional(),
    cnpj: z.string().max(40).optional(),
    boleto_number: z.string().max(120).optional(),
    boleto_id: z.string().max(120).optional(),
    amount: z.number().optional(),
  })
  .strip();

const matchedBoletoShape = z.object({
  boleto_id: z.string(),
  status: z.string(),
  amount: z.number().optional(),
  due_date: z.string().optional(),
  paid_at: z.string().optional(),
  source: z.string().optional(),
});

const outputSchema = z.object({
  matched_boletos: z.array(matchedBoletoShape),
  count: z.number(),
  source: z.enum(['stub', 'integration', 'local']),
});

export const boletoSearchTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'boleto_search',
  description:
    'Busca registros operacionais de boletos relacionados a uma empresa (por company_id/CNPJ/número/id/valor). NÃO é o parse_boleto (que faz OCR de imagem). STUB: ainda não há repositório/integração de boletos — retorna matched_boletos vazio com source=stub.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['read_billing'],
  side_effect: 'read',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'boleto_searched',
  handler: async () => ({
    matched_boletos: [],
    count: 0,
    source: 'stub' as const,
  }),
};
