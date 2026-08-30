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
import { setInterlocutorTimezoneTool } from './set-interlocutor-timezone.js';
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
// Issue #509 — canonical Zod → JSON Schema conversion for the model-facing
// exposure surfaces. Zod stays the AUTHORITY in `_dispatcher.ts`; this only
// changes what the model is TOLD.
import { buildToolSchema, schemaHash } from './schema-json.js';
import { observeHistogram } from '@/lib/metrics.js';
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
// Issue #410 — baseline.core tools. Conservative, no-domain-side-effect
// capabilities every runtime agent gets by default (see src/tools/packs.ts).
import { readTurnContextTool } from './read-turn-context.js';
import { rememberSafeFactTool } from './remember-safe-fact.js';
import { requestConfirmationTool } from './request-confirmation.js';
import { handoffToOwnerTool } from './handoff-to-owner.js';
import { auditDecisionTool } from './audit-decision.js';
import { explainLimitationTool } from './explain-limitation.js';
// Issue #416 — boleto proposal vertical tools (catalog entries; grouped into
// packs in src/tools/grant-math.ts, governed by write/risk policies in
// migration 078). The three write tools (boleto_cancel, company_campaign_remove,
// refund_create) are side_effect:'write' and flow through the dispatcher guard.
import { companyIdentityResolverTool } from './company-identity-resolver.js';
import { companySearchTool } from './company-search.js';
import { companyHistoryLookupTool } from './company-history-lookup.js';
import { companyBlacklistCheckTool } from './company-blacklist-check.js';
import { boletoSearchTool } from './boleto-search.js';
import { boletoCancelTool } from './boleto-cancel.js';
import { ddaLookupTool } from './dda-lookup.js';
import { paymentVerificationTool } from './payment-verification.js';
import { campaignStatusLookupTool } from './campaign-status-lookup.js';
import { companyCampaignRemoveTool } from './company-campaign-remove.js';
import { conversationAttachmentLookupTool } from './conversation-attachment-lookup.js';
import { receiptValidateTool } from './receipt-validate.js';
import { bankAccountValidateTool } from './bank-account-validate.js';
import { refundCreateTool } from './refund-create.js';
import { refundLookupTool } from './refund-lookup.js';
import { conversationSummaryGenerateTool } from './conversation-summary-generate.js';
import { legalIntentDetectTool } from './legal-intent-detect.js';
import { caseRiskClassifyTool } from './case-risk-classify.js';
import { operationalTicketCreateTool } from './operational-ticket-create.js';
// Issue #433 — baseline.core gap tools (the 3 genuine gaps; the 7 above already
// existed). Reuse the shared risk scorer + the extracted summarizeTranscript
// helper; no parallel risk/summary/state engines.
import { riskSignalClassifyTool } from './risk-signal-classify.js';
import { conversationSummaryComposeTool } from './conversation-summary-compose.js';
import { conversationStateUpdateTool } from './conversation-state-update.js';
// Issue #507 — classificação de efeito. O vocabulário e o validador que RECUSA
// uma definição incompleta vivem num módulo folha (sem imports), porque é este
// arquivo que o chama.
import {
  assertToolDefinitionsComplete,
  type ToolEffectClass,
} from './effect-class.js';

/**
 * Issue #504 §Fencing — a TENTATIVA do turno, entregue ao handler.
 *
 * Um handler que faz várias gravações (ou uma chamada externa longa) precisa de
 * duas coisas que o `ToolContext` não carregava: `signal`, para COOPERAR com o
 * cancelamento em vez de terminar um trabalho que ninguém mais aceita, e
 * `claim_token`, para VALIDAR a tentativa — é o mesmo fence que `agent_turns`
 * exige em toda gravação da tentativa, e sem ele uma mutação interna não tem
 * como se recusar a gravar por conta própria.
 *
 * `null` no `ToolHandlerCtx.turn` quando não há turno reivindicado
 * (`FEATURE_TURN_CLAIM` OFF, worker de agenda, playground, testes) — o mesmo
 * regime no-op dos guards de `runtime/turns/execution-context.ts`.
 */
