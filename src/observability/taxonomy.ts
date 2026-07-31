/**
 * Issue #514 — canonical observability taxonomy.
 *
 * ONE place that names every span, every metric and every label the platform
 * is allowed to emit. Nothing here executes: it is the contract that
 * `labels.ts` enforces and that `metrics.ts` emitters consume. Keeping the
 * vocabulary declarative means a reviewer can audit the whole surface (and its
 * privacy posture) by reading a single file, and a dashboard/alert author has
 * a greppable source of truth for metric names.
 *
 * Privacy posture (issue #514 §6, non-negotiable):
 *   - Metric LABELS carry only bounded, enumerated, non-identifying dimensions.
 *   - High-cardinality correlation ids (trace/turn/conversa/message) live in
 *     LOGS and TRACES, never in labels.
 *   - Message content, phone numbers, JIDs, person names, URLs and raw error
 *     strings are forbidden everywhere in the metric surface.
 *
 * `tenant_id` + `agent_id` are the deliberate exception: AGENTS.md §4.1 makes
 * per-tenant attribution an invariant, and `governance-observability.md` §4.3
 * already standardised them on every counter. They are bounded by the number
 * of onboarded tenants, and `labels.ts` still caps their distinct-value count
 * so a runaway resolver bug degrades into an overflow bucket instead of
 * detonating the registry.
 */

// ============================================================================
// 1. Spans — the minimum turn tree (issue #514 §2)
// ============================================================================

/**
 * Canonical span names. The tree below is the *minimum* set the issue
 * requires; instrumentation may not invent names outside it without adding
 * them here first (that is what makes the taxonomy auditable).
 */
export const SPAN = {
  TURN: 'turn',
  INGRESS_NORMALIZE: 'ingress.normalize',
  INGRESS_PERSIST: 'ingress.persist',
  QUEUE_WAIT: 'queue.wait',
  IDENTITY_RESOLVE: 'identity.resolve',
  AUDIENCE_RESOLVE: 'audience.resolve',
  PRETURN_GRAPH: 'preturn.graph',
  ROLE_SELECT: 'role.select',
  PROCEDURE_SELECT: 'procedure.select',
  RISK_CLASSIFY: 'risk.classify',
  DECISION_EVALUATE: 'decision.evaluate',
  CONTEXT_LOAD: 'context.load',
  PROMPT_RENDER: 'prompt.render',
  REACT_ITERATION: 'react.iteration',
  LLM_REQUEST: 'llm.request',
  TOOL_DISPATCH: 'tool.dispatch',
  PERMISSION_CHECK: 'permission.check',
  CONSTITUTIONAL_CHECK: 'constitutional.check',
  IDEMPOTENCY_CLAIM: 'idempotency.claim',
  HANDLER_EXECUTE: 'handler.execute',
  OUTBOUND_COMMIT: 'outbound.commit',
  WHATSAPP_SEND: 'whatsapp.send',
  TURN_COMPLETE: 'turn.complete',
} as const;

export type SpanName = (typeof SPAN)[keyof typeof SPAN];

/**
 * Parent of each span, `null` for the root. Encodes the tree drawn in issue
 * #514 §2 so a test can assert the shape and an exporter can rebuild it.
 */
