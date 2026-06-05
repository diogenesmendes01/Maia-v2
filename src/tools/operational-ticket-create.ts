/**
 * Issue #416 — `operational_ticket_create` (boleto proposal vertical).
 *
 * Create a ticket for HUMAN analysis (reason, summary, conversation, company/
 * customer context, desired queue). This is the escalation sink of the
 * `risk_escalation_pack`.
 *
 * Side-effect classification (deliberate, taxonomy §3/§4/§6): this is modelled
 * as an INTERNAL escalation — analogous to the baseline `handoff_to_owner` — and
 * is NOT one of the three sensitive customer-facing WRITE tools the issue
 * governs with `confirm_before_write_policy` (`boleto_cancel`,
 * `company_campaign_remove`, `refund_create`). It does NOT move money, mutate a
 * customer/CRM record, or send an external proactive message. To keep
 * `confirm_before_write_policy` scoped to EXACTLY those three (acceptance
 * criterion) it is classified `side_effect: 'read'` here; visibility is still
 * fully gated by the explicit `risk_escalation_pack` grant + the dispatcher
 * guard (it can never be baseline). A future iteration may reclassify it and
 * attach a dedicated escalation policy — but that is out of scope for #416.
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
  required_actions: [],
  side_effect: 'read',
  redis_required: false,
  operation_type: 'create',
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
