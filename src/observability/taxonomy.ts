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

/**
 * Issue #535 §1 — is this span actually EMITTED, or only declared?
 *
 * The whole complaint the issue opens with is that "quem ler
 * `src/observability/taxonomy.ts` pode concluir que a cobertura é maior do que
 * é". A declaration that nothing emits reads exactly like coverage. Rather
 * than deleting the roadmap (the tree IS the target shape, and every name in
 * it is referenced by the SLI narrative), the gap is made MACHINE-CHECKABLE:
 * each span declares whether PRODUCTION REACHES IT, and
 * `tests/unit/observability/tracer.spec.ts` pins the `emitted` set exactly.
 *
 * So the file can no longer overstate coverage: adding a name here without a
 * production-reachable emitter fails a test, and shipping a reachable emitter
 * without flipping the flag fails the same test.
 *
 * Current emitters:
 *   - `turn`, `queue.wait` → `src/gateway/queue.ts` (BullMQ agent worker)
 *   - `tool.dispatch`      → `src/tools/_dispatcher.ts` via
 *                            `observability/instrumentation.ts`
 *   - `context.load`       → `src/agent/turn-context/loader.ts`
 *                            (`loadTurnContext`) via the same wrapper
 *
 * `emitted` means "production reaches this span", NOT "an instrumentation site
 * exists in the tree". The two came apart on `context.load` and the review of
 * PR #554 settled it in favour of the stricter reading, for the reason that
 * decides it: this table is read as a coverage answer. A span no production
 * path reaches produces nothing, and a value that says otherwise turns the
 * table into the thing it exists to prevent. Do not weaken this back to
 * "a site exists" — that reading is what let the table claim coverage for a
 * span no turn could open.
 *
 * `context.load` is the case that forced the definition, and it is now
 * `emitted` under it. The #535 gate-6 site sat on `buildContextPacket`, the
 * P8a assembly orchestrator, whose hot path PR #406 deleted
 * (`FEATURE_CONTEXT_PACKET_V1`): no turn reached it. The wrapper moved to the
 * carga de contexto the turn actually runs — `loadTurnContext`
 * (`src/agent/turn-context/loader.ts`, issue #525), reached from
 * `buildPrompt` → `src/agent/core.ts` → the BullMQ agent worker — and
 * `tests/integration/context-load-span-hot-path.spec.ts` drives the REAL turn
 * entry point (`runAgentForMensagem`) to prove the span appears. The span is
 * the only thing that wrapper emits: duration and round-trips for this same
 * operation are already published by `recordTurnContextLoad`
 * (`maia_turn_context_load_duration_ms` / `maia_turn_context_db_queries`), and
 * two metric families measuring one operation is the drift this taxonomy
 * exists to prevent.
 */
export type SpanEmission = 'emitted' | 'declared';

export const SPAN_EMISSION: Readonly<Record<SpanName, SpanEmission>> = Object.freeze({
  [SPAN.TURN]: 'emitted',
  [SPAN.INGRESS_NORMALIZE]: 'declared',
  [SPAN.INGRESS_PERSIST]: 'declared',
  [SPAN.QUEUE_WAIT]: 'emitted',
  [SPAN.IDENTITY_RESOLVE]: 'declared',
  [SPAN.AUDIENCE_RESOLVE]: 'declared',
  [SPAN.PRETURN_GRAPH]: 'declared',
  [SPAN.ROLE_SELECT]: 'declared',
  [SPAN.PROCEDURE_SELECT]: 'declared',
  [SPAN.RISK_CLASSIFY]: 'declared',
  [SPAN.DECISION_EVALUATE]: 'declared',
  [SPAN.CONTEXT_LOAD]: 'emitted',
  [SPAN.PROMPT_RENDER]: 'declared',
  [SPAN.REACT_ITERATION]: 'declared',
  [SPAN.LLM_REQUEST]: 'declared',
  [SPAN.TOOL_DISPATCH]: 'emitted',
  [SPAN.PERMISSION_CHECK]: 'declared',
  [SPAN.CONSTITUTIONAL_CHECK]: 'declared',
  [SPAN.IDEMPOTENCY_CLAIM]: 'declared',
  [SPAN.HANDLER_EXECUTE]: 'declared',
  [SPAN.OUTBOUND_COMMIT]: 'declared',
  [SPAN.WHATSAPP_SEND]: 'declared',
  [SPAN.TURN_COMPLETE]: 'declared',
});