export type ToolTurnContext = {
  turn_id: string;
  attempt: number;
  claim_token: string;
  deadline: Date;
  signal: AbortSignal;
};

export type ToolHandlerCtx = {
  pessoa: import('@/db/schema.js').Pessoa;
  scope: { entidades: string[]; byEntity: Map<string, ResolvedPermission> };
  conversa: import('@/db/schema.js').Conversa;
  mensagem_id: string;
  request_id: string;
  idempotency_key: string;
  /** Issue #504 §Fencing — ver `ToolTurnContext`. */
  turn: ToolTurnContext | null;
};

export type Tool<I extends z.ZodTypeAny, O extends z.ZodTypeAny> = {
  name: string;
  description: string;
  input_schema: I;
  output_schema: O;
  required_actions: ReadonlyArray<ActionKey>;
  side_effect: 'none' | 'read' | 'write' | 'communication';
  /**
   * Issue #507 §Tools — a SEMÂNTICA DE CANCELAMENTO desta ferramenta. Campo
   * OBRIGATÓRIO: sem ele o dispatcher não tem como responder honestamente a um
   * cancelamento que chegou depois de o handler poder ter causado efeito, e o
   * padrão seria um palpite (ou "cancelado", que afirma ausência de efeito, ou
   * "erro", que convida a um retry duplicador).
   *
   * O que cada classe significa, e por que a escolha não é derivável do
   * `side_effect`, está em `src/tools/effect-class.ts`. Quem checa é
   * `assertToolDefinitionsComplete`, no carregamento deste módulo: uma
   * ferramenta sem classificação NÃO SOBE.
   */
  effect_class: ToolEffectClass;
  /**
   * Issue #507 — a ferramenta que DESFAZ esta. Obrigatório quando
   * `effect_class: 'compensatable'`, proibido nos outros casos, e o nome tem de
   * existir no `REGISTRY` — uma compensação declarada sem compensador seria
   * exatamente a promessa vazia que a classificação existe para impedir.
   */
  compensated_by?: string;
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
  set_interlocutor_timezone: setInterlocutorTimezoneTool as unknown as AnyTool,
  start_recurring_outreach: startRecurringOutreachTool as unknown as AnyTool,
  start_recurring_payment: startRecurringPaymentTool as unknown as AnyTool,
  send_proactive_message: sendProactiveMessageTool as unknown as AnyTool,
  compare_entities: compareEntitiesTool as unknown as AnyTool,
  recall_memory: recallMemoryTool as unknown as AnyTool,
  save_fact: saveFactTool as unknown as AnyTool,
  save_rule: saveRuleTool as unknown as AnyTool,
  // P10a — Knowledge State Machine `propose_*` tools. The harness
  // decides the initial lifecycle state (ephemeral / pending_review);
  // the LLM never writes directly to `active`. PR #406: KSM collapsed to
  // always-on — the KNOWLEDGE_STATE_MACHINE_V1 flag was removed, so these are
  // UNCONDITIONALLY exposed and dispatched (ungated in the catalog).
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
  // Calendar v2 — write tools. PR #406: CALENDAR_V2 collapsed to always-on
  // (the FeatureFlagName enum entry + env field were removed), so these no
  // longer declare a `feature_flag` and are UNCONDITIONALLY enabled.
  register_custom_holiday: registerCustomHolidayTool as unknown as AnyTool,
  approve_capability_proposal: approveCapabilityProposalTool as unknown as AnyTool,
  reject_capability_proposal: rejectCapabilityProposalTool as unknown as AnyTool,
  list_pending_proposals: listPendingProposalsTool as unknown as AnyTool,
  // Issue #410 — baseline.core tools. Always registered (no feature flag): they
  // are the minimal, conservative capability floor for every runtime agent.
  // `recall_memory` (above) is also part of baseline.core — reused, not
  // re-added. The pack ↔ registry contract lives in src/tools/packs.ts.
  read_turn_context: readTurnContextTool as unknown as AnyTool,
  remember_safe_fact: rememberSafeFactTool as unknown as AnyTool,
  request_confirmation: requestConfirmationTool as unknown as AnyTool,
  handoff_to_owner: handoffToOwnerTool as unknown as AnyTool,
  audit_decision: auditDecisionTool as unknown as AnyTool,
  explain_limitation: explainLimitationTool as unknown as AnyTool,
  // Issue #416 — boleto proposal vertical. Always registered (no feature flag);
  // visibility is governed by the #408 pack/grant chain + the #416 write/risk
  // policies, NOT by presence in the registry. The three write tools pass the
  // existing dispatcher guard + constitutionalCheck like any other write.
  company_identity_resolver: companyIdentityResolverTool as unknown as AnyTool,
  company_search: companySearchTool as unknown as AnyTool,
  company_history_lookup: companyHistoryLookupTool as unknown as AnyTool,
  company_blacklist_check: companyBlacklistCheckTool as unknown as AnyTool,
  boleto_search: boletoSearchTool as unknown as AnyTool,
  boleto_cancel: boletoCancelTool as unknown as AnyTool,
  dda_lookup: ddaLookupTool as unknown as AnyTool,
  payment_verification: paymentVerificationTool as unknown as AnyTool,
  campaign_status_lookup: campaignStatusLookupTool as unknown as AnyTool,
  company_campaign_remove: companyCampaignRemoveTool as unknown as AnyTool,
  conversation_attachment_lookup: conversationAttachmentLookupTool as unknown as AnyTool,
  receipt_validate: receiptValidateTool as unknown as AnyTool,
  bank_account_validate: bankAccountValidateTool as unknown as AnyTool,
  refund_create: refundCreateTool as unknown as AnyTool,
  refund_lookup: refundLookupTool as unknown as AnyTool,
  conversation_summary_generate: conversationSummaryGenerateTool as unknown as AnyTool,
  legal_intent_detect: legalIntentDetectTool as unknown as AnyTool,
  case_risk_classify: caseRiskClassifyTool as unknown as AnyTool,
  operational_ticket_create: operationalTicketCreateTool as unknown as AnyTool,
  // Issue #433 — the 3 baseline.core gap tools. `risk_signal_classify` +
  // `conversation_summary_compose` are parse_only (side_effect none);
  // `conversation_state_update` is the second baseline write (allowlisted in
  // packs.ts).
  risk_signal_classify: riskSignalClassifyTool as unknown as AnyTool,
  conversation_summary_compose: conversationSummaryComposeTool as unknown as AnyTool,
  conversation_state_update: conversationStateUpdateTool as unknown as AnyTool,
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
 * These are config-env flag NAMES (the env vars operators flip), NOT
 * `FeatureFlagName` enum members. PR #406 collapsed the last `FeatureFlagName`-
 * gated tools (calendar / KSM `propose_*`) to always-on, so `generate_report`
 * (the PRODUCT-gated PDF tool) is the only config-gated entry that remains.
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
 * Issue #507 §Tools — O PORTÃO DA CLASSIFICAÇÃO, executado no carregamento
 * deste módulo.
 *
 * Não é lint e não é aviso: uma ferramenta sem `effect_class` (ou com uma
 * classificação que contradiz o próprio `side_effect`, ou `compensatable` sem
 * compensador que exista) faz o import deste módulo LANÇAR — e como o registro
 * é importado por todo caminho que despacha tool, o processo não sobe. É isso
 * que garante que a próxima ferramenta, escrita daqui a meses por quem nunca
 * leu a #507, não nasça sem classificação.
 *
 * O universo validado inclui os tools GATED POR CONFIG (`CONFIG_GATED_TOOLS`),
 * que somem do `REGISTRY` quando o flag está desligado: uma ferramenta não pode
 * escapar da checagem por estar desligada hoje — ela liga amanhã.
 *
 * O conjunto de nomes conhecidos (para validar `compensated_by`) é o mesmo
 * universo, pela mesma razão.
 */
const ALL_DEFINED_TOOLS: readonly AnyTool[] = [
  ...Object.values(REGISTRY),
  ...CONFIG_GATED_TOOLS.map((e) => e.tool),
];

assertToolDefinitionsComplete(
  ALL_DEFINED_TOOLS,
  new Set(ALL_DEFINED_TOOLS.map((t) => t.name)),
);

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
  // Codex review #105 (medium): além do filtro de permissão, oculta tools
  // cujo `feature_flag` declarado esteja desligado em runtime. Mantém o schema
  // exposto ao LLM sincronizado com o gate do dispatcher.
  const tools = Object.values(REGISTRY).filter((t) => isToolEnabled(t.name));
  if (isOwner) return tools.flatMap(toolToSchema);
  return tools
    .filter((t) => t.required_actions.every((a) => allowed.has(a)))
    .flatMap(toolToSchema);
}

