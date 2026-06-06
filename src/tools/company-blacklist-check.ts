/**
 * Issue #416/#432 — `company_blacklist_check` (boleto proposal vertical, read-only).
 *
 * Check whether a company has blocks or special operational notes. Conservative:
 * side_effect 'read'.
 *
 * Note: this READS a block status; it does NOT block/escalate execution itself.
 * Whether a block stops a write is decided by `confirm_before_write_policy` /
 * `human_confirmation_policy` (migration 078) composed with the dispatcher
 * guard (taxonomy §3/§6), never inside this tool.
 *
 * HONEST STUB (issue #432): there is NO blocklist integration yet, so the handler
 * returns `status: 'unknown'` — NEVER `'clear'`. `'clear'` would assert the
 * company is confirmed NOT blocked (a false safety certainty that could greenlight
 * engaging a company that is actually blocked); `'unknown'` honestly means "not
 * checked". A real integration may later return clear/blocked/attention.
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
  // `unknown` is the honest stub value (no blocklist integration yet); it must
  // never claim `clear` without a real check. clear/blocked/attention are for a
  // future integration.
  status: z.enum(['unknown', 'clear', 'blocked', 'attention']),
  block_reason: z.string().optional(),
  observations: z.array(z.string()).default([]),
});

export const companyBlacklistCheckTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'company_blacklist_check',
  description:
    'Verifica se uma empresa tem bloqueios ou observações operacionais especiais. Apenas leitura — não bloqueia nem escala execução (isso é decisão de policy). STUB (#432): ainda não há blocklist — retorna status=unknown (NUNCA clear sem checagem real).',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: [],
  side_effect: 'read',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'company_blacklist_checked',
  handler: async () => {
    // Honest stub (#432): no blocklist integration. Return `unknown` — never
    // `clear`, which would falsely assert the company is not blocked.
    return { status: 'unknown' as const, observations: [] };
  },
};
