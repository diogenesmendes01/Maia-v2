/**
 * Issue #410 — `remember_safe_fact` (baseline.core).
 *
 * The ONE write a baseline agent is allowed: persist a SAFE fact about the
 * person it is talking to (e.g. "prefers to be called by first name", "speaks
 * pt-BR"). It is deliberately NOT a general-purpose memory write:
 *
 *   - Scope is FORCED to the caller's own pessoa (`pessoa:<ctx.pessoa.id>`).
 *     The tool does NOT accept an arbitrary `escopo`, so it can never write a
 *     `global` fact, nor a fact scoped to an `entidade` (which is where
 *     financial/domain memory lives). This keeps "safe memory" strictly
 *     conversational and per-interlocutor.
 *   - side_effect: 'write', gated by the granular `save_safe_fact` action key
 *     (NOT `create_transaction` / any financial write) so an agent can carry
 *     this baseline capability without any domain-mutation grant.
 *   - `fonte` is pinned to 'aprendido' (learned-in-conversation); the tool does
 *     not let the LLM claim a fact was 'configurado' (operator-set).
 *
 * Invariant #2 (LLM proposes, backend disposes): the backend forces the scope;
 * the LLM only supplies the key/value. Invariant #1 (tenant isolation): the
 * underlying `saveFact`/`factsRepo` writes are tenant+agent-scoped via ALS.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';
import { saveFact } from '@/memory/semantic.js';

const inputSchema = z.object({
  // A short, stable key for the fact (e.g. 'preferred_name', 'language').
  chave: z.string().min(1).max(120),
  // The value to remember. Kept conservative: a string (the safe, human-set
  // facts the baseline targets are textual). Domain/structured memory uses the
  // domain tools, not this one.
  valor: z.string().min(1).max(2000),
});

const outputSchema = z.object({
  fact_id: z.string(),
  escopo: z.string(),
});

export const rememberSafeFactTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'remember_safe_fact',
  description:
    'Registra um fato SEGURO sobre o interlocutor atual (ex.: preferência de tratamento, idioma). Escopo é sempre a própria pessoa da conversa — não escreve memória global nem de domínio.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['save_safe_fact'],
  side_effect: 'write',
  effect_class: 'idempotent',
  redis_required: false,
  operation_type: 'create',
  audit_action: 'safe_fact_remembered',
  handler: async (args, ctx) => {
    // Scope is FORCED to the caller's own pessoa — never accepted from input.
    const escopo = `pessoa:${ctx.pessoa.id}`;
    const fact = await saveFact({
      escopo,
      chave: args.chave,
      valor: args.valor,
      fonte: 'aprendido',
    });
    return { fact_id: fact.id, escopo };
  },
};
