/**
 * Issue #410 — `audit_decision` (baseline.core).
 *
 * A thin, governed wrapper over `audit()` that lets the agent explicitly record
 * a decision it made (with rationale) into the append-only `audit_logs` trail.
 * This makes invariant #4 (audit every decision) directly reachable as a
 * baseline capability — the agent can leave a forensic note about WHY it chose
 * a course of action, scoped to the current pessoa/conversa.
 *
 * Conservative by construction:
 *   - side_effect: 'none' — writing an audit row is observability, not a
 *     business mutation; it cannot change domain state.
 *   - required_actions: [] → universal baseline capability.
 *   - The handler calls `audit()` with the FIXED action label `decision_audited`
 *     and stamps the rationale into `metadata`. The agent cannot choose an
 *     arbitrary audit action (it can't forge, say, a `transaction_created`
 *     row): the action label is hard-coded here.
 *
 * Invariant #1 (tenant isolation): `audit()` resolves tenant/agent from the ALS
 * context (or the synthetic system bucket), so the row is always attributed
 * correctly.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';
import { audit } from '@/governance/audit.js';

const inputSchema = z.object({
  // What the agent decided (a short, stable label, e.g. 'declined_refund').
  decision: z.string().min(1).max(200),
  // Why — the rationale to preserve for forensics.
  rationale: z.string().min(1).max(2000),
});

const outputSchema = z.object({
  recorded: z.literal(true),
});

export const auditDecisionTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'audit_decision',
  description:
    'Registra explicitamente uma decisão e seu racional na trilha de auditoria. Sem efeito de negócio — apenas observabilidade.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: [],
  side_effect: 'none',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'decision_audited',
  handler: async (args, ctx) => {
    // FIXED action label — the agent cannot forge a different audit action.
    await audit({
      acao: 'decision_audited',
      pessoa_id: ctx.pessoa.id,
      conversa_id: ctx.conversa.id,
      mensagem_id: ctx.mensagem_id,
      metadata: { decision: args.decision, rationale: args.rationale },
    });
    return { recorded: true as const };
  },
};
