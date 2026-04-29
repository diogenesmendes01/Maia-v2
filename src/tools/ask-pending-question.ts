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
  z.object({ pending_question_id: z.string() }),
  z.object({ error: z.string() }),
]);

export const askPendingQuestionTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'ask_pending_question',
  description:
    'Cria uma pergunta pendente persistida que será resolvida quando o usuário responder. Use quando precisa esperar uma escolha (sim/não, ou 3-12 opções) antes de continuar.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['schedule_reminder'],
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
      const row = await pendingQuestionsRepo.create({
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

    return { pending_question_id: created.id };
  },
};
