/**
 * Issue #433 — `conversation_summary_compose` (baseline.core).
 *
 * A universal capability: let the agent compose a concise, structured summary of
 * the current conversation (summary + open questions + decisions + pending
 * actions) — to recap a long thread, brief a handoff, or anchor its own state.
 *
 * REUSES the shared `summarizeTranscript` helper
 * (`src/shared/summary/summarize-transcript.ts`) — the SAME prompt + transcript
 * formatting the `conversation-summarizer` cron worker uses (no duplicated
 * prompt/shape). The sibling #431 `conversation_summary_generate` wraps the same
 * helper.
 *
 * Conservative by construction:
 *   - side_effect: 'none', operation_type: 'parse_only' — it READS recent
 *     messages (or uses the caller-provided `history`) and returns text; it does
 *     NOT persist anything (it does NOT close the conversation — that is the
 *     worker's job).
 *   - required_actions: [] → universal baseline capability.
 *
 * Invariant #1 (tenant isolation): when reading from the DB it uses
 * `mensagensRepo.recentInConversation(ctx.conversa.id, …)`, which pins
 * tenant_id + agent_id from the ALS context AND filters to the caller's own
 * conversation — it can never read another conversation or tenant. The tool does
 * NOT accept a `conversation_id` (no scope-escape vector).
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';
import { mensagensRepo } from '@/db/repositories.js';
import {
  summarizeTranscript,
  type TranscriptMessage,
} from '@/shared/summary/summarize-transcript.js';

const inputSchema = z.object({
  // Optional caller-supplied transcript. When provided it is summarized AS-IS
  // (the agent already holds the messages); when absent the tool reads the
  // recent messages of the CURRENT conversation from the DB.
  history: z
    .array(
      z.object({
        direcao: z.string(),
        conteudo: z.string().nullable(),
      }),
    )
    .max(200)
    .optional(),
  // How many recent messages to read when `history` is not provided. Bounded.
  limit: z.number().int().positive().max(100).default(50),
  // What the summary is for (steers the prompt).
  purpose: z.string().max(500).optional(),
  // Hard cap on the summary length (characters).
  max_chars: z.number().int().positive().max(4000).optional(),
});

const outputSchema = z.object({
  conversa_id: z.string(),
  summary: z.string(),
  open_questions: z.array(z.string()),
  decisions: z.array(z.string()),
  pending_actions: z.array(z.string()),
});

export const conversationSummaryComposeTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'conversation_summary_compose',
  description:
    'Compõe um resumo estruturado da conversa atual (resumo, perguntas em aberto, decisões e pendências), usando o histórico fornecido ou as mensagens recentes desta conversa. Apenas leitura — não persiste nem encerra a conversa.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: [],
  side_effect: 'none',
  redis_required: false,
  operation_type: 'parse_only',
  audit_action: 'conversation_summary_composed',
  handler: async (args, ctx) => {
    let messages: TranscriptMessage[];
    if (args.history && args.history.length > 0) {
      messages = args.history.map((m) => ({ direcao: m.direcao, conteudo: m.conteudo }));
    } else {
      // recentInConversation is tenant+agent-scoped and filters by conversa_id —
      // newest first; reverse to chronological so the summary reads in order.
      const rows = await mensagensRepo.recentInConversation(ctx.conversa.id, args.limit);
      messages = rows
        .slice()
        .reverse()
        .map((m) => ({ direcao: m.direcao, conteudo: m.conteudo }));
    }

    const result = await summarizeTranscript(messages, {
      purpose: args.purpose,
      maxChars: args.max_chars,
      pessoa_id: ctx.pessoa.id,
      module: {
        name: 'conversation-summary-compose',
        triggered_by: 'sync_required',
        conversa_id: ctx.conversa.id,
      },
    });

    return {
      conversa_id: ctx.conversa.id,
      summary: result.summary,
      open_questions: result.open_questions,
      decisions: result.decisions,
      pending_actions: result.pending_actions,
    };
  },
};
