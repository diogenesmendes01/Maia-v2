/**
 * Issue #416 — `company_campaign_remove` (boleto proposal vertical, WRITE).
 *
 * Remove or block a company from FUTURE proposal campaigns. One of the THREE
 * sensitive write tools of the vertical. Same governance contract as
 * `boleto_cancel` (taxonomy §3/§6):
 *
 *   - side_effect: 'write' — never baseline; always through the dispatcher guard
 *     + `constitutionalCheck`.
 *   - Declares intent + side-effect only; confirmation is decided by
 *     `confirm_before_write_policy` (migration 078) + the dispatcher, NOT here.
 *   - required_actions: ['remove_company_campaign'] — granular permission key.
 *   - The dispatcher audits (`company_campaign_removed`) after execution.
 *
 * Out of scope (#416): a real campaign API call — contract-honouring stub.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';

const inputSchema = z.object({
  entidade_id: z.string().uuid(),
  cnpj: z.string().max(20).optional(),
  company_id: z.string().max(64).optional(),
  reason: z.string().min(1).max(500),
  dual_approval_granted: z.boolean().optional(),
});

const outputSchema = z.union([
  z.object({
    ok: z.literal(true),
    updated_status: z.string(),
    protocol: z.string().optional(),
  }),
  z.object({ error: z.string() }),
]);

export const companyCampaignRemoveTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'company_campaign_remove',
  description:
    'Remove ou bloqueia uma empresa de campanhas de proposta futuras. Operação de ESCRITA: a confirmação é decidida por policy + dispatcher, nunca pelo próprio tool. Requer motivo e a entidade alvo.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['remove_company_campaign'],
  side_effect: 'write',
  redis_required: false,
  operation_type: 'update_meta',
  audit_action: 'company_campaign_removed',
  handler: async () => {
    // Stub: no live campaign API in #416. Guard chain already authorised here.
    return {
      ok: true as const,
      updated_status: 'removed',
      protocol: 'stub-campaign-remove',
    };
  },
};
