/**
 * Issue #416/#432 — `company_campaign_remove` (boleto proposal vertical, WRITE).
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
 * HONEST STUB (issue #432): there is NO campaign store to mutate, so the handler
 * changes NO state. It returns `executed: false`, `status: 'stub_not_executed'`
 * and NO fabricated `operation_protocol` / `updated_status` — it must NEVER fake
 * a successful removal (invariant #2: fail-closed). It keeps `side_effect:
 * 'write'` + `operation_type: 'update_meta'` so the dispatcher keys idempotency
 * and auto-audits.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';

const inputSchema = z
  .object({
    entidade_id: z.string().uuid(),
    // .trim().min(1) so a blank " " cannot satisfy the cnpj/company_id refine.
    cnpj: z.string().trim().min(1).max(20).optional(),
    company_id: z.string().trim().min(1).max(64).optional(),
    reason: z.string().trim().min(1).max(500),
    // Fase 0 cap. 3: sem `dual_approval_granted` — evidência humana só via
    // store backend (approval_requests), nunca por args do LLM.
  })
  // Target must be unambiguous: require at least one company identifier. The
  // policy declares `company_identified`, but the schema itself must reject a
  // write request that names neither cnpj nor company_id.
  .refine((v) => Boolean(v.cnpj ?? v.company_id), {
    message: 'company_campaign_remove requires cnpj or company_id',
    path: ['company_id'],
  })
  // Issue #509 §6 — regra cross-field sem keyword JSON Schema; Zod é a autoridade.
  .describe(
    'Remoção de campanha. Além dos campos obrigatórios, informe cnpj OU company_id ' +
      'para identificar a empresa alvo sem ambiguidade.',
  );

const outputSchema = z.object({
  executed: z.boolean(),
  status: z.enum([
    'stub_not_executed',
    'removed',
    'blocked',
    'requires_confirmation',
    'failed',
  ]),
  // Set ONLY by a real integration; the stub fabricates neither.
  operation_protocol: z.string().optional(),
  updated_status: z.string().optional(),
  message: z.string().optional(),
});

export const companyCampaignRemoveTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'company_campaign_remove',
  description:
    'Remove ou bloqueia uma empresa de campanhas de proposta futuras. Operação de ESCRITA (confirmação decidida por policy + dispatcher). STUB (#432): ainda não há base de campanhas — NÃO altera estado, retorna executed=false, status=stub_not_executed (sem protocolo falso).',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['remove_company_campaign'],
  side_effect: 'write',
  redis_required: false,
  operation_type: 'update_meta',
  audit_action: 'company_campaign_removed',
  handler: async () => {
    // Honest stub (#432): no campaign store. Change NO state and report it
    // explicitly — never fake a successful removal.
    return {
      executed: false,
      status: 'stub_not_executed' as const,
      message:
        'Remoção de campanha ainda não implementada (stub): nenhuma alteração foi executada.',
    };
  },
};
