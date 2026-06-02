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
import { featureFlags } from '@/config/feature-flags.js';
import { FeatureFlagName } from '@/types/enums.js';
// Calendar v2 — read-only tools
import { calendarIsBusinessDayTool } from './calendar/calendar-is-business-day.js';
import { calendarNextHolidayTool } from './calendar/calendar-next-holiday.js';
import { calendarListHolidaysTool } from './calendar/calendar-list-holidays.js';
import { calendarBusinessDaysBetweenTool } from './calendar/calendar-business-days-between.js';
import { calendarAddBusinessDaysTool } from './calendar/calendar-add-business-days.js';
// Calendar v2 — write tools + P5 closure
import { registerCustomHolidayTool } from './register-custom-holiday.js';
import { approveCapabilityProposalTool } from './approve-capability-proposal.js';
import { rejectCapabilityProposalTool } from './reject-capability-proposal.js';
import { listPendingProposalsTool } from './list-pending-proposals.js';

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
   * Issue #316 — transactional outbox hook. A tool with a NON-IDEMPOTENT
   * external side effect (e.g. sending a WhatsApp message) does NOT fire the
   * effect inline. Its handler PLANS the effect and returns it; this hook
   * extracts the `PlannedEffect` from the handler result so the dispatcher can
   * record it in `idempotency_effect_outbox` IN THE SAME TRANSACTION as the
   * winning idempotency reservation completion. A single relayer
   * (src/workers/idempotency-outbox-relayer.ts) then dispatches it EXACTLY
   * ONCE — so a preempted-but-fenced owner can never double-fire the effect
   * (it never fired it at all; only the committed outbox row drives dispatch).
   *
   * Returning null = no external effect to relay for this result (the
   * dispatcher completes the reservation normally, without an outbox write).
   * When set AND returning non-null, the dispatcher routes through the atomic
   * markCompleted+enqueue path instead of plain markCompleted.
   */
  extractEffect?: (result: z.infer<O>) => import(
    '@/governance/idempotency-effects.js'
  ).PlannedEffect | null;
  /**
   * When true, any turn that dispatches this tool flips the outbound text
   * reply into view-once (B3a). OR-logic across all tools in the turn.
   */
  sensitive?: boolean;
  /**
   * Issue #366 — financial-mutation audit durability. When true, the tool's
   * handler writes its OWN audit row TRANSACTIONALLY (via `auditTx(tx, …)`)
   * inside the same `withTx` as the money-moving write — so ledger + balance +
   * audit commit or roll back atomically and a failed audit insert is fail-loud
   * (it aborts the whole tx, never leaving a balance change without its audit
   * row). The dispatcher then SKIPS its post-commit best-effort `audit()` for
   * this tool to avoid a duplicate audit row — but ONLY when `auditedInTx`
   * (below) confirms `auditTx` actually ran for THIS invocation. Only
   * money-moving tools that self-audit transactionally set this.
   */
  audits_in_tx?: boolean;
  /**
   * Issue #366 (review #374) — PER-INVOCATION audit signal. `audits_in_tx` is
   * a static tool-wide opt-in, but these tools have schema-valid EARLY-RETURN
   * paths (register_transaction duplicate-suspected; cancel_transaction
   * already-`cancelada`/not-found) that exit BEFORE any `auditTx` runs inside
   * `withTx`. For those paths the dispatcher MUST still fire its post-commit
   * `audit()` (the append-only mutation trail requires a row for EVERY
   * invocation). This predicate inspects the tool's own result and returns
   * true ONLY on the branch where `auditTx` was actually called in-tx — so the
   * dispatcher skips its fallback audit() exclusively for self-audited
   * invocations, and audits the early-return paths normally. Only consulted
   * when `audits_in_tx` is set.
   */
  auditedInTx?: (result: z.infer<O>) => boolean;
  /**
   * Codex review #105 (medium): kill-switch em runtime. Quando setado, o
   * dispatcher checa o flag IMEDIATAMENTE antes de autorizar/executar — se
   * o flag estiver off (kill switch ativo), o tool é tratado como
   * inexistente para a chamada. O filtro em `REGISTRY` no module-load
   * continua valendo para o schema exposto ao LLM, mas processos já
   * carregados que recebam o tool name via chamada direta também respeitam
   * o flag pós-load.
   */
  feature_flag?: FeatureFlagName;
};

