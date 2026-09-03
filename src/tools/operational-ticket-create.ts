/**
 * Issue #416/#432 — `operational_ticket_create` (boleto proposal vertical).
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
 * HONEST STUB (issue #432): there is NO ticketing backend, so the handler creates
 * NO ticket. It returns `created: false`, `status: 'stub_not_created'` and NO
 * fabricated `ticket_number` / `responsible_queue` — it must NEVER fake a created
 * ticket (invariant #2: fail-closed). The classification above is unchanged: it
 * stays `side_effect: 'communication'` + `operation_type: 'communicate'` and the
 * dispatcher auto-audits (`operational_ticket_created`).
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
  // `created` is the honesty flag: a stub NEVER reports a real ticket.
  created: z.boolean(),
  // Set ONLY when a real backend opened the ticket — the stub fabricates neither.
  ticket_number: z.string().optional(),
  responsible_queue: z.string().optional(),
  status: z.enum(['stub_not_created', 'created', 'failed']),
  message: z.string().optional(),
});

export const operationalTicketCreateTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'operational_ticket_create',
  description:
    'Abre um chamado para análise humana (escalação interna — não move dinheiro nem altera cadastro/CRM nem envia mensagem externa). STUB (#432): ainda não há backend de tickets — NÃO cria chamado, retorna created=false, status=stub_not_created (sem número falso). Auditado e idempotente mesmo como stub.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['create_ticket'],
  side_effect: 'communication',
  effect_class: 'non_interruptible',
  redis_required: false,
  operation_type: 'communicate',
  audit_action: 'operational_ticket_created',
  handler: async () => {
    // Honest stub (#432): no ticketing backend. Create NO ticket and report it
    // explicitly — never fabricate a ticket number.
    return {
      created: false,
      status: 'stub_not_created' as const,
      message:
        'Criação de chamado ainda não implementada (stub): nenhum chamado foi criado.',
    };
  },
};
