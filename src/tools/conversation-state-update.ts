/**
 * Issue #433 — `conversation_state_update` (baseline.core).
 *
 * The agent's one lightweight, self-scoped state write: merge a small patch of
 * NON-GATE metadata into the CURRENT conversation (e.g. a topic tag, a language
 * preference for this thread, a lightweight workflow marker). Backed by
 * `conversasRepo.mergeMetadata(id, patch)` — an atomic, ALS-scoped jsonb merge.
 *
 * Conservative + scope-safe by construction:
 *   - side_effect: 'write', operation_type: 'update_meta'. Because it is a
 *     baseline `write`, it is allowlisted in `BASELINE_WRITE_ALLOWLIST`
 *     (`src/tools/packs.ts`) alongside `remember_safe_fact`; `assertConservative`
 *     would otherwise throw at module load.
 *   - required_actions: ['update_conversation_state'] — a NEW granular action key
 *     (NOT a financial/domain write), so a baseline agent may update its own
 *     conversation state WITHOUT any domain-mutation grant.
 *   - Invariant #1 (tenant isolation / scope-escape): the conversation is ALWAYS
 *     `ctx.conversa.id`. An OPTIONAL `conversation_id` input is accepted ONLY to
 *     let a caller assert the target; if it DIVERGES from the ALS-scoped
 *     conversation the tool REJECTS the call (it never writes to an arbitrary
 *     conversation). `mergeMetadata` additionally pins tenant_id + agent_id from
 *     ALS, so even a forged id could not cross tenants.
 *   - GATE STATE STAYS OUT: pending/clarification/confirmation state and the
 *     system-managed scope hash must route through `ask_pending_question` / the
 *     agent core, NOT arbitrary metadata. Reserved keys are rejected.
 *
 * Invariant #3 (backend decides, LLM proposes): the LLM supplies only the patch
 * keys/values; the backend forces the scope and refuses reserved/oversized
 * patches.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';
import { conversasRepo } from '@/db/repositories.js';

/**
 * Metadata keys this tool must NEVER let the LLM write — they are managed by
 * dedicated, governed paths:
 *   - `pending_question` / `clarification` / `confirmation`: the persisted gate
 *     state (route through `ask_pending_question`).
 *   - `last_scope_hash` / `last_scope_hash_set_at`: the agent core's post-turn
 *     scope-change tracking (`src/agent/core.ts`).
 *   - `telefone`: the conversation's resolved sender identity (gateway-managed).
 */
const RESERVED_METADATA_KEYS: ReadonlySet<string> = new Set([
  'pending_question',
  'clarification',
  'confirmation',
  'last_scope_hash',
  'last_scope_hash_set_at',
  'telefone',
]);

// A single state value: a JSON scalar or a flat array of scalars. Deliberately
// NOT an arbitrary nested object — baseline state is lightweight, and a shallow
// shape keeps the jsonb merge predictable and bounds the payload.
const stateValueSchema = z.union([
  z.string().max(1000),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string().max(1000), z.number(), z.boolean()])).max(50),
]);

const inputSchema = z.object({
  // The lightweight, non-gate state to merge into the current conversation's
  // metadata. 1–20 keys; reserved keys are rejected by the handler.
  patch: z.record(z.string().min(1).max(120), stateValueSchema),
  // Optional assertion of the target conversation. When present it MUST equal
  // the ALS-scoped conversation (`ctx.conversa.id`); a divergent id is rejected.
  conversation_id: z.string().optional(),
});

const outputSchema = z.object({
  conversa_id: z.string(),
  updated_keys: z.array(z.string()),
});

export const conversationStateUpdateTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'conversation_state_update',
  description:
    'Atualiza um estado LEVE e não-gate da conversa atual (ex.: tag de tópico, preferência do thread), fazendo merge atômico no metadata. Sempre escopado à própria conversa; estado de pendência/confirmação NÃO passa por aqui (use ask_pending_question).',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['update_conversation_state'],
  side_effect: 'write',
  redis_required: false,
  operation_type: 'update_meta',
  audit_action: 'conversation_state_updated',
  handler: async (args, ctx) => {
    // Scope-escape guard (invariant #1): if the caller named a conversation, it
    // MUST be the ALS-scoped one. Never write to an arbitrary conversation.
    if (args.conversation_id !== undefined && args.conversation_id !== ctx.conversa.id) {
      throw new Error(
        'conversation_state_update_scope_violation: conversation_id must match the current conversation',
      );
    }

    const keys = Object.keys(args.patch);
    if (keys.length === 0) {
      throw new Error('conversation_state_update_empty_patch: patch must contain at least one key');
    }
    if (keys.length > 20) {
      throw new Error('conversation_state_update_too_many_keys: at most 20 keys per patch');
    }
    const reserved = keys.filter((k) => RESERVED_METADATA_KEYS.has(k));
    if (reserved.length > 0) {
      throw new Error(
        `conversation_state_update_reserved_key: [${reserved.join(', ')}] are managed by governed paths (e.g. ask_pending_question), not this tool`,
      );
    }

    // Atomic, ALS-scoped jsonb merge — preserves concurrent keys.
    await conversasRepo.mergeMetadata(ctx.conversa.id, args.patch);

    return { conversa_id: ctx.conversa.id, updated_keys: keys };
  },
};
