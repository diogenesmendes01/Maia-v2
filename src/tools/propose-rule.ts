/**
 * P10a — `propose_rule` tool.
 *
 * Routes through KnowledgeStateMachine.propose({ kind: 'rule' }).
 * Master §2.6 invariant: rules ALWAYS land in pending_review regardless
 * of confidence/risk — the output type reflects this.
 */

import { z } from 'zod';
import type { Tool } from './_registry.js';
import { KnowledgeStateMachine } from '@/control-plane/knowledge-state-machine/index.js';
import {
  getCurrentTenant,
  getCurrentAgent,
} from '@/db/tenant-context.js';

const inputSchema = z.object({
  tipo: z.enum([
    'classificacao',
    'identificacao_entidade',
    'tom_resposta',
    'recorrencia',
  ]),
  contexto: z.string().min(1).max(4000),
  acao: z.string().min(1).max(2000),
  contexto_jsonb: z.record(z.unknown()).default({}),
  acoes_jsonb: z.record(z.unknown()).default({}),
  confianca: z.number().min(0).max(1).default(0.5),
  exemplo_origem_id: z.string().uuid().optional(),
});

const outputSchema = z.object({
  proposal_id: z.string(),
  initial_status: z.literal('pending_review'),
  visible_to_llm: z.literal(false),
  reason: z.string(),
});

export const proposeRuleTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'propose_rule',
  description:
    'Propõe uma regra aprendida. Regras SEMPRE caem em pending_review (humano decide) — nunca auto-ativadas.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['read_balance'],
  side_effect: 'write',
  redis_required: false,
  operation_type: 'create',
  audit_action: 'rule_learned',
  handler: async (args, ctx) => {
    const result = await KnowledgeStateMachine.propose({
      trace_id: ctx.request_id,
      tenant_id: getCurrentTenant(),
      agent_id: getCurrentAgent(),
      kind: 'rule',
      scope: 'agent',
      key: args.tipo,
      content: {
        tipo: args.tipo,
        contexto: args.contexto,
        acao: args.acao,
        contexto_jsonb: args.contexto_jsonb,
        acoes_jsonb: args.acoes_jsonb,
        ...(args.exemplo_origem_id !== undefined
          ? { exemplo_origem_id: args.exemplo_origem_id }
          : {}),
      },
      content_text: `[${args.tipo}] ${args.contexto} → ${args.acao}`,
      confidence: args.confianca,
      origin: 'llm_inference',
      source: 'tool:propose_rule',
    });

    return {
      proposal_id: result.proposal_id,
      initial_status: 'pending_review' as const,
      visible_to_llm: false as const,
      reason: result.reason,
    };
  },
};
