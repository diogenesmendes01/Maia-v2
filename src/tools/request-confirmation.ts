/**
 * Issue #410 — `request_confirmation` (baseline.core).
 *
 * Lets the agent ASK the human to confirm something before it would act. It is
 * a pure speech act: it NEVER performs the action being confirmed — it only
 * surfaces a confirmation prompt back to the turn. This is the embodiment of
 * invariant #2 (LLM proposes, backend disposes): the model proposes "should I
 * do X?"; the actual disposition happens later, gated by a real grant/policy.
 *
 * Conservative by construction:
 *   - side_effect: 'none' (it asks, it does not act — no external send, no
 *     mutation; the reply text is delivered through the normal turn output).
 *   - required_actions: [] → universal baseline capability.
 *   - The returned `prompt` is the question the agent wants confirmed plus the
 *     summarised action; the dispatcher/agent loop renders it to the user. No
 *     pending-question row is created here (that is a domain workflow concern);
 *     this is the minimal, side-effect-free "ask to confirm" primitive.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';

const inputSchema = z.object({
  // A one-line, plain-language summary of the action the agent wants to take.
  action_summary: z.string().min(1).max(500),
  // The explicit yes/no (or choice) question to put to the user.
  question: z.string().min(1).max(500),
});

const outputSchema = z.object({
  // Echoed back so the agent loop can render the confirmation prompt. The tool
  // does NOT decide the outcome — it returns `awaiting_confirmation` to make it
  // explicit that nothing has happened yet.
  status: z.literal('awaiting_confirmation'),
  prompt: z.string(),
});

export const requestConfirmationTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'request_confirmation',
  description:
    'Pede confirmação ao interlocutor antes de uma ação. Apenas pergunta — não executa nada. Use quando precisar de um "sim" explícito antes de agir.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: [],
  side_effect: 'none',
  effect_class: 'abort_safe',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'confirmation_requested',
  handler: async (args) => {
    const prompt = `${args.action_summary}\n\n${args.question}`;
    return { status: 'awaiting_confirmation' as const, prompt };
  },
};
