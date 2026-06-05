/**
 * Issue #416 — `legal_intent_detect` (boleto proposal vertical).
 *
 * Detect legal threats, formal legal requests, or legal-department requests in
 * the customer message + recent context. Pure analysis.
 *
 * Conservative: side_effect 'none'. Its OUTPUT feeds the risk/escalation
 * policies (`human_confirmation_policy`, `confirm_before_write_policy`'s "block
 * when risk says escalate") — but this tool only REPORTS a signal; whether a
 * write is blocked/escalated is a POLICY decision composed at the dispatcher,
 * never an `if` here (taxonomy §3/§6). Out of scope (#416): an LLM classifier —
 * contract-honouring stub.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';

const inputSchema = z.object({
  customer_message: z.string().max(8000),
  conversation_context: z.string().max(8000).optional(),
});

const outputSchema = z.object({
  has_legal_intent: z.boolean(),
  reasons: z.array(z.string()).default([]),
  signals: z.array(z.string()).default([]),
});

export const legalIntentDetectTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'legal_intent_detect',
  description:
    'Detecta ameaças jurídicas, pedidos legais formais ou solicitações do departamento jurídico na mensagem e no contexto. Apenas análise — reporta o sinal; bloqueio/escalação é decisão de policy.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: [],
  side_effect: 'none',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'legal_intent_detected',
  handler: async () => {
    // Stub: no live classifier in #416. Conservative default: no legal intent
    // asserted (the agent should not fabricate a legal flag).
    return { has_legal_intent: false, reasons: [], signals: [] };
  },
};