export type AnyTool = Tool<z.ZodTypeAny, z.ZodTypeAny>;

/**
 * P10a (review #104): `propose_*` tool names are kept here so we can
 * filter the registry view (`getToolSchemas`) and the dispatcher path
 * (`isToolEnabled`) by the runtime feature flag. The registry itself
 * holds all entries so the kill switch can be flipped on/off without a
 * redeploy; the runtime check decides whether the tool is exposed and
 * dispatched.
 */
const KSM_PROPOSE_TOOLS: ReadonlySet<string> = new Set([
  'propose_fact',
  'propose_rule',
  'propose_memory',
  'propose_hint',
]);

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
  // Spec 18 — Scheduling V2 tools (always enabled; backing workers run
  // unconditionally).
  schedule_reminder: scheduleReminderTool as unknown as AnyTool,
  cancel_reminder: cancelReminderTool as unknown as AnyTool,
  start_recurring_outreach: startRecurringOutreachTool as unknown as AnyTool,
  start_recurring_payment: startRecurringPaymentTool as unknown as AnyTool,
  send_proactive_message: sendProactiveMessageTool as unknown as AnyTool,
  compare_entities: compareEntitiesTool as unknown as AnyTool,
  recall_memory: recallMemoryTool as unknown as AnyTool,
  save_fact: saveFactTool as unknown as AnyTool,
  save_rule: saveRuleTool as unknown as AnyTool,
  // P10a — Knowledge State Machine `propose_*` tools. The harness
  // decides the initial lifecycle state (ephemeral / pending_review);
  // the LLM never writes directly to `active`.
  // Runtime feature-flag check in getToolSchemas + isToolEnabled keeps
  // them invisible/blocked when KNOWLEDGE_STATE_MACHINE_V1 is off (review
  // #104), so kill switches take effect without a redeploy.
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
  // Calendar v2 — read-only tools (sempre expostas; flag OFF retorna fallback
  // legacy só-nacionais sem quebrar).
  calendar_is_business_day: calendarIsBusinessDayTool as unknown as AnyTool,
  calendar_next_holiday: calendarNextHolidayTool as unknown as AnyTool,
  calendar_list_holidays: calendarListHolidaysTool as unknown as AnyTool,
  calendar_business_days_between: calendarBusinessDaysBetweenTool as unknown as AnyTool,
  calendar_add_business_days: calendarAddBusinessDaysTool as unknown as AnyTool,
  // Calendar v2 — write tools. Cada uma declara `feature_flag` para que o
  // gate seja avaliado em runtime (kill-switch funciona em processos já
  // carregados, schema exposto ao LLM sincroniza com o flag). Codex review
  // #105 medium.
  register_custom_holiday: registerCustomHolidayTool as unknown as AnyTool,
  approve_capability_proposal: approveCapabilityProposalTool as unknown as AnyTool,
  reject_capability_proposal: rejectCapabilityProposalTool as unknown as AnyTool,
  list_pending_proposals: listPendingProposalsTool as unknown as AnyTool,
};

/**
 * Tools whose presence in `REGISTRY` is gated by a CONFIG (env) flag via the
 * conditional spreads above — when the flag is OFF the entry is absent from
 * `REGISTRY` entirely, so `Object.values(REGISTRY)` would silently drop them.
 *
 * The Admin UI Tools Catalog must list EVERY tool (disabled-but-existing,
 * naming the flag that turns it on), so `buildToolCatalog()` re-adds these
 * from their direct definitions and computes `enabled` from the live config
 * flag. Co-located with the `REGISTRY` spreads above so the two never drift:
 * if you add/remove a config-gated tool there, update this list too.
 *
 * Note these are config-env flags, NOT `FeatureFlagName` enum members (unlike
 * the calendar tools, which declare `feature_flag` on the tool itself, and the
 * KSM `propose_*` tools, gated by `FeatureFlagName.KNOWLEDGE_STATE_MACHINE_V1`).
 * The `flag` strings below are the env var names operators flip.
 */
const CONFIG_GATED_TOOLS: ReadonlyArray<{
  tool: AnyTool;
  flag: string;
  enabled: boolean;
}> = [
  {
    tool: generateReportTool as unknown as AnyTool,
    flag: 'FEATURE_PDF_REPORTS',
    enabled: config.FEATURE_PDF_REPORTS,
  },
];

