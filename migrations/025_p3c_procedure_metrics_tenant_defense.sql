-- P3c — PR #85 review fixes for `procedure_metrics` matview:
--
--   * P85-I2 (defense-in-depth on tenant boundary): the previous matview
--     joined `procedure_definitions d LEFT JOIN procedure_executions e
--     ON e.definition_id = d.id`. A bug elsewhere that inserted an
--     execution row whose `tenant_id` drifted from its definition's
--     `tenant_id` (no FK enforcement across the pair) would surface
--     under the wrong tenant in this matview. The project marks tenant
--     isolation "inviolable" → add explicit `e.tenant_id = d.tenant_id`
--     AND `e.agent_id = d.agent_id` predicates in the join.
--
--   * P85-I3 (sandbox-test pollution): the test-runner under
--     `src/procedures/test-runner.ts` writes execution rows tagged
--     `tenant_id='sandbox-test'` and never deletes them (the cleanup
--     `finally` block is dead code today — repos expose no `delete`).
--     The matview is global, so sandbox executions would pollute
--     aggregate metrics if anyone ever queried the view directly without
--     a tenant predicate. Exclude `tenant_id='sandbox-test'` at the
--     matview definition layer — single source of truth.
--
-- Because matviews can't be ALTERed in place, we DROP + CREATE. The
-- indexes are recreated to preserve `REFRESH CONCURRENTLY` support.
--
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

DROP INDEX IF EXISTS procedure_metrics_tenant_agent_idx;
DROP INDEX IF EXISTS procedure_metrics_definition_idx;
DROP MATERIALIZED VIEW IF EXISTS procedure_metrics;

CREATE MATERIALIZED VIEW procedure_metrics AS
SELECT
  d.id AS definition_id,
  d.tenant_id,
  d.owner_agent_id AS agent_id,
  d.nome,
  d.version_number AS version,
  d.status AS definition_status,
  COUNT(DISTINCT e.id) AS total_executions,
  COUNT(DISTINCT e.id) FILTER (WHERE e.status = 'completed' AND e.outcome = 'success') AS successful_executions,
  COUNT(DISTINCT e.id) FILTER (WHERE e.status = 'completed' AND e.outcome = 'failure') AS failed_executions,
  COUNT(DISTINCT e.id) FILTER (WHERE e.status = 'aborted') AS aborted_executions,
  COUNT(DISTINCT e.id) FILTER (WHERE e.status = 'escalated') AS escalated_executions,
  COUNT(DISTINCT e.id) FILTER (WHERE e.status = 'abandoned') AS abandoned_executions,
  COUNT(DISTINCT e.id) FILTER (WHERE e.status = 'in_progress') AS in_progress_executions,
  CASE
    WHEN COUNT(DISTINCT e.id) FILTER (WHERE e.status IN ('completed', 'aborted', 'escalated', 'abandoned')) > 0
    THEN (
      COUNT(DISTINCT e.id) FILTER (WHERE e.status = 'completed' AND e.outcome = 'success')::numeric
      / COUNT(DISTINCT e.id) FILTER (WHERE e.status IN ('completed', 'aborted', 'escalated', 'abandoned'))::numeric
    )
    ELSE NULL
  END AS success_rate,
  AVG(
    EXTRACT(EPOCH FROM (e.ended_at - e.started_at))
  ) FILTER (WHERE e.status = 'completed' AND e.ended_at IS NOT NULL) AS avg_completion_seconds,
  MAX(e.last_activity_at) AS last_execution_at,
  now() AS refreshed_at
FROM procedure_definitions d
LEFT JOIN procedure_executions e
  ON e.definition_id = d.id
 AND e.tenant_id = d.tenant_id
 AND e.agent_id = d.owner_agent_id
WHERE d.tenant_id <> 'sandbox-test'
GROUP BY d.id, d.tenant_id, d.owner_agent_id, d.nome, d.version_number, d.status;

CREATE UNIQUE INDEX procedure_metrics_definition_idx
  ON procedure_metrics(definition_id);
CREATE INDEX procedure_metrics_tenant_agent_idx
  ON procedure_metrics(tenant_id, agent_id);
