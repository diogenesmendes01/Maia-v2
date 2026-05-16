-- P10b: unified_trace_events — materialized view that UNIONs the 7 source
-- audit/log tables into a single "what happened" stream for Admin UI trace
-- browser + drift forensics. Refreshed CONCURRENTLY every 5 minutes by the
-- trace-matview-refresh worker.
--
-- Sources (legacy + new):
--   1. audit_log                       (governance writes)
--   2. cognitive_module_log            (P0/P1 cognitive runs)
--   3. agent_drift_alerts              (P4)
--   4. role_selector_decisions         (P6)
--   5. procedure_execution_events      (P3b — if present)
--   6. capability_test_results         (P5)
--   7. runtime_trace_envelopes         (P10b — primary)
--
-- Cada source vira uma row com colunas comuns: trace_id, tenant_id,
-- agent_id, conversa_id, source, event_kind, summary, occurred_at.
-- Body lookup é via trace_id → runtime_trace_bodies para a fonte 7;
-- demais fontes só carregam summary (cheap reads).
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE MATERIALIZED VIEW IF NOT EXISTS unified_trace_events AS
  -- 1. audit_log
  SELECT
    id::text          AS trace_id,
    tenant_id,
    agent_id,
    conversa_id,
    'audit_log'::text AS source,
    acao              AS event_kind,
    jsonb_build_object('entidade_alvo', entidade_alvo, 'alvo_id', alvo_id)
                      AS summary,
    created_at        AS occurred_at
  FROM audit_log
  UNION ALL
  -- 2. cognitive_module_log
  SELECT
    id::text          AS trace_id,
    tenant_id,
    agent_id,
    conversa_id,
    'cognitive_module_log'::text AS source,
    module_name       AS event_kind,
    jsonb_build_object(
      'status', status,
      'latency_ms', latency_ms,
      'fallback', fallback_triggered
    )                 AS summary,
    created_at        AS occurred_at
  FROM cognitive_module_log
  UNION ALL
  -- 3. agent_drift_alerts
  SELECT
    id::text          AS trace_id,
    tenant_id,
    agent_id,
    NULL::uuid        AS conversa_id,
    'agent_drift_alert'::text AS source,
    drift_type        AS event_kind,
    jsonb_build_object('severity', severity, 'decision', decision)
                      AS summary,
    created_at        AS occurred_at
  FROM agent_drift_alerts
  UNION ALL
  -- 4. role_selector_decisions
  SELECT
    id::text          AS trace_id,
    tenant_id,
    agent_id,
    conversa_id,
    'role_selector_decision'::text AS source,
    'role_selection'  AS event_kind,
    jsonb_build_object('chosen_role_id', chosen_role_id, 'decided_by', decided_by)
                      AS summary,
    created_at        AS occurred_at
  FROM role_selector_decisions
  UNION ALL
  -- 5. capability_test_results
  SELECT
    id::text          AS trace_id,
    tenant_id,
    agent_id,
    NULL::uuid        AS conversa_id,
    'capability_test_result'::text AS source,
    'capability_test' AS event_kind,
    jsonb_build_object('outcome', outcome, 'proposal_id', proposal_id)
                      AS summary,
    ran_at            AS occurred_at
  FROM capability_test_results
  UNION ALL
  -- 6. procedure_execution_events (lightweight subset; no conversa_id in source)
  SELECT
    id::text          AS trace_id,
    tenant_id,
    agent_id,
    NULL::uuid        AS conversa_id,
    'procedure_execution_event'::text AS source,
    event_type        AS event_kind,
    jsonb_build_object('execution_id', execution_id::text, 'step_id', step_id)
                      AS summary,
    created_at        AS occurred_at
  FROM procedure_execution_events
  UNION ALL
  -- 7. runtime_trace_envelopes (P10b primary)
  SELECT
    trace_id::text    AS trace_id,
    tenant_id,
    agent_id,
    conversa_id,
    'runtime_trace_envelope'::text AS source,
    decision          AS event_kind,
    jsonb_build_object(
      'side_effect_level', side_effect_level,
      'policy_id', policy_id,
      'body_status', body_status,
      'redaction_class', redaction_class
    )                 AS summary,
    created_at        AS occurred_at
  FROM runtime_trace_envelopes;

-- UNIQUE index is REQUIRED for REFRESH MATERIALIZED VIEW CONCURRENTLY.
-- Composite key (source, trace_id) is unique because every source table
-- has its own PK and we tag the source explicitly.
CREATE UNIQUE INDEX IF NOT EXISTS unified_trace_events_pk_idx
  ON unified_trace_events (source, trace_id);

-- Read patterns: (1) tenant timeline, (2) conversa drill-down.
CREATE INDEX IF NOT EXISTS unified_trace_events_tenant_idx
  ON unified_trace_events (tenant_id, agent_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS unified_trace_events_conversa_idx
  ON unified_trace_events (conversa_id, occurred_at DESC)
  WHERE conversa_id IS NOT NULL;
