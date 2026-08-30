/**
 * P10a — `propose_hint` tool.
 *
 * Routes through KnowledgeStateMachine.propose({ kind: 'behavioral_hint' }).
 * Used by reflection to register tone/style hints derived from sensitive
 * memory (e.g. "be patient with this user" without exposing why).
 */

import { z } from 'zod';
import type { Tool } from './_registry.js';
import { KnowledgeStateMachine } from '@/control-plane/knowledge-state-machine/index.js';
import {
  getCurrentTenant,
  getCurrentAgent,
} from '@/db/tenant-context.js';
import type {
  KnowledgeKind,
  KnowledgeScope,
} from '@/control-plane/knowledge-state-machine/types.js';

const inputSchema = z.object({
  hint_kind: z
    .enum(['behavioral_hint', 'procedure_hint'])
    .default('behavioral_hint'),
  scope_type: z.enum([
    'interlocutor',
    'role',
    'channel',
    'conversation',
    'agent',
    'tenant',
  ]),
  subject_id: z.string().optional(),
  hint_text: z.string().min(1).max(2000),
  derived_from_memory_id: z.string().uuid().optional(),
  derived_sensitivity: z.enum(['low', 'medium', 'high']).default('low'),
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

export const proposeHintTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'propose_hint',
  description:
    'Propõe um hint comportamental ou de procedimento. Harness decide via Knowledge State Machine. Hints derivados de memória sensível NÃO verbalizam o conteúdo original.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['read_balance'],
  side_effect: 'write',
  effect_class: 'non_interruptible',
  redis_required: false,
  operation_type: 'create',
  audit_action: 'fact_saved',
  handler: async (args, ctx) => {
    const kind: KnowledgeKind = args.hint_kind;
    const scope = mapScopeType(args.scope_type);
    const result = await KnowledgeStateMachine.propose({
      trace_id: ctx.request_id,
      tenant_id: getCurrentTenant(),
      agent_id: getCurrentAgent(),
      kind,
      scope,
      ...(args.subject_id !== undefined
        ? { scope_value: args.subject_id }
        : {}),
      key: args.hint_kind,
      content: {
        scope_type: args.scope_type,
        subject_id: args.subject_id ?? null,
        hint_text: args.hint_text,
        derived_from_memory_id: args.derived_from_memory_id ?? null,
        derived_sensitivity: args.derived_sensitivity,
      },
      content_text: args.hint_text,
      confidence: args.confianca,
      origin: 'llm_inference',
      source: 'tool:propose_hint',
      sensitivity_hint: args.derived_sensitivity,
      ...(args.ttl_days !== undefined ? { ttl_days: args.ttl_days } : {}),
      // Codex round-2 finding 2: persist native behavioral_hint columns
      // so scope_type matches what the prompt-builder lookup expects
      // (`interlocutor`/`role`/`channel`/`conversation`/`agent`/`tenant`)
      // rather than the generic KnowledgeScope literal.
      native: {
        hint_scope_type: args.scope_type,
        hint_subject_id: args.subject_id ?? null,
        hint_derived_sensitivity: args.derived_sensitivity,
        hint_derived_from_memory_id: args.derived_from_memory_id ?? null,
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
