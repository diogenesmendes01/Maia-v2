/**
 * P10a — `propose_fact` tool.
 *
 * Proposes an operational fact via KnowledgeStateMachine.propose().
 * The harness decides initial status (ephemeral / pending_review) —
 * the LLM never picks. See master §6.2.
 */

import { z } from 'zod';
import type { Tool } from './_registry.js';
import { KnowledgeStateMachine } from '@/control-plane/knowledge-state-machine/index.js';
import {
  getCurrentTenant,
  getCurrentAgent,
} from '@/db/tenant-context.js';
import type {
  KnowledgeOrigin,
  KnowledgeScope,
} from '@/control-plane/knowledge-state-machine/types.js';

const inputSchema = z.object({
  escopo: z
    .string()
    .regex(/^(global|tenant|pessoa:[0-9a-f-]+|entidade:[0-9a-f-]+)$/),
  chave: z.string().min(1).max(120),
  valor: z.unknown(),
  texto: z.string().min(1).max(2000),
  fonte: z
    .enum(['configurado', 'aprendido', 'inferido'])
    .default('aprendido'),
  confianca: z.number().min(0).max(1).default(0.6),
  sensibilidade: z.enum(['low', 'medium', 'high']).optional(),
});

// Codex round-2 finding 3: proposal_id must be a non-empty
// UUID-shaped string. Callers (audit, idempotency cache, Admin UI)
// rely on this being a real DB id; an empty string is never valid.
const PROPOSAL_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const outputSchema = z.object({
  proposal_id: z.string().regex(PROPOSAL_ID_REGEX, 'proposal_id must be a UUID'),
  initial_status: z.enum(['ephemeral', 'pending_review']),
  visible_to_llm: z.boolean(),
  reason: z.string(),
});

function mapEscopoToScope(escopo: string): {
  scope: KnowledgeScope;
  scope_value?: string;
} {
  if (escopo === 'global') return { scope: 'global' };
  if (escopo === 'tenant') return { scope: 'tenant' };
  if (escopo.startsWith('pessoa:'))
    return { scope: 'user', scope_value: escopo.slice('pessoa:'.length) };
  if (escopo.startsWith('entidade:'))
    return { scope: 'agent', scope_value: escopo.slice('entidade:'.length) };
  return { scope: 'agent' };
}

function fonteToOrigin(
  fonte: 'configurado' | 'aprendido' | 'inferido',
): KnowledgeOrigin {
  if (fonte === 'configurado') return 'human_approved';
  if (fonte === 'inferido') return 'tool_callback';
  return 'llm_inference';
}

export const proposeFactTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'propose_fact',
  description:
    'Propõe um fato operacional. O harness (Knowledge State Machine) decide se nasce ephemeral (visível ao LLM) ou pending_review (humano decide). NUNCA cria diretamente como active.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['read_balance'],
  side_effect: 'write',
  effect_class: 'non_interruptible',
  redis_required: false,
  operation_type: 'create',
  audit_action: 'fact_saved',
  handler: async (args, ctx) => {
    // Escopo enforcement — keep parity with legacy save_fact.
    if (args.escopo.startsWith('entidade:')) {
      const eid = args.escopo.split(':')[1] ?? '';
      if (!ctx.scope.entidades.includes(eid)) {
        throw new Error('escopo_outside_scope');
      }
    }
    if (args.escopo.startsWith('pessoa:')) {
      const pid = args.escopo.split(':')[1] ?? '';
      if (pid !== ctx.pessoa.id) {
        throw new Error('escopo_outside_scope');
      }
    }

    const { scope, scope_value } = mapEscopoToScope(args.escopo);
    const result = await KnowledgeStateMachine.propose({
      trace_id: ctx.request_id,
      tenant_id: getCurrentTenant(),
      agent_id: getCurrentAgent(),
      kind: 'fact',
      scope,
      ...(scope_value !== undefined ? { scope_value } : {}),
      key: args.chave,
      content: args.valor,
      content_text: args.texto,
      confidence: args.confianca,
      origin: fonteToOrigin(args.fonte),
      source: 'tool:propose_fact',
      ...(args.sensibilidade !== undefined
        ? { sensitivity_hint: args.sensibilidade }
        : {}),
      // Codex round-2 finding 2: persist the legacy escopo/chave verbatim
      // so factsRepo.listForScopes / listMentionableForScopes (which look
      // for `pessoa:<id>` / `entidade:<id>`) can find the row after a
      // human approves it.
      native: {
        fact_escopo: args.escopo,
        fact_chave: args.chave,
      },
    });

    // Output shape narrows to {ephemeral, pending_review} — the only two
    // initial states propose() can return. If somehow a wider value comes
    // through (e.g. fallback short-circuit), normalise to pending_review.
    const initial_status =
      result.initial_status === 'ephemeral' ? 'ephemeral' : 'pending_review';

    return {
      proposal_id: result.proposal_id,
      initial_status,
      visible_to_llm: result.visible_to_llm,
      reason: result.reason,
    };
  },
};
