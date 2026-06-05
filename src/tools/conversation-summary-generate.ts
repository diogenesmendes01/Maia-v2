/**
 * Issue #431 — `conversation_summary_generate` (boleto proposal domain adapter).
 *
 * Generates a short OPERATIONAL summary of a service interaction for the boleto
 * proposal role. It does NOT duplicate the summarization prompt/shape and does
 * NOT create a second memory store.
 *
 * Reuse boundary:
 *   - WRAPS the shared `summarizeTranscript` helper
 *     (`src/shared/summary/summarize-transcript.ts`) — the SAME prompt +
 *     transcript formatting the `conversation-summarizer` cron worker and the
 *     #433 `conversation_summary_compose` tool use. This adapter only MAPS the
 *     helper's `{ summary, open_questions, decisions, pending_actions }` onto
 *     the boleto contract `{ summary, main_actions, pending_items,
 *     escalation_reason? }`.
 *
 * Conservative by construction:
 *   - side_effect: 'none', operation_type: 'parse_only' — reads recent messages
 *     (or the caller-provided `history`) and returns text; it does NOT persist
 *     and does NOT close the conversation (that is the worker's job).
 *   - Invariant #1: when reading from the DB it uses
 *     `mensagensRepo.recentInConversation(ctx.conversa.id, …)` (tenant+agent
 *     pinned, current conversation only). No `conversation_id` scope-escape.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';
import { mensagensRepo } from '@/db/repositories.js';
import {
  summarizeTranscript,
  type TranscriptMessage,
} from '@/shared/summary/summarize-transcript.js';

const inputSchema = z.object({
  // Accepted for API parity — the DB read is pinned to the ALS conversation.
  conversation_id: z.string().max(120).optional(),
  // Optional caller-supplied transcript (role/content). When provided it is
  // summarized AS-IS; when absent the recent messages of the CURRENT
  // conversation are read from the DB.
  history: z
    .array(
      z.object({
        role: z.string(),
        content: z.string(),
      }),
    )
    .max(200)
    .optional(),
  selected_context: z.unknown().optional(),
  max_chars: z.number().int().positive().max(4000).optional(),
  // How many recent messages to read when `history` is absent. Bounded.
  limit: z.number().int().positive().max(100).default(50),
});

const outputSchema = z.object({
  conversa_id: z.string(),
  summary: z.string(),
  main_actions: z.array(z.string()),
  pending_items: z.array(z.string()),
  escalation_reason: z.string().optional(),
});

const BOLETO_PURPOSE =
  'as ações operacionais realizadas no atendimento, pendências em aberto e qualquer motivo de escalonamento (jurídico, reembolso, reclamação formal)';

export const conversationSummaryGenerateTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'conversation_summary_generate',
  description:
    'Gera um resumo operacional curto do atendimento (resumo, ações principais e pendências), reaproveitando o sumarizador compartilhado. Apenas leitura — não persiste nem encerra a conversa.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: [],
  side_effect: 'none',
  redis_required: false,
  operation_type: 'parse_only',
  audit_action: 'conversation_summary_generated',
  handler: async (args, ctx) => {
    let messages: TranscriptMessage[];
    if (args.history && args.history.length > 0) {
      // Map role/content → the helper's {direcao, conteudo}. 'user'/'in' map to
      // the inbound side; everything else renders as the agent ('Maia').
      messages = args.history.map((m) => ({
        direcao: m.role === 'user' || m.role === 'in' ? 'in' : 'out',
        conteudo: m.content,
      }));
    } else {
      const rows = await mensagensRepo.recentInConversation(ctx.conversa.id, args.limit);
      messages = rows
        .slice()
        .reverse()
        .map((m) => ({ direcao: m.direcao, conteudo: m.conteudo }));
    }

    const result = await summarizeTranscript(messages, {
      purpose: BOLETO_PURPOSE,
      maxChars: args.max_chars,
      pessoa_id: ctx.pessoa.id,
      module: {
        name: 'conversation-summary-generate',
        triggered_by: 'sync_required',
        conversa_id: ctx.conversa.id,
      },
    });

    // Map the shared shape → the boleto shape:
    //   decisions + pending_actions → main_actions (what was done/committed)
    //   pending_actions             → pending_items (what is still open)
    //   open_questions (if any)     → escalation_reason hint (first one)
    const mainActions = [...result.decisions];
    const escalation = result.open_questions.length > 0 ? result.open_questions[0] : undefined;

    return {
      conversa_id: ctx.conversa.id,
      summary: result.summary,
      main_actions: mainActions,
      pending_items: result.pending_actions,
      ...(escalation ? { escalation_reason: escalation } : {}),
    };
  },
};