export const SPAN_PARENT: Readonly<Record<SpanName, SpanName | null>> = Object.freeze({
  [SPAN.TURN]: null,
  [SPAN.INGRESS_NORMALIZE]: SPAN.TURN,
  [SPAN.INGRESS_PERSIST]: SPAN.TURN,
  [SPAN.QUEUE_WAIT]: SPAN.TURN,
  [SPAN.IDENTITY_RESOLVE]: SPAN.TURN,
  [SPAN.AUDIENCE_RESOLVE]: SPAN.TURN,
  [SPAN.PRETURN_GRAPH]: SPAN.TURN,
  [SPAN.ROLE_SELECT]: SPAN.PRETURN_GRAPH,
  [SPAN.PROCEDURE_SELECT]: SPAN.PRETURN_GRAPH,
  [SPAN.RISK_CLASSIFY]: SPAN.PRETURN_GRAPH,
  [SPAN.DECISION_EVALUATE]: SPAN.TURN,
  [SPAN.CONTEXT_LOAD]: SPAN.TURN,
  [SPAN.PROMPT_RENDER]: SPAN.TURN,
  [SPAN.REACT_ITERATION]: SPAN.TURN,
  [SPAN.LLM_REQUEST]: SPAN.REACT_ITERATION,
  [SPAN.TOOL_DISPATCH]: SPAN.REACT_ITERATION,
  [SPAN.PERMISSION_CHECK]: SPAN.TOOL_DISPATCH,
  [SPAN.CONSTITUTIONAL_CHECK]: SPAN.TOOL_DISPATCH,
  [SPAN.IDEMPOTENCY_CLAIM]: SPAN.TOOL_DISPATCH,
  [SPAN.HANDLER_EXECUTE]: SPAN.TOOL_DISPATCH,
  [SPAN.OUTBOUND_COMMIT]: SPAN.TURN,
  [SPAN.WHATSAPP_SEND]: SPAN.TURN,
  [SPAN.TURN_COMPLETE]: SPAN.TURN,
});

export const SPAN_NAMES: readonly SpanName[] = Object.freeze(
  Object.values(SPAN) as SpanName[],
);

/** Terminal status of a span. Mirrors the metric `status` enum. */
export type SpanStatus = 'ok' | 'error' | 'blocked' | 'timeout' | 'cancelled';

// ============================================================================
// 2. Metrics — the minimum set (issue #514 §5)
// ============================================================================

/**
 * Every metric this issue introduces or standardises. Names follow the
 * existing `maia_*` convention (`src/lib/metrics.ts`); counters end in
 * `_total`, histograms in `_ms`/`_bytes`, gauges are bare nouns.
 */
export const METRIC = {
  // --- ingress / turn ------------------------------------------------------
  INBOUND_RECEIVED: 'maia_inbound_received_total',
  INBOUND_PERSISTED: 'maia_inbound_persisted_total',
  INBOUND_DEDUPLICATED: 'maia_inbound_deduplicated_total',
  INBOUND_REJECTED: 'maia_inbound_rejected_total',
  TURN_STARTED: 'maia_turn_started_total',
  TURN_COMPLETED: 'maia_turn_completed_total',
  TURN_RECOVERED: 'maia_turn_recovered_total',
  TURN_DURATION_MS: 'maia_turn_duration_ms',
  /** inbound persisted → turn reached a durable terminal state. */
  TURN_E2E_LATENCY_MS: 'maia_turn_e2e_latency_ms',
  /** inbound persisted → outbound handed to the provider. */
  TURN_DELIVERY_LATENCY_MS: 'maia_turn_delivery_latency_ms',
  STAGE_DURATION_MS: 'maia_turn_stage_duration_ms',

  // --- queue ---------------------------------------------------------------
  QUEUE_DEPTH: 'maia_queue_depth',
  QUEUE_OLDEST_JOB_AGE_MS: 'maia_queue_oldest_job_age_ms',
  QUEUE_WAIT_MS: 'maia_queue_wait_ms',
  QUEUE_JOB_ATTEMPTS: 'maia_queue_job_attempts_total',

  // --- context / db --------------------------------------------------------
  CONTEXT_LOAD_MS: 'maia_context_load_ms',
  DB_POOL: 'maia_db_pool',

  // --- llm -----------------------------------------------------------------
  LLM_CALLS: 'maia_llm_calls_total',
  LLM_TOKENS: 'maia_llm_tokens_total',
  LLM_LATENCY_MS: 'maia_llm_latency_ms',

  // --- tools ---------------------------------------------------------------
  TOOL_DISPATCH: 'maia_tool_dispatch_total',
  TOOL_DURATION_MS: 'maia_tool_duration_ms',

  // --- whatsapp / outbound -------------------------------------------------
  OUTBOUND_COMMITTED: 'maia_outbound_committed_total',
  OUTBOUND_SEND: 'maia_outbound_send_total',
  OUTBOUND_SEND_MS: 'maia_outbound_send_ms',
  WHATSAPP_SESSIONS: 'maia_whatsapp_sessions',

  // --- workers / schedulers ------------------------------------------------
  WORKER_RUN: 'maia_worker_run_total',
  WORKER_DURATION_MS: 'maia_worker_duration_ms',

  // --- onboarding (issue #519) ---------------------------------------------
  // Nomes com o prefixo `maia_` por convenção deste arquivo; a issue os lista
  // sem prefixo. Rótulos deliberadamente FECHADOS: `kind` e `step` vêm de
  // enums do `state-machine.ts`, `reason` do enum de códigos sanitizados e
  // `check_code` do enum de readiness. Run id, tenant nome, e-mail e telefone
  // NUNCA entram — a issue §"Observabilidade" é explícita.
  ONBOARDING_RUN_STARTED: 'maia_onboarding_run_started_total',
  ONBOARDING_RUN_COMPLETED: 'maia_onboarding_run_completed_total',
  ONBOARDING_RUN_CANCELLED: 'maia_onboarding_run_cancelled_total',
  ONBOARDING_RUN_DURATION_MS: 'maia_onboarding_run_duration_ms',
  ONBOARDING_STEP_COMPLETED: 'maia_onboarding_step_completed_total',
  ONBOARDING_STEP_FAILED: 'maia_onboarding_step_failed_total',
  ONBOARDING_STEP_DURATION_MS: 'maia_onboarding_step_duration_ms',
  ONBOARDING_IDEMPOTENCY_REPLAY: 'maia_onboarding_idempotency_replay_total',
  AGENT_READINESS_EVALUATED: 'maia_agent_readiness_evaluated_total',
  AGENT_READINESS_FAILED: 'maia_agent_readiness_failed_total',
  BOOTSTRAP_ATTEMPT: 'maia_bootstrap_attempt_total',

  // --- observability self-health ------------------------------------------
  /** Envelope coverage of the hot path — the §4 "measure coverage" ask. */
  TRACE_COVERAGE: 'maia_runtime_trace_coverage_total',
  /** A label set was rejected/repaired by the sanitizer. */
  LABEL_REJECTED: 'maia_metric_label_rejected_total',
  /** A label value exceeded its cardinality budget and fell into overflow. */
  LABEL_CARDINALITY_OVERFLOW: 'maia_metric_label_cardinality_overflow_total',
} as const;

