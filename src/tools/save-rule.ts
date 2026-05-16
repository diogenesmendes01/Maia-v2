/**
 * [DEPRECATED até P11] `save_rule` — agora wrapper para `propose_rule`.
 *
 * P10a Knowledge State Machine: regras SEMPRE caem em `pending_review`.
 * Wrapper preserva o output shape legacy (`{rule_id, status}`) para
 * compatibilidade com callers existentes. Status reportado é
 * `'probatoria'` (pre-KSM) ou `'pending_review'` (KSM on).
 */

import { z } from 'zod';
import type { Tool } from './_registry.js';
import { logger } from '@/lib/logger.js';
import { rulesRepo } from '@/db/repositories.js';
import { FEATURE_KNOWLEDGE_STATE_MACHINE_V1 } from '@/config/feature-flags.js';
import { proposeRuleTool } from './propose-rule.js';

const inputSchema = z.object({
  tipo: z.enum([
    'classificacao',
    'identificacao_entidade',
    'tom_resposta',
    'recorrencia',
  ]),
  contexto: z.string().min(1),
  acao: z.string().min(1),
  contexto_jsonb: z.record(z.unknown()).default({}),
  acoes_jsonb: z.record(z.unknown()).default({}),
  exemplo_origem_id: z.string().uuid().optional(),
});

const outputSchema = z.object({
  rule_id: z.string(),
  status: z.enum(['probatoria', 'pending_review']),
});

export const saveRuleTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'save_rule',
  description:
    '[DEPRECATED até P11] Use propose_rule. save_rule agora propõe via Knowledge State Machine — regras sempre caem em pending_review (humano decide).',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['read_balance'],
  side_effect: 'write',
  redis_required: false,
  operation_type: 'create',
  audit_action: 'rule_learned',
  handler: async (args, ctx) => {
    logger.warn(
      {
        tool: 'save_rule',
        caller_pessoa_id: ctx.pessoa.id,
        tipo: args.tipo,
      },
      'deprecation_warning_save_rule',
    );

    if (!FEATURE_KNOWLEDGE_STATE_MACHINE_V1) {
      const r = await rulesRepo.create({
        tipo: args.tipo,
        contexto: args.contexto,
        acao: args.acao,
        contexto_jsonb: args.contexto_jsonb,
        acoes_jsonb: args.acoes_jsonb,
        confianca: '0.50',
        acertos: 0,
        erros: 0,
        ativa: true,
        exemplo_origem_id: args.exemplo_origem_id ?? null,
      });
      return { rule_id: r.id, status: 'probatoria' as const };
    }

    const result = await proposeRuleTool.handler(
      {
        tipo: args.tipo,
        contexto: args.contexto,
        acao: args.acao,
        contexto_jsonb: args.contexto_jsonb,
        acoes_jsonb: args.acoes_jsonb,
        confianca: 0.5,
        ...(args.exemplo_origem_id !== undefined
          ? { exemplo_origem_id: args.exemplo_origem_id }
          : {}),
      },
      ctx,
    );
    return { rule_id: result.proposal_id, status: 'pending_review' as const };
  },
};
