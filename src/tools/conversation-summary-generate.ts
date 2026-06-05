/**
 * Issue #416 — `conversation_summary_generate` (boleto proposal vertical).
 *
 * Create a short OPERATIONAL summary of the service interaction: structured
 * summary, main actions performed, pending items, and an escalation reason when
 * applicable. Pure analysis over the provided context.
 *
 * Conservative: side_effect 'none' — it produces text from the supplied
 * conversation/context; it neither reads new data sources nor mutates anything,
 * nor sends externally. Out of scope (#416): an LLM summarisation call — the
 * handler is a contract-honouring stub that echoes the structure.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';

const inputSchema = z.object({
  conversation_history: z.string().max(20000).optional(),
  selected_context: z.string().max(8000).optional(),
});

const outputSchema = z.object({
  summary: z.string(),
  main_actions: z.array(z.string()).default([]),
  pending_items: z.array(z.string()).default([]),
  escalation_reason: z.string().optional(),
});

export const conversationSummaryGenerateTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'conversation_summary_generate',
  description:
    'Gera um resumo operacional curto do atendimento: resumo estruturado, principais ações, pendências e motivo de escalação quando aplicável. Apenas análise do contexto fornecido, sem efeito colateral.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: [],
  side_effect: 'none',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'conversation_summary_generated',
  handler: async () => {
    // Stub: no live summarisation in #416.
    return { summary: '', main_actions: [], pending_items: [] };
  },
};