/**
 * The spans PRODUCTION REACHES today — not the spans an instrumentation site
 * exists for. `context.load` is why the distinction is spelled out: under the
 * looser reading it counted as covered for months while sitting on a code path
 * PR #406 had deleted. See `SPAN_EMISSION`.
 */
export const EMITTED_SPANS: readonly SpanName[] = Object.freeze(
  SPAN_NAMES.filter((s) => SPAN_EMISSION[s] === 'emitted'),
);

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
  //
  // `maia_context_load_ms` and `maia_context_slices_total` lived here until the
  // review of PR #554. They were declared for the P8a packet assembly, whose
  // hot path PR #406 deleted, and the turn's real carga de contexto has
  // measured itself since #525 through `maia_turn_context_load_duration_ms` +
  // `maia_turn_context_db_queries` (`src/agent/turn-context/metrics.ts`).
  // Keeping both would have been two families for ONE operation, so the orphan
  // pair was retired rather than repointed. The span `context.load` survives —
  // a span is a position in the waterfall, not a duplicate series.
  /**
   * pg pool saturation, `state` ∈ total|idle|waiting|max (issue #535 §2).
   * `waiting` climbing while `idle` is 0 IS the saturation incident.
   */
  DB_POOL: 'maia_db_pool',

  // --- scheduler (issue #535 §2) ------------------------------------------
  /** How late the oldest DUE-but-unclaimed unit of work is, per `queue`. */
  SCHEDULER_LAG_MS: 'maia_scheduler_lag_ms',
  /** How many units of work are due and still unclaimed, per `queue`. */
  SCHEDULER_BACKLOG: 'maia_scheduler_backlog',

  // --- llm -----------------------------------------------------------------
  LLM_CALLS: 'maia_llm_calls_total',
  LLM_TOKENS: 'maia_llm_tokens_total',
  LLM_LATENCY_MS: 'maia_llm_latency_ms',
  /**
   * Circuit-breaker state per `(provider, workload)`, `state` ∈
   * closed|half_open|open (issue #534). Exactly one series is 1 — same shape as
   * `LIFECYCLE_STATE` and `WHATSAPP_SESSIONS`, and for the same reason: a
   * single gauge encoding 0/1/2 cannot be read in PromQL without a legend, and
   * makes "never exercised" indistinguishable from "closed".
   *
   * No `tenant_id`/`agent_id`: the breaker measures the health of a shared
   * external dependency, not tenant data. Attribution of each *refusal* lives
   * on `LLM_CALLS{status="circuit_open"}`, which is tenant-scoped.
   */
  LLM_CIRCUIT_STATE: 'maia_llm_circuit_state',
  /** Breaker state changes. `state` is the state entered; `reason` is why. */
  LLM_CIRCUIT_TRANSITIONS: 'maia_llm_circuit_transitions_total',
  /** Calls refused by an open/half-open breaker, i.e. load actually shed. */
  LLM_CIRCUIT_SHORT_CIRCUITED: 'maia_llm_circuit_short_circuited_total',
  /**
   * Effective breaker POSTURE, `state` ∈ off|shadow|enforce (issue #534,
   * owner review). Same pair-of-series shape as `LLM_CIRCUIT_STATE`: exactly
   * one is 1. `mode` is not on `ALLOWED_LABEL_KEYS` and a new key there is a
   * separate governance decision, so the posture rides the `state` key — the
   * two are told apart by the metric name, never by a label.
   *
   * This is the series that answers "is the control actually enforcing right
   * now?", which is not answerable from `LLM_CIRCUIT_STATE` alone: a breaker
   * reading `open` in shadow mode is refusing nothing.
   */
  LLM_CIRCUIT_MODE: 'maia_llm_circuit_mode',
  /**
   * SHADOW-ONLY twin of the `open` transition: the breaker entered `open`
   * while refusing nothing. `reason` matches `LLM_CIRCUIT_TRANSITIONS`.
   *
   * Exists because `LLM_CIRCUIT_TRANSITIONS{state="open"}` fires identically
   * in shadow and enforce, so across a mixed fleet it cannot answer "would it
   * have opened when it shouldn't?" — which is the whole question a staging
   * pass has to answer before promotion.
   */
  LLM_CIRCUIT_WOULD_OPEN: 'maia_llm_circuit_would_open_total',
  /**
   * SHADOW-ONLY twin of `LLM_CALLS{status="circuit_open"}`: one increment per
   * CALL that an enforcing breaker would have refused and shadow let through.
   * `state` is the breaker state that would have produced the refusal.
   *
   * Tenant-attributed like the real refusal counter (emitted from inside the
   * caller's ALS scope) — the breaker's STATE is deliberately global, but
   * every refusal, real or simulated, stays attributable to who ate it.
   */
  LLM_CIRCUIT_WOULD_REJECT: 'maia_llm_circuit_would_reject_total',
  /**
   * Kill-switch usage. `state` is the posture that was forced, `reason` ∈
   * applied|expired|cleared|rejected|adopted|resynced|resync_failed|resync_aborted.
   * A lever that can be pulled without a deploy MUST leave a trace that
   * alerting can see; the matching `llm_gateway.circuit_mode_override` log line
   * carries actor and reason.
   *
   * The last THREE are the RECONNECT resync (issue #534 gate 4), one event per
   * RE-READ including the no-op — never one per retry attempt, see below:
   * Redis pub/sub is at-most-once with no replay,
   * so a replica whose socket dropped during the incident must re-read the
   * durable key to converge. `resynced` = the re-read completed and this
   * replica's state IS the Redis state; `resync_failed` = it could not be
   * asserted, and `state` is the posture that was PRESERVED, which may now
   * diverge from the fleet. Fail-closed covers every way of not knowing: read
   * error, unreadable key, a key that was read and REJECTED by governance, and
   * a re-subscribe with no ack (no ack ⇒ the read is not even attempted, since
   * treating an absent key as authoritative there would clear a live
   * override). The cause stays distinguishable in the log's `outcome` field.
   *
   * `resync_failed` is TERMINAL, and terminal has TWO distinct routes (owner
   * review on PR #561, finding 3) — the re-read is retried (immediate attempt +
   * 3 backed-off retries, `RESYNC_RETRY` in
   * `src/lib/llm/cache-invalidation.ts`), so a point here means either:
   *
   *  - **exhaustion of the RETRYABLE failures** — `GET` error or attempt
   *    deadline, unreadable key, missing re-subscribe ack. Four attempts, all
   *    failed. An intermediate failure of this kind is a
   *    `llm_gateway.circuit_override_resync_retry` log line and nothing else,
   *    which is what keeps a 200 ms Redis hiccup out of this series; or
   *  - **a deterministic TERMINAL refusal on the first read** — the key was
   *    read and governance REJECTED the payload (no absolute `expires_at`, no
   *    actor, expired, above the cap). Retrying is pointless: the verdict is a
   *    function of the key's content, and four identical `_rejected` rows would
   *    turn the durable trail into noise. So `outcome="rejected"` reaches this
   *    series with `attempts=1`, by design — not as a retry regression.
   *
   * Either way ANY point here pages: `MaiaLlmCircuitResyncFailedEnforcing`
   * (critical, `state="enforce"`) and `MaiaLlmCircuitResyncFailed` (warning,
   * every other posture) in `monitoring/alerts/slo.rules.yml`. They are
   * evaluated WITHOUT aggregation on purpose — one diverging replica out of
   * twenty is the case they exist to catch, and a `sum` would dissolve it.
   * Triage per `outcome` is in `docs/runbooks/observability-slo.md` §4.9.3.
   *
   * `resync_aborted` is the THIRD bucket, and neither of the other two (owner
   * review on PR #561, finding 2): the subscriber was CLOSED — drain, deploy —
   * while the re-read was in flight, so it was cancelled rather than finished.
   * Folding it into `resync_failed` would make every deliberate drain page;
   * folding it into `resynced` would claim a convergence that never happened,
   * which is exactly the false green evidence the `enforce` promotion gate must
   * not read. No alert selects it: a replica on its way out is not an incident.
   */
  LLM_CIRCUIT_MODE_OVERRIDES: 'maia_llm_circuit_mode_overrides_total',

  // --- tools ---------------------------------------------------------------
  TOOL_DISPATCH: 'maia_tool_dispatch_total',
  TOOL_DURATION_MS: 'maia_tool_duration_ms',

  // --- whatsapp / outbound -------------------------------------------------
  OUTBOUND_COMMITTED: 'maia_outbound_committed_total',
  OUTBOUND_SEND: 'maia_outbound_send_total',
  OUTBOUND_SEND_MS: 'maia_outbound_send_ms',
  /**
   * WhatsApp session presence, `state` ∈ connected|disconnected (issue #535
   * §2). Exactly one series is 1 — the pair makes "no session at all" and
   * "session down" distinguishable from a missing scrape.
   */
  WHATSAPP_SESSIONS: 'maia_whatsapp_sessions',
  /** Seconds since the WhatsApp socket last dropped. Growing = healthy. */
  WHATSAPP_SESSION_AGE_SECONDS: 'maia_whatsapp_session_age_seconds',

  // --- workers / schedulers ------------------------------------------------
  WORKER_RUN: 'maia_worker_run_total',
  WORKER_DURATION_MS: 'maia_worker_duration_ms',

  // --- onboarding saga / agent readiness (issue #519) ----------------------
  //
  // Declaradas aqui — e não emitidas direto por `@/lib/metrics` — porque os
  // rótulos destas séries vêm de entrada do CHAMADOR (`reason_code` do
  // cancelamento, código de erro do passo, código de check reprovado). Emitir
  // por fora do sanitizador punha texto livre (e potencialmente PII) num label
  // e abria cardinalidade ilimitada. Aqui o vocabulário é FECHADO
  // (`ONBOARDING_REASONS`, `ONBOARDING_STEP_VALUES`,
  // `READINESS_CHECK_CODE_VALUES`) e o texto livre fica em auditoria/log.
  /** Runs de onboarding iniciadas, por `kind`. */
  ONBOARDING_RUN_STARTED: 'maia_onboarding_run_started_total',
  /** Runs canceladas, por `reason` (vocabulário fechado). */
  ONBOARDING_RUN_CANCELLED: 'maia_onboarding_run_cancelled_total',
  /** Runs que chegaram a `active`, por `kind`. */
  ONBOARDING_RUN_COMPLETED: 'maia_onboarding_run_completed_total',
  /** Passos commitados, por `step`. */
  ONBOARDING_STEP_COMPLETED: 'maia_onboarding_step_completed_total',
  /** Passos recusados/falhos, por `step` + `reason`. */
  ONBOARDING_STEP_FAILED: 'maia_onboarding_step_failed_total',
  /** Replays do ledger de idempotência, por `step`. */
  ONBOARDING_IDEMPOTENCY_REPLAY: 'maia_onboarding_idempotency_replay_total',
  /** Duração de um passo da saga. */
  ONBOARDING_STEP_DURATION_MS: 'maia_onboarding_step_duration_ms',
  /** Checks BLOQUEANTES reprovados, por `check_code`. */
  AGENT_READINESS_FAILED: 'maia_agent_readiness_failed_total',
  /**
   * FILA do `onboarding_expirer`: runs cujo `expires_at` já passou e que ainda
   * não são terminais — exatamente as linhas que o próximo tick pegaria.
   *
   * Existe porque a contagem de expiradas sozinha não responde "estou perdendo
   * a corrida?": o worker drena o teto do lote a cada tick, a série de
   * cancelamento sobe, `maia_worker_run_total{status="ok"}` sobe, e a fila pode
   * estar crescendo o tempo todo. Um lote cheio é indistinguível de "havia
   * exatamente um lote" sem esta série.
   *
   * SEM `tenant_id`/`agent_id`, ao contrário da série de cancelamento: isto é a
   * profundidade de uma fila GLOBAL de housekeeping, e não um fato sobre um
   * tenant. Mesma justificativa (e mesma forma) de `SCHEDULER_BACKLOG`. Ainda
   * pesa que um gauge com rótulo vira um provider REGISTRADO por valor em
   * `src/lib/metrics.ts` (o rótulo mora no NOME registrado), e providers não
   * são removidos: rotular por tenant aqui deixaria séries de tenants extintos
   * penduradas para sempre.
   *
   * Emitida por `src/observability/onboarding-expiry-collector.ts`, que a lê no
   * SCRAPE. Um valor publicado pelo worker congelaria no último número quando o
   * worker parasse — a falha que esta série existe para pegar (#536).
   */
  ONBOARDING_EXPIRY_BACKLOG: 'maia_onboarding_expiry_backlog',
  /**
   * Há quanto tempo a run vencida MAIS ANTIGA está esperando pela varredura.
   *
   * Companheira da contagem, e nenhuma das duas basta sozinha: a contagem
   * parada no teto do lote não distingue "empatando" de "perdendo", e a idade
   * alta sozinha não distingue UMA run presa de MIL runs atrasadas. É a idade
   * que dá o "prazo máximo de limpeza" um SLO verificável.
   *
   * `0` quando não há fila — o mesmo contrato de `SCHEDULER_LAG_MS`, onde "não
   * há linha vencida" É zero. Não confundir com o `NaN` que o coletor devolve
   * quando NÃO CONSEGUIU LER: ausência de leitura nunca é zero saudável.
   */
  ONBOARDING_EXPIRY_OLDEST_AGE_SECONDS: 'maia_onboarding_expiry_oldest_age_seconds',

  // --- ops / restore drill (issue #536) ------------------------------------
  /**
   * Drills de restore que terminaram com `cleanup_status='unsafe'` — o teardown
   * deixou cópia da produção no host. SEM labels: o drill é uma operação da
   * plataforma, não de um tenant, e o "quem/qual drill" pertence a
   * `restore_drills` e ao log, não a uma série. Declarado aqui a pedido da
   * integração, para o trabalho de drill que roda em paralelo nesta leva.
   */
  RESTORE_DRILL_UNSAFE_RESIDUE: 'maia_restore_drill_unsafe_residue_total',
  /**
   * O GATE do drill de restore: 0 = um drill recente provou um artefato
   * restaurável; 1 = a evidência está envelhecendo; 2 = REPROVADO (evidência
   * mais velha que `BACKUP_RESTORE_DRILL_INTERVAL_HOURS`, último drill falhou,
   * nunca rodou um drill em production, ou a evidência não pôde ser lida).
   *
   * Um nível 0/1/2 em vez do par-de-séries de `LLM_CIRCUIT_STATE`/
   * `WHATSAPP_SESSIONS`, e a diferença é deliberada: ali "nunca exercitado" e
   * "fechado" precisam ser distinguíveis, aqui NÃO — nunca ter drillado JÁ é o
   * degrau 2. O caso ambíguo que justifica o par-de-séries não existe nesta
   * série porque ela é fail-closed por construção.
   *
   * SEM labels: a postura de recuperação é da plataforma, não de um tenant, e
   * o "qual drill / por quê" pertence a `restore_drills` e ao log. Emitida por
   * `src/observability/backup-readiness-collector.ts`, que a lê no SCRAPE a
   * partir das tabelas de evidência — não de um valor que o worker publica,
   * senão um worker morto congelaria a série no último verde.
   */
  RESTORE_DRILL_CHECK_LEVEL: 'maia_restore_drill_check_level',
  /**
   * Idade do drill terminal mais recente. `-1` quando nunca houve um: `0`
   * leria como "acabou de rodar", e idade negativa é impossível (logo, inerte
   * a qualquer alerta `> limiar`). O veredito mora em
   * `RESTORE_DRILL_CHECK_LEVEL`, nunca aqui.
   */
  RESTORE_DRILL_AGE_SECONDS: 'maia_restore_drill_age_seconds',
  /** Duração do último drill APROVADO — a contribuição medida ao RTO. */
  RESTORE_DRILL_DURATION_SECONDS: 'maia_restore_drill_duration_seconds',
  /** Veredito agregado de backup (RPO local/off-site, falhas, cifra). 0/1/2. */
  BACKUP_READINESS_LEVEL: 'maia_backup_readiness_level',
  /** Idade do artefato restaurável mais novo — o RPO medido, em segundos. */
  BACKUP_AGE_SECONDS: 'maia_backup_age_seconds',

  // --- observability self-health ------------------------------------------
  /** Envelope coverage of the hot path — the §4 "measure coverage" ask. */
  TRACE_COVERAGE: 'maia_runtime_trace_coverage_total',
  /** A label set was rejected/repaired by the sanitizer. */
  LABEL_REJECTED: 'maia_metric_label_rejected_total',
  /** A label value exceeded its cardinality budget and fell into overflow. */
  LABEL_CARDINALITY_OVERFLOW: 'maia_metric_label_cardinality_overflow_total',

  // --- OTLP exporter self-health (issue #535 §1) ---------------------------
  /** Spans handed to the OTLP transport and accepted by the collector. */
  OTLP_SPANS_EXPORTED: 'maia_otlp_spans_exported_total',
  /**
   * Spans that never reached the collector, by `reason` (`queue_full`,
   * `not_sampled`, `transport`, `http_status`, `shutdown`, `attributes`).
   * An exporter that silently loses spans is worse than no exporter: the gaps
   * read as "nothing happened".
   */
  OTLP_SPANS_DROPPED: 'maia_otlp_spans_dropped_total',
  /** Wall time of one export request. */
  OTLP_EXPORT_MS: 'maia_otlp_export_duration_ms',
  /** Spans currently waiting in the batch queue. */
  OTLP_QUEUE_DEPTH: 'maia_otlp_queue_depth',
  /** A span attribute was dropped/sanitized by the span-attribute gate. */
  SPAN_ATTRIBUTE_REJECTED: 'maia_span_attribute_rejected_total',
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
  // saga de onboarding (issue #519) — os dois são conjuntos FECHADOS e
  // pequenos, declarados abaixo em `ONBOARDING_STEP_VALUES` e
  // `READINESS_CHECK_CODE_VALUES`. Nenhum dos dois aceita texto do chamador:
  // o emissor colapsa qualquer valor fora do vocabulário.
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
 * The CLOSED set of `stage` values carried by the span `context.load`
 * (issue #535 gate 6; reshaped by the review of PR #554).
 *
 * `stage` is a shared attribute key (`maia_turn_stage_duration_ms` uses it as a
 * metric LABEL too), so it cannot live in `ENUM_VALUES`, which is global per
 * key. This is the per-span vocabulary, and it exists so the closure is
 * assertable instead of argued: `LABEL_CARDINALITY_BUDGET.stage` is 60, and the
 * moment a call site derives one from input (a config name, a tenant, a slice
 * name coming from the wire) that budget stops bounding anything real. The
 * wrapper takes `ContextLoadStage`, not `string`, so the closure is a compiler
 * rule and not a review convention — that typing was a Medium finding in the
 * review of PR #554 and must not regress.
 *
 * `turn_context` — the turn's carga de contexto, `loadTurnContext` in
 * `src/agent/turn-context/loader.ts`. It is the only member, and the name is
 * deliberately the one the reused metric family already uses
 * (`maia_turn_context_*`), so an operator moving from the histogram to the
 * waterfall does not need a translation table.
 *
 * `packet` was the previous single member and is gone with the P8a
 * instrumentation: `buildContextPacket` has no caller in production, and a
 * vocabulary entry no path can emit is the "declared reads as covered" defect
 * issue #535 opens with.
 */
export const CONTEXT_LOAD_STAGE = Object.freeze({
  TURN_CONTEXT: 'turn_context',
} as const);

export type ContextLoadStage =
  (typeof CONTEXT_LOAD_STAGE)[keyof typeof CONTEXT_LOAD_STAGE];

export const CONTEXT_LOAD_STAGE_VALUES: readonly ContextLoadStage[] =
  Object.freeze(Object.values(CONTEXT_LOAD_STAGE));

// ---------------------------------------------------------------------------
// 3.1 Onboarding saga — vocabulários FECHADOS (issue #519, review do PR #541)
// ---------------------------------------------------------------------------

/**
 * Sentinela para qualquer valor fora de um vocabulário fechado.
 *
 * Difere de `CARDINALITY_OVERFLOW_VALUE` de propósito: overflow é "o budget
 * estourou", isto é "o chamador mandou algo que não está no contrato". O
 * emissor colapsa ANTES do sanitizador, então um `reason_code` livre nunca
 * chega a existir como série — e o motivo original continua inteiro na
 * auditoria e no log estruturado, que é onde texto livre pertence.
 */
export const CLOSED_VOCABULARY_FALLBACK = 'other';

/**
 * Valores admitidos no label `step`. Espelho EXATO de `ONBOARDING_STEPS`
 * (`src/onboarding/state-machine.ts`) — a igualdade é pinada por
 * `tests/unit/onboarding/metrics-taxonomy.spec.ts`, para que um passo novo não
 * possa ser emitido sem passar por esta declaração.
 */
export const ONBOARDING_STEP_VALUES: readonly string[] = Object.freeze([
  'provision_tenant',
  'provision_admin',
  'provision_agent',
  'configure_profile',
  'apply_capability_packs',
  'configure_role',
  'declare_channel',
  'start_pairing',
  'confirm_channel_ready',
  'evaluate_readiness',
  'activate',
]);

/**
 * Valores admitidos no label `reason` das séries de onboarding.
 *
 * União de: os códigos de erro tipados da saga (`ONBOARDING_ERROR_CODES`), o
 * `internal_error` do sanitizador de exceção, os motivos de recusa vindos da
 * fila de comandos de #518, e um pequeno vocabulário de cancelamento operado
 * pelo console. `reason_code` de cancelamento é ENTRADA DO OPERADOR: qualquer
 * coisa fora desta lista vira `CLOSED_VOCABULARY_FALLBACK`, e o texto original
 * fica só em `onboarding_runs.last_error_code`, no evento e na auditoria.
 */
export const ONBOARDING_REASONS: readonly string[] = Object.freeze([
  // erros tipados da saga
  'invalid_scope',
  'forbidden_scope_literal',
  'scope_mismatch',
  'invalid_transition',
  'run_not_found',
  'run_terminal',
  'run_expired',
  'unknown_step',
  'version_conflict',
  'idempotency_payload_mismatch',
  'missing_idempotency_key',
  'forbidden',
  'tenant_not_found',
  'tenant_disabled',
  'agent_not_found',
  'duplicate_tenant',
  'duplicate_agent',
  'duplicate_channel',
  'role_not_found',
  'channel_not_found',
  'channel_not_paired',
  'readiness_blocked',
  'activation_precondition_failed',
  'kind_not_implemented',
  'internal_error',
  // recusas da fila de comandos de #518
  'pairing_in_progress',
  'pairing_rejected',
  // cancelamento operado pelo console
  'operator_abort',
  'expired',
  CLOSED_VOCABULARY_FALLBACK,
]);

/**
 * Valores admitidos no label `check_code`. Espelho EXATO de
 * `READINESS_CHECK_CODES` (`src/onboarding/readiness.ts`), pinado pelo mesmo
 * teste que pina os passos.
 */
export const READINESS_CHECK_CODE_VALUES: readonly string[] = Object.freeze([
  'tenant_exists',
  'tenant_enabled',
  'agent_exists',
  'agent_belongs_to_tenant',
  'profile_active',
  'capability_grant_present',
  'required_packs_granted',
  'tool_permissions_coherent',
  'default_role_resolved',
  'channel_declared',
  'channel_policy_resolved',
  'channel_policy_role_active',
  'channel_ownership_proven',
  'channel_online',
  'schema_ready',
  'governance_no_blocking_pending',
  'agent_activated',
]);

/**
 * Colapsa um valor num vocabulário fechado. É a defesa que roda ANTES do
 * sanitizador de labels: o allowlist de CHAVES não diz nada sobre o VALOR, e
 * `reason` tem budget 60 — sem isto, 60 `reason_code` livres viravam 60 séries
 * permanentes antes de o overflow sequer começar a proteger.
 */
export function closedVocabulary(
  value: string | null | undefined,
  vocabulary: readonly string[],
): string {
  if (typeof value !== 'string') return CLOSED_VOCABULARY_FALLBACK;
  return vocabulary.includes(value) ? value : CLOSED_VOCABULARY_FALLBACK;
}

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
  // Vocabulários fechados e pequenos: 11 passos e 17 códigos de check. O
  // budget é o teto do contrato, não uma estimativa.
  step: 20,
  check_code: 24,
});