/**
 * Issue #408 — the AGENT-grant-aware sibling of `getToolSchemas`.
 *
 * `getToolSchemas` filters the registry by the HUMAN permission + feature flag
 * only. `getAgentToolSchemas` ADDS the AGENT-grant ∩ skill-scope filter BEFORE
 * those — it is the Runtime Tool Filter projected onto the registry view.
 *
 * `visibleToolNames` is the precomputed agent-grant ∩ skill-scope set
 * (`computeAgentVisibleTools(...).visible` from `src/tools/packs.ts`). It is
 * passed in (NOT imported) so this module stays free of the `packs.ts` import
 * — `packs.ts` imports `_registry.ts`, so importing it back would cycle.
 *
 * Filter order (all ADDITIVE — none replaces the existing guards):
 *   1. agent grant ∩ skill scope  — the tool name must be in `visibleToolNames`.
 *   2. feature flag               — `isToolEnabled` (kill switch).
 *   3. human permission           — owner sees all; else `required_actions ⊆ allowed`.
 * The dispatcher's `tool_not_granted` + `canAct` guards revalidate (1) and (3)
 * server-side, so a leaked tool still cannot execute (invariant #5).
 *
 * Fail-closed: a tool not in `visibleToolNames` is invisible. An empty set
 * yields zero tools (the caller is responsible for unioning in `baseline.core`
 * via `computeAgentVisibleTools`, which always does).
 */
