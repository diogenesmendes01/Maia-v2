/**
 * Issue #432 — `operational_ticket_create` (boleto proposal domain WRITE stub).
 *
 * Creates a ticket for human analysis (operational queue).
 *
 * STUB. There is NO ticketing backend, so this creates NO ticket: it returns
 * `created: false`, `status: 'stub_not_created'` and NO fake `ticket_number`.
 * Declares `side_effect: 'write'` + `operation_type: 'create'` so the
 * dispatcher computes the idempotency key and auto-audits from `audit_action`
 * — i.e. this stub is "audited and idempotent even as a stub" (a #432 AC).
 *
 * `conversation_id` is accepted but NOT trusted: the ticket is pinned to the
 * ALS-scoped `ctx.conversa.id` (invariant #1). A divergent id is ignored and
 * surfaced in `message`, never used to attach the ticket to another
 * conversation. NO `extractEffect` (no real external effect at stub stage).
 *
 * side_effect: 'write', operation_type: 'create'.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';

const inputSchema = z
  .object({
    reason: z.string().min(1).max(2000),
    summary: z.string().min(1).max(4000),
    // Accepted but NOT trusted as a free identifier — pinned to ctx.conversa.id.
    conversation_id: z.string().max(120).optional(),
    company_context: z.unknown().optional(),
    customer_context: z.unknown().optional(),
    desired_queue: z.string().max(120).optional(),
    actor_context: z.unknown().optional(),
  })
  .strip();

const outputSchema = z.object({
  created: z.boolean(),
  ticket_number: z.string().optional(),
  responsible_queue: z.string().optional(),
  status: z.enum(['stub_not_created', 'created', 'failed']),
  message: z.string().optional(),
});

export const operationalTicketCreateTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'operational_ticket_create',
  description:
    'Cria um chamado para análise humana (fila operacional). STUB: ainda não há backend de tickets — NÃO cria chamado, retorna created=false, status=stub_not_created (sem número falso). Auditado e idempotente mesmo como stub.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['create_ticket'],
  side_effect: 'write',
  redis_required: false,
  operation_type: 'create',
  audit_action: 'operational_ticket_create_requested',
  handler: async (args, ctx) => {
    // Invariant #1: never trust a divergent conversation_id. The real ticket
    // (once a backend exists) would attach to the ALS-scoped conversation.
    const divergentConversation =
      args.conversation_id !== undefined && args.conversation_id !== ctx.conversa.id;
    return {
      created: false,
      status: 'stub_not_created' as const,
      message: divergentConversation
        ? 'Criação de chamado ainda não implementada (stub): nenhum chamado foi criado. conversation_id divergente ignorado — escopo fixado na conversa atual.'
        : 'Criação de chamado ainda não implementada (stub): nenhum chamado foi criado.',
    };
  },
};