/** Budget applied to any allowed key without an explicit entry above. */
export const DEFAULT_LABEL_CARDINALITY_BUDGET = 30;

/** Replacement value once a label blows its cardinality budget. */
export const CARDINALITY_OVERFLOW_VALUE = '__overflow__';

/** Replacement value when a value fails the shape/PII guard. */
export const SANITIZED_VALUE = '__sanitized__';

/** Max characters kept for any label value. */
export const MAX_LABEL_VALUE_LENGTH = 64;

// ============================================================================
// 4. Span attributes (issue #535 §1)
// ============================================================================

/**
 * Span attributes are NOT metric labels, and the difference is deliberate.
 *
 * A metric label mints a time series forever, so `labels.ts` bans every
 * correlation id. A span attribute lives on ONE exported span: it costs no
 * series, and carrying `trace_id`/`turn_id` there is exactly what
 * `governance-observability.md` §4.4c prescribes ("high-cardinality
 * correlation ids live in logs and traces, never in labels").
 *
 * What does NOT change between the two surfaces: message content, phone
 * numbers, JIDs, e-mails, person names, URLs and raw error strings are
 * forbidden in BOTH. The OTLP exporter ships to a third-party collector, so if
 * anything the value guard here matters more than the label one.
 *
 * `SPAN_ATTRIBUTE_KEYS` = every metric label key (so instrumentation can pass
 * one bag to both surfaces) PLUS the enumerated correlation ids below.
 */