export function getAgentToolSchemas(
  visibleToolNames: ReadonlySet<string> | readonly string[],
  byEntity: Map<string, ResolvedPermission>,
) {
  const visible =
    visibleToolNames instanceof Set
      ? visibleToolNames
      : new Set(visibleToolNames as readonly string[]);

  const allowed = new Set<string>();
  let isOwner = false;
  for (const rp of byEntity.values()) {
    if (rp.profile.acoes.includes('*')) {
      isOwner = true;
      break;
    }
    for (const a of rp.profile.acoes) allowed.add(a);
  }

  const tools = Object.values(REGISTRY).filter(
    (t) => visible.has(t.name) && isToolEnabled(t.name),
  );
  if (isOwner) return tools.flatMap(toolToSchema);
  return tools
    .filter((t) => t.required_actions.every((a) => allowed.has(a)))
    .flatMap(toolToSchema);
}

/**
 * The EXACT payload shape a provider accepts for a tool definition. Anthropic
 * and OpenAI/OpenRouter both reject unknown keys here, so schema metadata
 * (hash, bytes) travels via `describeExposedSchemas`, never on the wire.
 */
export type ExposedToolSchema = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

/**
 * Issue #509 — the ROLLBACK payload. Before #509 every tool was described to
 * the model with this stub, which told it nothing: no field names, no required
 * set, no enums, no bounds. Kept ONLY so `FEATURE_STRICT_TOOL_SCHEMAS=false`
 * can restore the previous behaviour without a redeploy; delete it together
 * with the flag (see `src/config/env.ts` FEATURE_STRICT_TOOL_SCHEMAS).
 */
const LEGACY_GENERIC_INPUT_SCHEMA = { type: 'object' as const, additionalProperties: true };

/**
 * Issue #509 — map a registry tool to the payload the model receives.
 *
 * Returns an ARRAY so callers can `flatMap`: a tool whose Zod contract cannot
 * be converted exactly yields `[]` and is DROPPED from the exposed set. That is
 * the fail-closed direction — an undescribable tool becomes invisible to the
 * model instead of being advertised with a permissive stub. The dispatcher's
 * grant / permission / limit / approval gates are unaffected either way, and
 * the catalog lint test converts every registered tool so a conversion failure
 * fails CI long before it could shrink the runtime catalog.
 */
