/**
 * Issue #433 — `conversation_state_update` (baseline.core).
 *
 * The agent's one lightweight, self-scoped state write: merge a small patch of
 * lightweight state into the CURRENT conversation (e.g. a topic tag, a language
 * preference for this thread, a lightweight workflow marker). Backed by
 * `conversasRepo.mergeMetadataNamespace(id, 'agent_state', patch)` — an atomic,
 * ALS-scoped, NAMESPACED jsonb deep-merge.
 *
 * Conservative + scope-safe by construction:
 *   - side_effect: 'write', operation_type: 'update_meta'. Because it is a
 *     baseline `write`, it is allowlisted in `BASELINE_WRITE_ALLOWLIST`
 *     (`src/tools/packs.ts`) alongside `remember_safe_fact`; `assertConservative`
 *     would otherwise throw at module load.
 *   - required_actions: [] (review fix, MÉDIO) — this is agent-INTERNAL
 *     bookkeeping over the agent's OWN ALS-scoped conversation (analogous to
 *     `read_turn_context`), NOT a human-authorizable domain write. It is gated
 *     by scope (ALS tenant_id+agent_id+conversa), not by a permission action
 *     key, so a baseline agent can record its own thread state without any grant
 *     (and without a one-off seed into every permission profile, which neither
 *     `save_safe_fact` nor `escalate_to_owner` got either).
 *   - Invariant #1 (tenant isolation / scope-escape): the conversation is ALWAYS
 *     `ctx.conversa.id`. An OPTIONAL `conversation_id` input is accepted ONLY to
 *     let a caller assert the target; if it DIVERGES from the ALS-scoped
 *     conversation the tool REJECTS the call (it never writes to an arbitrary
 *     conversation). `mergeMetadataNamespace` additionally pins tenant_id +
 *     agent_id from ALS, so even a forged id could not cross tenants.
 *   - NAMESPACED WRITE (review fix, MÉDIO): the patch is deep-merged under a
 *     single dedicated `agent_state` key, so the merge ONLY ever touches
 *     `metadata.agent_state.*` and can NEVER clobber a governed top-level
 *     metadata key (current OR future) — pending/clarification/confirmation gate
 *     state, the system-managed scope hash, the resolved sender identity, etc.
 *     This replaces the previous open denylist (a baseline write could otherwise
 *     stomp any not-yet-listed top-level key). Gate state still routes through
 *     `ask_pending_question` / the agent core, never this tool.
 *
 * Honest no-op (review fix, MÉDIO): `mergeMetadataNamespace` returns whether a
 * row actually matched. If the ALS-scoped conversation is stale/divergent and no
 * row matched, the tool returns `{ updated: false, updated_keys: [] }` with a
 * reason instead of reporting a fake success (which the dispatcher would
 * otherwise audit as a successful write).
 *
 * Invariant #3 (backend decides, LLM proposes): the LLM supplies only the patch
 * keys/values; the backend forces the scope and the namespace.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';
import { conversasRepo } from '@/db/repositories.js';

/**
 * The single reserved metadata namespace this tool writes under. Everything the
 * agent records lives at `metadata.agent_state.*`; the merge never touches any
 * other top-level key, so governed paths (pending_question, last_scope_hash,
 * telefone, …) are structurally out of reach.
 */
const AGENT_STATE_NAMESPACE = 'agent_state';

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
  // The lightweight state to merge into the current conversation's
  // `metadata.agent_state`. 1–20 keys. No reserved-key denylist is needed: the
  // write is namespaced, so these keys live under `agent_state` and cannot
  // collide with governed top-level metadata.
  patch: z.record(z.string().min(1).max(120), stateValueSchema),
  // Optional assertion of the target conversation. When present it MUST equal
  // the ALS-scoped conversation (`ctx.conversa.id`); a divergent id is rejected.
  conversation_id: z.string().optional(),
});

const outputSchema = z.object({
  conversa_id: z.string(),
  // Whether a conversation row actually matched and was updated. `false` means
  // the ALS-scoped conversation was stale/divergent — NOT a successful write.
  updated: z.boolean(),
  // The agent_state keys written when `updated` is true; empty when it is false.
  updated_keys: z.array(z.string()),
  // Present only on a no-op, explaining why nothing was written.
  reason: z.string().optional(),
});

export const conversationStateUpdateTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'conversation_state_update',
  description:
    'Atualiza um estado LEVE da conversa atual (ex.: tag de tópico, preferência do thread), fazendo merge atômico sob metadata.agent_state. Bookkeeping interno do agente, sempre escopado à própria conversa; estado de pendência/confirmação NÃO passa por aqui (use ask_pending_question). Retorna updated=false se a conversa não existir mais.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: [],
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

    // Atomic, ALS-scoped, NAMESPACED jsonb merge — only ever touches
    // `metadata.agent_state.*`, preserving every other (governed) top-level key.
    const updated = await conversasRepo.mergeMetadataNamespace(
      ctx.conversa.id,
      AGENT_STATE_NAMESPACE,
      args.patch,
    );

    if (!updated) {
      // Honest no-op: no row matched (stale/divergent conversation). Do NOT
      // report a successful write — the dispatcher audits the tool's result.
      return {
        conversa_id: ctx.conversa.id,
        updated: false,
        updated_keys: [],
        reason: 'conversation_not_found: no matching conversation for the current scope',
      };
    }

    return { conversa_id: ctx.conversa.id, updated: true, updated_keys: keys };
  },
};