export const SPAN_CORRELATION_KEYS: ReadonlySet<string> = new Set([
  'trace_id',
  'turn_id',
  'attempt',
  'attempt_id',
  'conversa_id',
  'root_trace_id',
]);

export const SPAN_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  ...ALLOWED_LABEL_KEYS,
  ...SPAN_CORRELATION_KEYS,
  // span-only numerics — bounded magnitudes, never identifiers
  'duration_ms',
  'attempt_count',
  'item_count',
  'byte_count',
  'sampled',
]);

/**
 * Deny list for span attributes. Same PII/content vocabulary as the metric
 * deny list MINUS the correlation ids that spans are allowed to carry — the
 * whole point of a trace is to join on those.
 */
export const FORBIDDEN_SPAN_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set(
  [...FORBIDDEN_LABEL_KEYS].filter((k) => !SPAN_CORRELATION_KEYS.has(k)),
);

export const FORBIDDEN_SPAN_KEY_SUBSTRINGS: readonly string[] = Object.freeze(
  FORBIDDEN_KEY_SUBSTRINGS.filter(
    (frag) => frag !== 'trace_id' && frag !== 'conversa' && frag !== 'conversation',
  ),
);

/** Max characters kept for any span attribute value. */
export const MAX_SPAN_ATTRIBUTE_VALUE_LENGTH = 128;

/** Max attributes kept on one span — a bag, not a payload channel. */
export const MAX_SPAN_ATTRIBUTES = 24;
