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
import { getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';
import { logger } from '@/lib/logger.js';
import type {
  KnowledgeOrigin,
  KnowledgeScope,
} from '@/control-plane/knowledge-state-machine/types.js';

const inputSchema = z.object({
  escopo: z.string().regex(/^(global|tenant|pessoa:[0-9a-f-]+|entidade:[0-9a-f-]+)$/),
  chave: z.string().min(1).max(120),
  valor: z.unknown(),
  texto: z.string().min(1).max(2000),
  fonte: z.enum(['configurado', 'aprendido', 'inferido']).default('aprendido'),
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

/**
 * G3 (spec §7.6.2) — A PROVENIÊNCIA DEIXA DE SER ESCOLHA DO MODELO.
 *
 * `fonteToOrigin` mapeava `fonte='configurado'` para `origin='human_approved'`.
 * Como `fonte` é campo do schema de entrada, quem escolhia era o MODELO — e o
 * efeito não parava no rótulo:
 *
 *   modelo manda `fonte='configurado'`
 *     → `origin='human_approved'`
 *     → o scorer elevava a confiança para 0.8 ("bônus humano")
 *     → o risco caía
 *     → o item podia nascer `ephemeral`, visível ao LLM, sem revisão humana.
 *
 * Uma tool chamada pelo modelo tem exatamente uma proveniência possível, e ela
 * não depende do que o modelo diz: `llm_inference`. É o que esta constante
 * fixa. Nada no payload a altera.
 *
 * `configurado` passa a ser RECUSADO em vez de silenciosamente rebaixado: o
 * chamador pediu autoridade humana, e uma recusa nomeada é o que faz esse
 * pedido aparecer. `aprendido`/`inferido` continuam aceitos por compatibilidade
 * e não valem como autoridade — geram telemetria de depreciação.
 */
const ORIGEM_DE_TOOL_DO_MODELO: KnowledgeOrigin = 'llm_inference';

/** Recusa nomeada, para o modelo não confundir com erro de validação. */
export class InvalidProvenanceError extends Error {
  readonly code = 'invalid_provenance';
  constructor() {
    super(
      'invalid_provenance: `fonte=configurado` afirma aprovação humana e não pode ser declarada por uma chamada de ferramenta. ' +
        'Proponha o fato e deixe a revisão humana decidir.',
    );
    this.name = 'InvalidProvenanceError';
  }
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

    // G3 — a proveniência é recusada, não rebaixada em silêncio.
    if (args.fonte === 'configurado') throw new InvalidProvenanceError();
    if (args.fonte === 'inferido') {
      // `inferido` mapeava para `tool_callback`, que também é uma afirmação
      // sobre a origem que o modelo não pode fazer. Não quebra o chamador, mas
      // deixa de valer como autoridade e fica visível para quem for depreciar.
      logger.warn(
        { tool: 'propose_fact', fonte: args.fonte, request_id: ctx.request_id },
        'tool.deprecated_provenance_field',
      );
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
      // Fixo. Ver `ORIGEM_DE_TOOL_DO_MODELO`: chamada de tool pelo modelo tem
      // uma proveniência possível, e não é o modelo que a escolhe.
      origin: ORIGEM_DE_TOOL_DO_MODELO,
      source: 'tool:propose_fact',
      ...(args.sensibilidade !== undefined ? { sensitivity_hint: args.sensibilidade } : {}),
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
    const initial_status = result.initial_status === 'ephemeral' ? 'ephemeral' : 'pending_review';

    return {
      proposal_id: result.proposal_id,
      initial_status,
      visible_to_llm: result.visible_to_llm,
      reason: result.reason,
    };
  },
};
