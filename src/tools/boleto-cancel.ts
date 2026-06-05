/**
 * Issue #432 — `boleto_cancel` (boleto proposal domain WRITE stub).
 *
 * Requests operational cancellation/baixa of a boleto.
 *
 * STUB. There is NO boleto provider integration, so this performs NO real
 * cancellation: it returns `executed: false`, `status: 'stub_not_executed'`
 * and NO fake `operation_protocol`. It declares `side_effect: 'write'` +
 * `operation_type: 'cancel'` so the dispatcher computes the idempotency key
 * itself (the tool does not originate one) and auto-audits from `audit_action`.
 *
 * Governance fields (`reason`, `actor_context?`, `confirmation_id?`,
 * `dual_approval_granted?`) are ACCEPTED but NOT enforced here — the real
 * confirmation gate (`ask_pending_question`) and dual-approval
 * (`src/governance/dual-approval.ts`) are the #416 policy slice. NO
 * `extractEffect` (that hook is only for real non-idempotent external effects;
 * none exist at stub stage).
 *
 * side_effect: 'write', operation_type: 'cancel'.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';

const inputSchema = z
  .object({
    boleto_id: z.string().min(1).max(120),
    company_id: z.string().max(120).optional(),
    cnpj: z.string().max(40).optional(),
    reason: z.string().min(1).max(2000),
    // Accepted but not enforced (governance is #416's policy slice).
    actor_context: z.unknown().optional(),
    confirmation_id: z.string().max(200).optional(),
    dual_approval_granted: z.boolean().optional(),
  })
  .strip();

const outputSchema = z.object({
  executed: z.boolean(),
  status: z.enum([
    'stub_not_executed',
    'cancelled',
    'blocked',
    'requires_confirmation',
    'failed',
  ]),
  operation_protocol: z.string().optional(),
  resulting_status: z.string().optional(),
  message: z.string().optional(),
});

export const boletoCancelTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'boleto_cancel',
  description:
    'Solicita o cancelamento/baixa operacional de um boleto. STUB: ainda não há integração com o provedor de boletos — NÃO executa cancelamento, retorna executed=false, status=stub_not_executed (sem protocolo falso). Write governado por política (#416).',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['cancel_boleto'],
  side_effect: 'write',
  redis_required: false,
  operation_type: 'cancel',
  audit_action: 'boleto_cancel_requested',
  handler: async () => ({
    executed: false,
    status: 'stub_not_executed' as const,
    message: 'Cancelamento de boleto ainda não implementado (stub): nenhuma ação foi executada.',
  }),
};