export type MetricName = (typeof METRIC)[keyof typeof METRIC];

export const METRIC_NAMES: readonly MetricName[] = Object.freeze(
  Object.values(METRIC) as MetricName[],
);

// ============================================================================
// 3. Label policy (issue #514 §6)
// ============================================================================

/**
 * The ONLY label keys any `maia_*` metric may carry.
 *
 * Adding a key here is a reviewed decision: it must be enumerable (a closed
 * set of values) and non-identifying. When in doubt, put the dimension in the
 * log line or the trace, not in the label.
 */
export const ALLOWED_LABEL_KEYS: ReadonlySet<string> = new Set([
  // tenant attribution — AGENTS.md §4.1 invariant
  'tenant_id',
  'agent_id',
  // llm
  'provider',
  'model',
  'tier',
  'workload',
  'kind',
  // tools / skills
  'tool',
  'skill',
  // outcome vocabulary
  'status',
  'result',
  'reason',
  'outcome',
  'decision',
  'severity',
  'side_effect_level',
  'redaction_class',
  // topology
  'worker',
  'job',
  'queue',
  'stage',
  'span',
  'channel_kind',
  'direction',
  'origin',
  'operation',
  'field',
  'action',
  'metric',
  'phase',
  'state',
  'required',
  // onboarding (issue #519) — os dois vêm de enums fechados
  // (`ONBOARDING_STEPS` e `READINESS_CHECK_CODES`), então são enumeráveis e
  // não-identificantes por construção.
  'step',
  'check_code',
]);

/**
 * Keys that are ALWAYS rejected, even if someone adds them to the allowlist by
 * accident — the deny list wins. These are either direct PII, free text, or
 * unbounded-cardinality correlation ids that belong in traces/logs.
 *
 * Matching is by normalised key (lowercase); `labels.ts` also rejects any key
 * that *contains* one of `FORBIDDEN_KEY_SUBSTRINGS` so `sender_phone`,
 * `remote_jid` and `customer_email` are caught without enumerating variants.
 */
