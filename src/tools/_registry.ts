import type { z } from 'zod';
import type { ActionKey, AuditAction } from '@/governance/audit-actions.js';
import type { ResolvedPermission } from '@/governance/permissions.js';
import { registerTransactionTool } from './register-transaction.js';
import { queryBalanceTool } from './query-balance.js';
import { listTransactionsTool } from './list-transactions.js';
import { classifyTransactionTool } from './classify-transaction.js';
import { identifyEntityTool } from './identify-entity.js';
import { parseBoletoTool } from './parse-boleto.js';
import { parseReceiptTool } from './parse-receipt.js';
import { parseImageTool } from './parse-image.js';
import { transcribeAudioTool } from './transcribe-audio.js';
import { scheduleReminderTool } from './schedule-reminder.js';
import { sendProactiveMessageTool } from './send-proactive-message.js';
import { compareEntitiesTool } from './compare-entities.js';
import { recallMemoryTool } from './recall-memory.js';
import { saveFactTool } from './save-fact.js';
import { saveRuleTool } from './save-rule.js';
import { listPendingTool } from './list-pending.js';
import { startWorkflowTool } from './start-workflow.js';

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
  parse_boleto: parseBoletoTool as unknown as AnyTool,
  parse_receipt: parseReceiptTool as unknown as AnyTool,
  parse_image: parseImageTool as unknown as AnyTool,
  transcribe_audio: transcribeAudioTool as unknown as AnyTool,
  schedule_reminder: scheduleReminderTool as unknown as AnyTool,
  send_proactive_message: sendProactiveMessageTool as unknown as AnyTool,
  compare_entities: compareEntitiesTool as unknown as AnyTool,
  recall_memory: recallMemoryTool as unknown as AnyTool,
  save_fact: saveFactTool as unknown as AnyTool,
  save_rule: saveRuleTool as unknown as AnyTool,
  list_pending: listPendingTool as unknown as AnyTool,
  start_workflow: startWorkflowTool as unknown as AnyTool,
};

export function getToolSchemas(byEntity: Map<string, ResolvedPermission>) {
  const allowed = new Set<string>();
  let isOwner = false;
  for (const rp of byEntity.values()) {
    if (rp.profile.acoes.includes('*')) {
      isOwner = true;
      break;
    }
    for (const a of rp.profile.acoes) allowed.add(a);
  }
  if (isOwner) return Object.values(REGISTRY).map(toolToSchema);
  return Object.values(REGISTRY)
    .filter((t) => t.required_actions.every((a) => allowed.has(a)))
    .map(toolToSchema);
}

function toolToSchema(t: AnyTool) {
  return {
    name: t.name,
    description: t.description,
    input_schema: { type: 'object' as const, additionalProperties: true },
  };
}
