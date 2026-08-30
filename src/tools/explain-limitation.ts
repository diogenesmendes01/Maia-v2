/**
 * Issue #410 — `explain_limitation` (baseline.core).
 *
 * Lets the agent tell the user, honestly, that it CANNOT do something (yet) and
 * why — instead of hallucinating an action it has no grant for. This is the
 * baseline "graceful no" primitive: when an agent lacks a domain pack (e.g. no
 * financial grant), it should explain the limitation rather than pretend.
 *
 * Conservative by construction:
 *   - side_effect: 'none' — pure speech act; the explanation is delivered
 *     through the normal turn output.
 *   - required_actions: [] → universal baseline capability.
 *   - Returns a structured explanation the agent loop renders. Optionally
 *     suggests the next step (e.g. "ask the owner to enable this"), but it
 *     performs NO escalation itself (that is `handoff_to_owner`).
 *
 * Why baseline: it directly supports the contract's fail-closed posture — an
 * agent without a capability must be able to say so safely.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';

const inputSchema = z.object({
  // What the user asked for that the agent cannot fulfil.
  requested: z.string().min(1).max(500),
  // Why it cannot (plain language; no internal/secret detail).
  reason: z.string().min(1).max(1000),
  // Optional, non-acting suggestion for how the user might proceed.
  suggestion: z.string().max(1000).optional(),
});

const outputSchema = z.object({
  status: z.literal('limitation_explained'),
  message: z.string(),
});

export const explainLimitationTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'explain_limitation',
  description:
    'Explica de forma honesta que o agente não pode realizar algo (e por quê), em vez de inventar uma ação sem permissão. Apenas texto, sem efeito colateral.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: [],
  side_effect: 'none',
  effect_class: 'abort_safe',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'limitation_explained',
  handler: async (args) => {
    const parts = [
      `Não consigo ${args.requested}.`,
      args.reason,
    ];
    if (args.suggestion) parts.push(args.suggestion);
    return {
      status: 'limitation_explained' as const,
      message: parts.join(' '),
    };
  },
};