export const FORBIDDEN_LABEL_KEYS: ReadonlySet<string> = new Set([
  'phone',
  'telefone',
  'msisdn',
  'jid',
  'remote_jid',
  'pessoa',
  'pessoa_id',
  'person',
  'user',
  'user_id',
  'pushname',
  'name',
  'nome',
  'email',
  'conversa',
  'conversa_id',
  'conversation_id',
  'session_id',
  'mensagem',
  'mensagem_id',
  'message',
  'message_id',
  'whatsapp_id',
  'trace_id',
  'traceid',
  'turno_id',
  'turn_id',
  'span_id',
  'attempt_id',
  'request_id',
  'correlation_id',
  'job_id',
  'payload',
  'body',
  'content',
  'text',
  'caption',
  'transcription',
  'prompt',
  'response',
  'url',
  'uri',
  'path',
  'err',
  'error',
  'error_message',
  'exception',
  'stack',
  'token',
  'secret',
  'api_key',
  'authorization',
  'password',
]);

/**
 * Substring guards. A key containing any of these is rejected regardless of
 * the allowlist — this is what stops a well-meaning caller from smuggling
 * `tool_error_message` or `customer_phone_number` past the enumeration.
 *
 * Note the deliberate omissions: `_id` is NOT a substring guard because
 * `tenant_id`/`agent_id` are sanctioned, and those two are enumerated on the
 * allowlist explicitly.
 */
export const FORBIDDEN_KEY_SUBSTRINGS: readonly string[] = Object.freeze([
  'phone',
  'telefone',
  'jid',
  'email',
  'secret',
  'token',
  'password',
  'apikey',
  'api_key',
  'credential',
  'payload',
  'message',
  'mensagem',
  'content',
  'prompt',
  'transcript',
  'trace_id',
  'span_id',
  'conversa',
  'conversation',
  'pessoa',
  'username',
  'user_id',
]);

/**
 * Enumerated value vocabularies. `labels.ts` does not force a value to be a
 * member (that would make instrumenting new states a two-file change), but
 * tests assert the emitters only use these, and dashboards are written
 * against them.
 */
export const ENUM_VALUES = Object.freeze({
  status: ['ok', 'error', 'blocked', 'timeout', 'cancelled', 'skipped'] as const,
  outcome: [
    'completed',
    'retryable',
    'failed',
    'blocked',
    'escalated',
    'recovered',
    'duplicate',
    'unknown',
  ] as const,
  direction: ['inbound', 'outbound'] as const,
  channel_kind: ['whatsapp', 'internal', 'playground', 'probe'] as const,
  origin: ['ingress', 'queue', 'recovery', 'replay', 'probe', 'internal'] as const,
  required: ['true', 'false'] as const,
});

/**
 * Per-label cardinality budget. Once a (metric, key) pair has seen this many
 * distinct values, further values collapse into `CARDINALITY_OVERFLOW_VALUE`
 * and `METRIC.LABEL_CARDINALITY_OVERFLOW` increments — the registry degrades
 * instead of exploding (issue #514 "Rollback: se cardinalidade explodir").
 */
export const LABEL_CARDINALITY_BUDGET: Readonly<Record<string, number>> = Object.freeze({
  tenant_id: 500,
  agent_id: 2000,
  model: 50,
  tool: 200,
  skill: 200,
  queue: 20,
  worker: 100,
  job: 100,
  stage: 60,
  span: 60,
  reason: 60,
  // Enums fechados do onboarding (#519): 11 passos, 14 códigos de check.
  step: 20,
  check_code: 30,
});

/** Budget applied to any allowed key without an explicit entry above. */
export const DEFAULT_LABEL_CARDINALITY_BUDGET = 30;

/** Replacement value once a label blows its cardinality budget. */
export const CARDINALITY_OVERFLOW_VALUE = '__overflow__';

/** Replacement value when a value fails the shape/PII guard. */
export const SANITIZED_VALUE = '__sanitized__';

/** Max characters kept for any label value. */
export const MAX_LABEL_VALUE_LENGTH = 64;
