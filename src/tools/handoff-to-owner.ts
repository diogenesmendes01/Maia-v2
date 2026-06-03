/**
 * Issue #410 — `handoff_to_owner` (baseline.core).
 *
 * INTERNAL escalation: the agent signals that the current situation should be
 * handed off to / reviewed by its OWNER. This is the baseline "escalate" verb.
 *
 * CRITICAL — this is NOT `send_proactive_message`:
 *   - It does NOT send an arbitrary external WhatsApp message to any recipient.
 *   - It produces a structured ESCALATION record (reason + urgency + summary)
 *     scoped to the agent's owner. Whether/how that becomes an actual owner
 *     notification is an owner-governed concern downstream — the baseline
 *     capability is only "raise the flag", never "message anyone you like".
 *   - side_effect: 'communication' (it is an internal hand-off signal), gated
 *     by the granular `escalate_to_owner` action key — deliberately distinct
 *     from `send_proactive_message` so the baseline can grant escalation
 *     WITHOUT granting external messaging.
 *
 * Invariant #4 (audit every decision): the dispatcher audits this call via
 * `owner_handoff_requested`, so every escalation leaves a trail.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';

const inputSchema = z.object({
  // Why the agent is escalating (plain language).
  reason: z.string().min(1).max(1000),
  // Short summary of the situation for the owner to triage quickly.
  summary: z.string().min(1).max(2000),
  urgency: z.enum(['low', 'normal', 'high']).default('normal'),
});

const outputSchema = z.object({
  // Confirms the escalation was raised (an internal signal), NOT that any
  // external message was sent.
  status: z.literal('handoff_requested'),
  reason: z.string(),
  urgency: z.enum(['low', 'normal', 'high']),
});

export const handoffToOwnerTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'handoff_to_owner',
  description:
    'Escala a conversa para o dono do agente (hand-off INTERNO). Não envia mensagem externa arbitrária — apenas sinaliza que o dono deve assumir/revisar.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['escalate_to_owner'],
  side_effect: 'communication',
  redis_required: false,
  operation_type: 'communicate',
  audit_action: 'owner_handoff_requested',
  handler: async (args) => {
    return {
      status: 'handoff_requested' as const,
      reason: args.reason,
      urgency: args.urgency,
    };
  },
};
