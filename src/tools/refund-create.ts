/**
 * Issue #416/#432 — `refund_create` (boleto proposal vertical, WRITE).
 *
 * Create an official refund request. The THIRD sensitive write tool of the
 * vertical. Same governance contract as `boleto_cancel` /
 * `company_campaign_remove` (taxonomy §3/§6):
 *
 *   - side_effect: 'write' — never baseline; always through the dispatcher guard
 *     + `constitutionalCheck` (which also encodes the existing
 *     `no_refund_without_validation` hard limit, migration 037).
 *   - Declares intent + side-effect only; confirmation is decided by
 *     `confirm_before_write_policy` (migration 078) + the dispatcher, NOT here.
 *   - required_actions: ['create_refund'] — granular permission key.
 *   - The dispatcher audits (`refund_created`) after execution.
 *
 * HONEST STUB (issue #432): there is NO refund repository/integration, so the
 * handler creates NO refund. It returns `executed: false`, `status:
 * 'stub_not_executed'` and NO fabricated `refund_protocol` / `created_at` — it
 * must NEVER fake a created refund (invariant #2: fail-closed). It keeps
 * `side_effect: 'write'` + `operation_type: 'create'` so the dispatcher keys
 * idempotency and auto-audits.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';

const inputSchema = z
  .object({
    entidade_id: z.string().uuid(),
    cnpj: z.string().max(20).optional(),
    company_id: z.string().max(64).optional(),
    // The refund amount. Required so the dispatcher limit check + canAct can gate
    // the value — a refund with no ceiling must never be accepted by the schema.
    valor: z.number().positive(),
    // Evidence refs are .trim().min(1) so whitespace (" ") cannot satisfy the
    // refine below — an empty/blank string is rejected by the schema.
    related_payment_id: z.string().trim().min(1).max(64).optional(),
    related_boleto_id: z.string().trim().min(1).max(64).optional(),
    // A reference to the validated receipt (see `receipt_validate`).
    receipt_reference: z.string().trim().min(1).max(200).optional(),
    // Normalised PIX or bank data (see `bank_account_validate.normalized`).
    payment_data: z.record(z.string(), z.unknown()).optional(),
    reason: z.string().trim().min(1).max(500),
    // Fase 0 cap. 3: sem `dual_approval_granted` — evidência humana só via
    // store backend (approval_requests), nunca por args do LLM.
  })
  // A refund must carry evidence: at least one of a related payment/boleto or a
  // validated receipt reference. Prevents opening a refund with no traceability.
  .refine(
    (v) => Boolean(v.related_payment_id ?? v.related_boleto_id ?? v.receipt_reference),
    {
      message:
        'refund_create requires evidence: related_payment_id, related_boleto_id, or receipt_reference',
      path: ['receipt_reference'],
    },
  )
  // Issue #509 §6 — regra cross-field sem keyword JSON Schema; Zod é a autoridade.
  .describe(
    'Abertura de reembolso. Além dos campos obrigatórios, informe AO MENOS UMA ' +
      'evidência: related_payment_id, related_boleto_id ou receipt_reference. ' +
      'Valor em BRL. A aprovação humana, quando exigida, é resolvida pelo backend.',
  );

const outputSchema = z.object({
  executed: z.boolean(),
  status: z.enum([
    'stub_not_executed',
    'created',
    'requires_confirmation',
    'blocked',
    'failed',
  ]),
  // Set ONLY by a real integration; the stub fabricates neither.
  refund_protocol: z.string().optional(),
  created_at: z.string().optional(),
  message: z.string().optional(),
});

export const refundCreateTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'refund_create',
  description:
    'Cria uma solicitação oficial de reembolso. Operação de ESCRITA (confirmação decidida por policy + dispatcher). STUB (#432): ainda não há repositório/integração de reembolsos — NÃO cria reembolso, retorna executed=false, status=stub_not_executed (sem protocolo falso).',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['create_refund'],
  side_effect: 'write',
  effect_class: 'non_interruptible',
  redis_required: false,
  operation_type: 'create',
  audit_action: 'refund_created',
  // No `extractAlvoId`: the stub creates no refund, so there is no real alvo_id
  // (a fabricated protocol would be dishonest). A real integration can map the
  // refund protocol here.
  handler: async () => {
    // Honest stub (#432): no refund repository/integration. Create NO refund and
    // report it explicitly — never fake a created refund.
    return {
      executed: false,
      status: 'stub_not_executed' as const,
      message:
        'Criação de reembolso ainda não implementada (stub): nenhum reembolso foi criado.',
    };
  },
};
