/**
 * Issue #432 — `company_campaign_remove` (boleto proposal domain WRITE stub).
 *
 * Removes or blocks a company from future proposal campaigns.
 *
 * STUB. There is NO campaign store to mutate, so this changes NO state: it
 * returns `executed: false`, `status: 'stub_not_executed'` and NO fake
 * `operation_protocol`. Declares `side_effect: 'write'` +
 * `operation_type: 'update_meta'` (a metadata mutation, for the dispatcher's
 * idempotency key) and auto-audits from `audit_action`.
 *
 * Governance fields are ACCEPTED but NOT enforced (the gate is #416's policy
 * slice). NO `extractEffect` (no real external effect at stub stage).
 *
 * side_effect: 'write', operation_type: 'update_meta'.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';

const inputSchema = z
  .object({
    company_id: z.string().max(120).optional(),
    cnpj: z.string().max(40).optional(),
    reason: z.string().min(1).max(2000),
    actor_context: z.unknown().optional(),
    confirmation_id: z.string().max(200).optional(),
    dual_approval_granted: z.boolean().optional(),
  })
  .strip();

const outputSchema = z.object({
  executed: z.boolean(),
  status: z.enum([
    'stub_not_executed',
    'removed',
    'blocked',
    'requires_confirmation',
    'failed',
  ]),
  operation_protocol: z.string().optional(),
  updated_status: z.string().optional(),
  message: z.string().optional(),
});

export const companyCampaignRemoveTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'company_campaign_remove',
  description:
    'Remove ou bloqueia uma empresa de futuras campanhas de proposta. STUB: ainda não há base de campanhas — NÃO altera estado, retorna executed=false, status=stub_not_executed (sem protocolo falso). Write governado por política (#416).',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['remove_campaign'],
  side_effect: 'write',
  redis_required: false,
  operation_type: 'update_meta',
  audit_action: 'company_campaign_remove_requested',
  handler: async () => ({
    executed: false,
    status: 'stub_not_executed' as const,
    message: 'Remoção de campanha ainda não implementada (stub): nenhuma alteração foi executada.',
  }),
};