/**
 * Runtime-flag check used by both the schema exposure path
 * (getToolSchemas) and the dispatcher (`dispatchTool`). Tools may still
 * declare a `feature_flag` kill switch on their definition; when set, the
 * live FeatureFlags singleton decides exposure/dispatch without a
 * redeploy. Tools without a declared flag are always enabled.
 */
export function isToolEnabled(name: string): boolean {
  const tool = REGISTRY[name];
  if (tool?.feature_flag !== undefined) {
    return featureFlags.isEnabled(tool.feature_flag);
  }
  return true;
}

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
  // Codex review #105 (medium) + KSM: além do filtro de permissão, oculta tools
  // cujo feature_flag esteja desligado em runtime. Mantém schema exposto
  // ao LLM sincronizado com o gate do dispatcher. `isToolEnabled` honra
  // tanto KSM propose_* tools quanto o `feature_flag` declarado por tool.
  const tools = Object.values(REGISTRY).filter((t) => isToolEnabled(t.name));
  if (isOwner) return tools.map(toolToSchema);
  return tools
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

/**
 * A catalog entry: a tool plus its accurate runtime gating. `enabled` reflects
 * the live config/feature-flag state; `feature_flag` is the NAME of the flag
 * that gates it (null when ungated).
 */
export interface CatalogEntry {
  tool: AnyTool;
  enabled: boolean;
  /** The gating flag NAME (env var or FeatureFlagName value), or null. */
  feature_flag: string | null;
}

/**
 * Build the COMPLETE tool catalog for the Admin UI `/tools` screen.
 *
 * Unlike `Object.values(REGISTRY)`, this includes tools that are absent from
 * `REGISTRY` because their CONFIG flag is off (scheduling tools, generate_report)
 * — operators must see every tool that exists and which flag turns it on.
 *
 * Per entry it computes:
 *   - `enabled`: the real gating (config flag for config-gated tools,
 *     `isToolEnabled` — which honours declared `feature_flag` and the KSM
 *     `propose_*` flag — for everything else).
 *   - `feature_flag`: the NAME of the gating flag (env var name for
 *     config-gated tools; `FeatureFlagName` value for declared-flag and KSM
 *     tools), or null when the tool is ungated.
 *
 * Deduped by tool name (a config-gated tool present in `REGISTRY` because its
 * flag is currently on is not added twice). Stable, sorted by name so the UI
 * and tests don't depend on insertion order.
 */
export function buildToolCatalog(): CatalogEntry[] {
  const byName = new Map<string, CatalogEntry>();

  // 1. Everything currently in REGISTRY (flag-on tools + always-on tools).
  for (const tool of Object.values(REGISTRY)) {
    byName.set(tool.name, {
      tool,
      enabled: isToolEnabled(tool.name),
      feature_flag: gatingFlagName(tool),
    });
  }

  // 2. Config-gated tools that REGISTRY drops when their env flag is off.
  //    (If the flag is on they're already in REGISTRY via step 1; don't
  //    overwrite, but DO ensure the flag name is surfaced.)
  for (const { tool, flag, enabled } of CONFIG_GATED_TOOLS) {
    const existing = byName.get(tool.name);
    if (existing) {
      // Present because the flag is on — annotate the gating flag name so the
      // UI can still show "turns on via <flag>" semantics if it wants.
      existing.feature_flag = flag;
      existing.enabled = enabled;
    } else {
      byName.set(tool.name, { tool, enabled, feature_flag: flag });
    }
  }

  return Array.from(byName.values()).sort((a, b) =>
    a.tool.name.localeCompare(b.tool.name),
  );
}

/**
 * The NAME of the flag gating a tool already present in `REGISTRY`:
 *   - KSM `propose_*` tools → `FeatureFlagName.KNOWLEDGE_STATE_MACHINE_V1`.
 *   - tools that declare `feature_flag` (calendar write tools) → that value.
 *   - otherwise null (ungated, or config-gated tools handled separately).
 */
function gatingFlagName(tool: AnyTool): string | null {
  if (KSM_PROPOSE_TOOLS.has(tool.name)) {
    return FeatureFlagName.KNOWLEDGE_STATE_MACHINE_V1;
  }
  if (tool.feature_flag !== undefined) {
    return tool.feature_flag;
  }
  return null;
}