function toolToSchema(t: AnyTool): ExposedToolSchema[] {
  if (!config.FEATURE_STRICT_TOOL_SCHEMAS) {
    return [{ name: t.name, description: t.description, input_schema: LEGACY_GENERIC_INPUT_SCHEMA }];
  }
  const built = buildToolSchema(t);
  if (!built) return [];
  return [{ name: built.name, description: built.description, input_schema: built.input_schema }];
}

/**
 * Resolves tool schemas from the registry by name, skipping unknowns and
 * feature-flag-disabled tools. Used by the `tool_mediated` executor to build
 * the tools list from `skill.allowed_tools` without duplicating schemas in SQL.
 */
export function getToolSchemasByName(names: readonly string[]): ExposedToolSchema[] {
  return names
    .map((name) => REGISTRY[name])
    .filter((t): t is AnyTool => t !== undefined && isToolEnabled(t.name))
    .flatMap(toolToSchema);
}

/**
 * Issue #509 §7 — schema budget + trace identity for a VISIBLE SET.
 *
 * Returns the per-tool contract hashes, their total byte size and a
 * set-level hash that is INDEPENDENT of the order the names arrive in, so the
 * same visible set always traces the same value. Unknown / unconvertible names
 * are skipped (fail-closed, never throws — diagnostics must not break a turn).
 *
 * Emits `maia_tool_schema_bytes{surface}` with a bounded `surface` label
 * (never `agent_id`/`tenant_id`, which would be unbounded cardinality; the
 * per-turn attribution lives in the `tool_visibility_resolved` audit row).
 *
 * The budget is a DIAGNOSTIC: nothing here truncates the tool set. Reducing a
 * set must happen through grants / role scope / skill scope / Decision Engine,
 * where it stays auditable.
 */
export function describeExposedSchemas(
  names: readonly string[],
  surface: string,
): { tools: number; bytes: number; set_hash: string; hashes: Record<string, string> } {
  const hashes: Record<string, string> = {};
  let bytes = 0;
  for (const name of names) {
    const tool = REGISTRY[name];
    if (!tool) continue;
    const built = buildToolSchema(tool);
    if (!built) continue;
    hashes[name] = built.schema_hash;
    bytes += built.bytes;
  }
  const tools = Object.keys(hashes).length;
  observeHistogram('maia_tool_schema_bytes', bytes, { surface });
  return { tools, bytes, set_hash: schemaHash(hashes), hashes };
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
 * `REGISTRY` because their CONFIG flag is off (currently only `generate_report`,
 * gated by `FEATURE_PDF_REPORTS`) — operators must see every tool that exists
 * and which flag turns it on.
 *
 * Per entry it computes:
 *   - `enabled`: the real gating (config flag for config-gated tools,
 *     `isToolEnabled` — which honours a declared `feature_flag` kill switch —
 *     for everything else).
 *   - `feature_flag`: the NAME of the gating flag (env var name for
 *     config-gated tools; the declared `feature_flag` value otherwise), or null
 *     when the tool is ungated (PR #406 left KSM/calendar/scheduling ungated).
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
 *   - tools that declare a `feature_flag` kill switch → that value.
 *   - otherwise null (ungated, or config-gated tools handled separately).
 *
 * PR #406 — admin-ui teardown completion: the KSM `propose_*`, calendar and
 * scheduling tools collapsed to UNCONDITIONALLY enabled. Their `FeatureFlagName`
 * enum entries (and the orphan `FEATURE_*` env fields) were removed, so the
 * catalog must report them as UNGATED (`feature_flag: null`) — surfacing a dead
 * flag NAME made the admin-ui treat live tools as disabled and reject them as
 * `disabled_tools_not_allowed` in skill authoring. The only tool still reporting
 * a gating flag here is the PRODUCT-gated `generate_report`
 * (→ 'FEATURE_PDF_REPORTS'), handled via `CONFIG_GATED_TOOLS`.
 */
function gatingFlagName(tool: AnyTool): string | null {
  if (tool.feature_flag !== undefined) {
    return tool.feature_flag;
  }
  return null;
}
