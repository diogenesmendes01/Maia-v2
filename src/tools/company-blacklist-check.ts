/**
 * Issue #416 — `company_blacklist_check` (boleto proposal vertical, read-only).
 *
 * Check whether a company has blocks or special operational notes. Conservative:
 * side_effect 'read'. Out of scope (#416): a real blocklist integration — stub.
 *
 * Note: this READS a block status; it does NOT block/escalate execution itself.
 * Whether a block stops a write is decided by `confirm_before_write_policy` /
 * `human_confirmation_policy` (migration 078) composed with the dispatcher
 * guard (taxonomy §3/§6), never inside this tool.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';

const inputSchema = z
  .object({
    cnpj: z.string().max(20).optional(),
    company_id: z.string().max(64).optional(),
  })
  .refine((v) => Boolean(v.cnpj ?? v.company_id), {
    message: 'cnpj or company_id is required',
  });

const outputSchema = z.object({
  status: z.enum(['clear', 'blocked', 'attention']),
  block_reason: z.string().optional(),
  observations: z.array(z.string()).default([]),
});

export const companyBlacklistCheckTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'company_blacklist_check',
  description:
    'Verifica se uma empresa tem bloqueios ou observações operacionais especiais. Apenas leitura — não bloqueia nem escala execução (isso é decisão de policy).',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: [],
  side_effect: 'read',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'company_blacklist_checked',
  handler: async () => {
    // Stub: no live blocklist integration in #416.
    return { status: 'clear' as const, observations: [] };
  },
};
