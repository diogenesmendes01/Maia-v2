/**
 * P10a — `propose_memory` tool.
 *
 * Routes through KnowledgeStateMachine.propose({ kind: 'memory' }).
 * Schema mirrors the legacy memory_entry shape — sensitivity, scope,
 * subject_id, ttl_days, etc.
 */

import { z } from 'zod';
import type { Tool } from './_registry.js';
import { KnowledgeStateMachine } from '@/control-plane/knowledge-state-machine/index.js';
import {
  getCurrentTenant,
  getCurrentAgent,
} from '@/db/tenant-context.js';
import type { KnowledgeScope } from '@/control-plane/knowledge-state-machine/types.js';

const inputSchema = z.object({
  memory_type: z.enum(['operational', 'preference', 'personal', 'sensitive']),
  scope_type: z.enum([
    'interlocutor',
    'role',
    'channel',
    'conversation',
    'agent',
    'tenant',
  ]),
  subject_id: z.string().optional(),
  conteudo: z.string().min(1).max(2000),
  sensibilidade: z.enum(['low', 'medium', 'high']).default('low'),
  ttl_days: z.number().int().positive().optional(),
  confianca: z.number().min(0).max(1).default(0.6),
});

// Codex round-2 finding 3: proposal_id must be a non-empty UUID string.
const PROPOSAL_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const outputSchema = z.object({
  proposal_id: z.string().regex(PROPOSAL_ID_REGEX, 'proposal_id must be a UUID'),
  initial_status: z.enum(['ephemeral', 'pending_review']),
  visible_to_llm: z.boolean(),
  reason: z.string(),
});

function mapScopeType(scope_type: string): KnowledgeScope {
  switch (scope_type) {
    case 'interlocutor':
      return 'user';
    case 'role':
    case 'channel':
    case 'agent':
      return 'agent';
    case 'conversation':
      return 'session';
    case 'tenant':
      return 'tenant';
    default:
      return 'agent';
  }
}

export const proposeMemoryTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'propose_memory',
  description:
    'Propõe uma memória episódica/comportamental. Harness decide visibilidade via Knowledge State Machine. Memória sensible automaticamente cai em pending_review.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['read_balance'],
  side_effect: 'write',
  effect_class: 'non_interruptible',
  redis_required: false,
  operation_type: 'create',
  audit_action: 'fact_saved',
  handler: async (args, ctx) => {
    const scope = mapScopeType(args.scope_type);
    const result = await KnowledgeStateMachine.propose({
      trace_id: ctx.request_id,
      tenant_id: getCurrentTenant(),
      agent_id: getCurrentAgent(),
      kind: 'memory',
      scope,
      ...(args.subject_id !== undefined
        ? { scope_value: args.subject_id }
        : {}),
      key: args.memory_type,
      content: {
        memory_type: args.memory_type,
        scope_type: args.scope_type,
        subject_id: args.subject_id ?? null,
        conteudo: args.conteudo,
      },
      content_text: args.conteudo,
      confidence: args.confianca,
      origin: 'llm_inference',
      source: 'tool:propose_memory',
      // memory_type='sensitive' lifts the sensitivity hint regardless
      // of the caller-provided one — preserves the §2.6 invariant.
      sensitivity_hint:
        args.memory_type === 'sensitive' ? 'high' : args.sensibilidade,
      ...(args.ttl_days !== undefined ? { ttl_days: args.ttl_days } : {}),
      // Codex round-2 finding 2: persist native memory_entry columns so
      // findRelevant (which matches scope_type ∈
      // {interlocutor,role,channel,conversation,agent} + subject_id)
      // can find the row.
      native: {
        memory_type: args.memory_type,
        memory_scope_type: args.scope_type,
        memory_subject_id: args.subject_id ?? null,
        memory_interlocutor_id:
          args.scope_type === 'interlocutor' ? args.subject_id ?? null : null,
        memory_conversa_id:
          args.scope_type === 'conversation' ? args.subject_id ?? null : null,
        memory_sensitivity:
          args.memory_type === 'sensitive' ? 'high' : args.sensibilidade,
        memory_proactive_use: false,
        memory_mention_allowed: false,
      },
    });

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
