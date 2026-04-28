import type { z } from 'zod';
import type { ActionKey, AuditAction } from '@/governance/audit-actions.js';
import type { ResolvedPermission } from '@/governance/permissions.js';
import { registerTransactionTool } from './register-transaction.js';
import { queryBalanceTool } from './query-balance.js';
import { listTransactionsTool } from './list-transactions.js';
import { classifyTransactionTool } from './classify-transaction.js';
import { identifyEntityTool } from './identify-entity.js';

export type ToolHandlerCtx = {
  pessoa: import('@/db/schema.js').Pessoa;
  scope: { entidades: string[]; byEntity: Map<string, ResolvedPermission> };
  conversa: import('@/db/schema.js').Conversa;
  mensagem_id: string;
  request_id: string;
  idempotency_key: string;
};

export type Tool<I extends z.ZodTypeAny, O extends z.ZodTypeAny> = {
  name: string;
  description: string;
  input_schema: I;
  output_schema: O;
  required_actions: ReadonlyArray<ActionKey>;
  side_effect: 'none' | 'read' | 'write' | 'communication';
  redis_required: boolean;
  operation_type: 'create' | 'correct' | 'cancel' | 'update_meta' | 'parse_only' | 'read' | 'communicate';
  audit_action: AuditAction;
  handler: (input: z.infer<I>, ctx: ToolHandlerCtx) => Promise<z.infer<O>>;
};

export type AnyTool = Tool<z.ZodTypeAny, z.ZodTypeAny>;

export const REGISTRY: Record<string, AnyTool> = {
  register_transaction: registerTransactionTool as unknown as AnyTool,
  query_balance: queryBalanceTool as unknown as AnyTool,
  list_transactions: listTransactionsTool as unknown as AnyTool,
  classify_transaction: classifyTransactionTool as unknown as AnyTool,
  identify_entity: identifyEntityTool as unknown as AnyTool,
};

export function getToolSchemas(byEntity: Map<string, ResolvedPermission>) {
  // Determine the union of allowed actions across the scope's profiles
  const allowed = new Set<string>();
  for (const rp of byEntity.values()) {
    if (rp.profile.acoes.includes('*')) {
      // owner — all tools available
      return Object.values(REGISTRY).map(toolToSchema);
    }
    for (const a of rp.profile.acoes) allowed.add(a);
  }
  return Object.values(REGISTRY)
    .filter((t) => t.required_actions.every((a) => allowed.has(a)))
    .map(toolToSchema);
}

function toolToSchema(t: AnyTool) {
  // Convert Zod schema to a JSON-Schema-like object understood by Anthropic's tool API.
  // For simplicity we embed the schema description; the SDK accepts a JSON schema.
  return {
    name: t.name,
    description: t.description,
    input_schema: zodToJsonSchema(t.input_schema),
  };
}

function zodToJsonSchema(_schema: z.ZodTypeAny): Record<string, unknown> {
  // Minimal: we let Zod reject inputs in the dispatcher.
  // For the LLM we provide a permissive schema; richer schemas can be derived later.
  return { type: 'object', additionalProperties: true };
}
