import type { z } from 'zod';
import type { ActionKey, AuditAction } from '@/governance/audit-actions.js';
import type { ResolvedPermission } from '@/governance/permissions.js';
import { registerTransactionTool } from './register-transaction.js';
import { cancelTransactionTool } from './cancel-transaction.js';
import { queryBalanceTool } from './query-balance.js';
import { listTransactionsTool } from './list-transactions.js';
import { classifyTransactionTool } from './classify-transaction.js';
import { identifyEntityTool } from './identify-entity.js';
import { parseBoletoTool } from './parse-boleto.js';
import { parseReceiptTool } from './parse-receipt.js';
import { parseImageTool } from './parse-image.js';
import { transcribeAudioTool } from './transcribe-audio.js';
import { scheduleReminderTool } from './schedule-reminder.js';
import { cancelReminderTool } from './cancel-reminder.js';
import { startRecurringOutreachTool } from './start-recurring-outreach.js';
import { startRecurringPaymentTool } from './start-recurring-payment.js';
import { sendProactiveMessageTool } from './send-proactive-message.js';
import { compareEntitiesTool } from './compare-entities.js';
import { recallMemoryTool } from './recall-memory.js';
import { saveFactTool } from './save-fact.js';
import { saveRuleTool } from './save-rule.js';
import { proposeFactTool } from './propose-fact.js';
import { proposeRuleTool } from './propose-rule.js';
import { proposeMemoryTool } from './propose-memory.js';
import { proposeHintTool } from './propose-hint.js';
import { listPendingTool } from './list-pending.js';
import { startWorkflowTool } from './start-workflow.js';
import { askPendingQuestionTool } from './ask-pending-question.js';
import { generateReportTool } from './generate-report.js';
import { config } from '@/config/env.js';

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
  // Optional: extract the resource id (e.g. transacao_id) from the tool's
  // result so the dispatcher can populate audit.alvo_id. Returning null
  // signals "no new resource was created" (e.g. duplicate-suspected branch).
  extractAlvoId?: (result: z.infer<O>) => string | null;
  /**
   * When true, any turn that dispatches this tool flips the outbound text
   * reply into view-once (B3a). OR-logic across all tools in the turn.
   */
  sensitive?: boolean;
};

export type AnyTool = Tool<z.ZodTypeAny, z.ZodTypeAny>;

export const REGISTRY: Record<string, AnyTool> = {
  register_transaction: registerTransactionTool as unknown as AnyTool,
  cancel_transaction: cancelTransactionTool as unknown as AnyTool,
  query_balance: queryBalanceTool as unknown as AnyTool,
  list_transactions: listTransactionsTool as unknown as AnyTool,
  classify_transaction: classifyTransactionTool as unknown as AnyTool,
  identify_entity: identifyEntityTool as unknown as AnyTool,
  parse_boleto: parseBoletoTool as unknown as AnyTool,
  parse_receipt: parseReceiptTool as unknown as AnyTool,
  parse_image: parseImageTool as unknown as AnyTool,
  transcribe_audio: transcribeAudioTool as unknown as AnyTool,
  // Spec 18 — Scheduling V2 tools. Gated by FEATURE_SCHEDULING_V2 so the
  // LLM doesn't expose tools whose backing workers aren't running.
  // Blockers 5 + 6: without this gate, schedule_reminder would create
  // series rows that never fire (no worker), and start_recurring_* would
  // accept commitments the engine can't honour.
  ...(config.FEATURE_SCHEDULING_V2
    ? {
        schedule_reminder: scheduleReminderTool as unknown as AnyTool,
        cancel_reminder: cancelReminderTool as unknown as AnyTool,
        start_recurring_outreach: startRecurringOutreachTool as unknown as AnyTool,
        start_recurring_payment: startRecurringPaymentTool as unknown as AnyTool,
      }
    : {}),
  send_proactive_message: sendProactiveMessageTool as unknown as AnyTool,
  compare_entities: compareEntitiesTool as unknown as AnyTool,
  recall_memory: recallMemoryTool as unknown as AnyTool,
  save_fact: saveFactTool as unknown as AnyTool,
  save_rule: saveRuleTool as unknown as AnyTool,
  // P10a — Knowledge State Machine `propose_*` tools. The harness
  // decides the initial lifecycle state (ephemeral / pending_review);
  // the LLM never writes directly to `active`.
  propose_fact: proposeFactTool as unknown as AnyTool,
  propose_rule: proposeRuleTool as unknown as AnyTool,
  propose_memory: proposeMemoryTool as unknown as AnyTool,
  propose_hint: proposeHintTool as unknown as AnyTool,
  list_pending: listPendingTool as unknown as AnyTool,
  start_workflow: startWorkflowTool as unknown as AnyTool,
  ask_pending_question: askPendingQuestionTool as unknown as AnyTool,
  // B3b: gated by feature flag. When false, the LLM never sees this tool.
  ...(config.FEATURE_PDF_REPORTS
    ? { generate_report: generateReportTool as unknown as AnyTool }
    : {}),
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
