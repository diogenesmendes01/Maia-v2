/**
 * Issue #416/#432 — `boleto_cancel` (boleto proposal vertical, WRITE).
 *
 * Requests the operational cancellation / baixa of a boleto. This is one of the
 * THREE sensitive write tools of the vertical (with `company_campaign_remove`
 * and `refund_create`). Per the capability taxonomy (§3, §6) and the issue:
 *
 *   - side_effect: 'write' — so it can NEVER be a baseline tool and ALWAYS flows
 *     through the dispatcher guard + `constitutionalCheck` (invariant #2/#5).
 *   - It declares INTENT + side-effect only. It does NOT decide confirmation —
 *     `confirm_before_write_policy` (migration 078) + the dispatcher decide
 *     whether the write executes. There is deliberately NO `if (needsConfirm)`
 *     branch here (anti-pattern §7).
 *   - required_actions: ['cancel_boleto'] — a granular permission key the
 *     dispatcher's `canAct` enforces (distinct from finance keys, so the
 *     boleto-proposta role is authorised for boleto baixa WITHOUT generic
 *     financial grants).
 *   - The dispatcher audits the decision (`boleto_cancelled`) after execution
 *     (invariant #4); we do NOT open a parallel write path.
 *
 * HONEST STUB (issue #432): there is NO boleto-provider integration, so the
 * handler performs NO real cancellation. It returns `executed: false`,
 * `status: 'stub_not_executed'` and NO fabricated `operation_protocol` /
 * `resulting_status` — it must NEVER fake a successful baixa (invariant #2:
 * fail-closed, the stub never claims a business effect it did not produce).
 * Because it keeps `side_effect: 'write'` + `operation_type: 'cancel'`, the
 * dispatcher still computes the idempotency key and auto-audits — audited and
 * idempotent even as a stub.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';

const inputSchema = z.object({
  // Required so the dispatcher routes the profile-permission check to the entity
  // that owns the boleto (mirrors cancel_transaction's entidade_id discipline).
  entidade_id: z.string().uuid(),
  // .trim() so a blank boleto_id / target cannot pass as a real value.
  boleto_id: z.string().trim().min(1).max(64),
  cnpj: z.string().trim().min(1).max(20).optional(),
  company_id: z.string().trim().min(1).max(64).optional(),
  reason: z.string().trim().min(1).max(500),
  // Fase 0 cap. 3: `dual_approval_granted` foi REMOVIDO do schema — o LLM não
  // atesta aprovação. A evidência humana vem do store backend
  // (approval_requests), resolvida pelo dispatcher antes de executar.
});

const outputSchema = z.object({
  // `executed` is the honesty flag: a stub NEVER reports a real effect.
  executed: z.boolean(),
  status: z.enum([
    'stub_not_executed',
    'cancelled',
    'blocked',
    'requires_confirmation',
    'failed',
  ]),
  // Present ONLY when a real provider executed the baixa — the stub never sets
  // these (no fabricated protocol / status).
  operation_protocol: z.string().optional(),
  resulting_status: z.string().optional(),
  message: z.string().optional(),
});

export const boletoCancelTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'boleto_cancel',
  description:
    'Solicita a baixa/cancelamento operacional de um boleto. Operação de ESCRITA (confirmação decidida por policy + dispatcher, nunca pelo tool). STUB (#432): ainda não há integração com o provedor — NÃO executa cancelamento, retorna executed=false, status=stub_not_executed (sem protocolo falso).',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['cancel_boleto'],
  side_effect: 'write',
  redis_required: false,
  operation_type: 'cancel',
  audit_action: 'boleto_cancelled',
  // No `extractAlvoId`: the stub creates/cancels no resource, so there is no
  // real alvo_id to surface (a fabricated one would be dishonest). A provider
  // integration can map the real protocol here later.
  handler: async () => {
    // Honest stub (#432): no boleto-provider integration. Perform NO baixa and
    // report it explicitly — never fake a successful cancellation.
    return {
      executed: false,
      status: 'stub_not_executed' as const,
      message:
        'Cancelamento de boleto ainda não implementado (stub): nenhuma ação foi executada.',
    };
  },
};
