import { z } from 'zod';
import type { Tool } from './_registry.js';
import { config } from '@/config/env.js';
import { withTx } from '@/db/client.js';
import { pendingQuestionsRepo } from '@/db/repositories.js';
import { audit } from '@/governance/audit.js';

const AFFIRMATIVE = /^(sim|s[ií]m?|aprova|aprovo|confirma|confirmo|libera|ok|pode|positivo)$/i;
const NEGATIVE = /^(n[ãa]o|cancela|cancelo|bloqueia|bloqueio|nega|recusa|recuso|negativo)$/i;

const inputSchema = z.object({
  entidade_id: z.string().uuid().optional(),
  pergunta: z.string().min(3).max(500),
  opcoes_validas: z
    .array(z.object({ key: z.string().min(1).max(40), label: z.string().min(1).max(80) }))
    .min(2)
    .max(12),
  acao_proposta: z
    .object({ tool: z.string(), args: z.record(z.unknown()) })
    .optional(),
  ttl_minutes: z.number().int().positive().max(1440).optional(),
});

const outputSchema = z.union([
  z.object({
    pending_question_id: z.string(),
    opcoes_count: z.number().int().min(2).max(12),
    opcoes_validas: z.array(z.object({ key: z.string(), label: z.string() })),
  }),
  z.object({ error: z.string() }),
]);

export const askPendingQuestionTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'ask_pending_question',
  description:
    'Cria uma pergunta pendente persistida que será resolvida quando o usuário responder. Use quando precisa esperar uma escolha (sim/não, ou 3-12 opções) antes de continuar.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  // No required_actions: this is an orchestration primitive (the agent's own
  // ability to wait on a user choice), not a domain action requested by the
  // user. Tying it to `schedule_reminder` would block the gate in any flow
  // where the profile lacks reminder permission — e.g. transaction creation
  // / correction / cancellation by an `operador` profile. Authorization for
  // the *proposed action* (acao_proposta.tool) is enforced when that tool is
  // dispatched, not when the question is asked.
  required_actions: [],
  side_effect: 'communication',
  redis_required: false,
  operation_type: 'create',
  audit_action: 'pending_created',
  handler: async (args, ctx) => {
    if (args.opcoes_validas.length === 2) {
      const [first, second] = args.opcoes_validas;
      if (!AFFIRMATIVE.test(first!.key) || !NEGATIVE.test(second!.key)) {
        return { error: 'binary_options_must_be_affirmative_first' };
      }
    }
    const ttl = args.ttl_minutes ?? config.PENDING_QUESTION_TTL_MINUTES;
    const expira_em = new Date(Date.now() + ttl * 60_000);

    const created = await withTx(async (tx) => {
      const cancelled = await pendingQuestionsRepo.cancelOpenForConversaTx(
        tx,
        ctx.conversa.id,
        'substituted',
      );
      if (cancelled.cancelled_ids.length > 0) {
        await audit({
          acao: 'pending_substituted',
          pessoa_id: ctx.pessoa.id,
          conversa_id: ctx.conversa.id,
          mensagem_id: ctx.mensagem_id,
          metadata: { cancelled_ids: cancelled.cancelled_ids },
        });
      }
      // Insert in the same tx as the cancel above. The partial unique index
      // `(conversa_id) WHERE status='aberta'` (migration 004) means a
      // separate connection would still see the prior row as 'aberta' until
      // the cancel commits, and the insert would 23505.
      const row = await pendingQuestionsRepo.createTx(tx, {
        conversa_id: ctx.conversa.id,
        pessoa_id: ctx.pessoa.id,
        tipo: 'gate',
        pergunta: args.pergunta,
        opcoes_validas: args.opcoes_validas,
        acao_proposta: (args.acao_proposta ?? {}) as object,
        expira_em,
        status: 'aberta',
        metadata: {},
      });
      return row;
    });

    return {
      pending_question_id: created.id,
      opcoes_count: args.opcoes_validas.length,
      opcoes_validas: args.opcoes_validas,
    };
  },
};
