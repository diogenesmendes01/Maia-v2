/**
 * Issue #416 — `operational_ticket_create` (boleto proposal vertical).
 *
 * Create a ticket for HUMAN analysis (reason, summary, conversation, company/
 * customer context, desired queue). This is the escalation sink of the
 * `risk_escalation_pack`.
 *
 * Side-effect classification (taxonomy §3/§4/§6): this is an INTERNAL escalation
 * sink — directly analogous to the baseline `handoff_to_owner` — so it is a
 * `side_effect: 'communication'` with `operation_type: 'communicate'` and a
 * granular `create_ticket` permission. Classifying it as 'read' would be wrong
 * (it persists a ticket / hands off to a human queue); classifying it as 'write'
 * would wrongly make it a 4th governed CUSTOMER write. 'communication' is the
 * honest, gated classification: it can never be baseline and is gated by the
 * explicit `risk_escalation_pack` grant + the dispatcher guard (canAct on
 * `create_ticket`). It is deliberately NOT one of the three customer-facing
 * writes governed by `confirm_before_write_policy` (`boleto_cancel`,
 * `company_campaign_remove`, `refund_create`) — an internal escalation ticket
 * must not require end-user confirmation.
 *
 * Out of scope (#416): a real ticketing integration — contract-honouring stub.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';

const inputSchema = z.object({
  reason: z.string().min(1).max(500),
  summary: z.string().min(1).max(2000),
  conversation: z.string().max(20000).optional(),
  company_context: z.string().max(4000).optional(),
  customer_context: z.string().max(4000).optional(),
  desired_queue: z.string().max(120).optional(),
});

const outputSchema = z.object({
  ticket_created: z.boolean(),
  ticket_number: z.string().optional(),
  responsible_queue: z.string().optional(),
});

export const operationalTicketCreateTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'operational_ticket_create',
  description:
    'Cria um ticket para análise humana (motivo, resumo, conversa, contexto de empresa/cliente e fila desejada). Escalação interna — não move dinheiro nem altera cadastro/CRM nem envia mensagem externa.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['create_ticket'],
  side_effect: 'communication',
  redis_required: false,
  operation_type: 'communicate',
  audit_action: 'operational_ticket_created',
  handler: async (args) => {
    // Stub: no live ticketing integration in #416.
    return {
      ticket_created: true,
      ticket_number: `stub-ticket-${Date.now()}`,
      responsible_queue: args.desired_queue ?? 'default',
    };
  },
};
