/**
 * Issue #416 — `case_risk_classify` (boleto proposal vertical).
 *
 * Classify the operational risk level of a case (low/medium/high) from the
 * customer message, history, company context, and any payment/refund/document
 * context. Returns reasons and a RECOMMENDED policy action.
 *
 * Conservative: side_effect 'none'. Critically, the `recommended_policy_action`
 * is a RECOMMENDATION the risk/write policies consume — this tool does NOT
 * itself block or escalate execution. The actual block/escalate/confirm decision
 * is owned by `confirm_before_write_policy` / `human_confirmation_policy`
 * (migration 078) composed at the dispatcher (taxonomy §3/§6). Out of scope
 * (#416): an LLM risk model — contract-honouring stub.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';

const inputSchema = z.object({
  customer_message: z.string().max(8000).optional(),
  history: z.string().max(8000).optional(),
  company_context: z.string().max(4000).optional(),
  payment_context: z.string().max(4000).optional(),
  refund_context: z.string().max(4000).optional(),
  document_context: z.string().max(4000).optional(),
});

const outputSchema = z.object({
  risk_level: z.enum(['low', 'medium', 'high']),
  reasons: z.array(z.string()).default([]),
  recommended_policy_action: z.enum(['allow', 'confirm', 'escalate', 'block']),
});

export const caseRiskClassifyTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'case_risk_classify',
  description:
    'Classifica o nível de risco operacional do caso (baixo/médio/alto) a partir da mensagem, histórico e contexto da empresa/pagamento/reembolso/documento. Retorna motivos e ação de policy recomendada. Apenas análise — não bloqueia nem escala por si.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: [],
  side_effect: 'none',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'case_risk_classified',
  handler: async () => {
    // Stub: no live risk model in #416. Conservative default: low risk, allow —
    // the governing policies remain the authority for any write.
    return { risk_level: 'low' as const, reasons: [], recommended_policy_action: 'allow' as const };
  },
};
