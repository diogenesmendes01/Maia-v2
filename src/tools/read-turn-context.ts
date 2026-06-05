/**
 * Issue #410 — `read_turn_context` (baseline.core).
 *
 * The most basic universal capability: let the agent inspect the CURRENT turn
 * — the recent messages in THIS conversation, within the caller's tenant+agent
 * scope. No domain data, no financial reads: just the conversational context
 * the agent is already operating inside.
 *
 * Conservative by construction:
 *   - side_effect: 'none' (pure read of the agent's own conversation).
 *   - required_actions: [] → universal (every runtime agent can call it; the
 *     baseline contract requires "entender o contexto do turno").
 *   - Strictly scoped: `mensagensRepo.recentInConversation` pins tenant_id +
 *     agent_id from the ALS context AND filters to the caller's conversa, so
 *     it can never read another conversation (let alone another tenant).
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';
import { mensagensRepo } from '@/db/repositories.js';

const inputSchema = z.object({
  // How many recent messages of the current conversation to return. Bounded so
  // the LLM can't pull an unbounded history into context.
  limit: z.number().int().positive().max(50).default(20),
});

const outputSchema = z.object({
  conversa_id: z.string(),
  messages: z.array(
    z.object({
      direcao: z.string(),
      tipo: z.string(),
      conteudo: z.string().nullable(),
      created_at: z.string(),
    }),
  ),
});

export const readTurnContextTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'read_turn_context',
  description:
    'Lê o contexto do turno atual: as mensagens recentes desta conversa, dentro do escopo do agente. Apenas leitura, sem efeito colateral.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: [],
  side_effect: 'none',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'turn_context_read',
  handler: async (args, ctx) => {
    // recentInConversation is tenant+agent-scoped (reads from ALS context) and
    // filters by conversa_id — newest first. We return oldest-first so the LLM
    // reads the turn in chronological order.
    const rows = await mensagensRepo.recentInConversation(ctx.conversa.id, args.limit);
    const messages = rows
      .slice()
      .reverse()
      .map((m) => ({
        direcao: m.direcao,
        tipo: m.tipo,
        conteudo: m.conteudo,
        created_at: m.created_at.toISOString(),
      }));
    return { conversa_id: ctx.conversa.id, messages };
  },
};
