#!/bin/bash
# P10b Acceptance Gates — Runtime Trace
# Run after DB up + migrations 052/053/054 applied.
# (Migration numbers updated per Codex review #102 to coordinate with
#  parallel PRs P8b/P8c/P8d/P8e — see runbook for the global numbering table.)
set -e

echo "=== Gate A: 3 novas tabelas + 1 matview no schema ==="
COUNT_TBL=$(grep -cE "^export const (runtime_trace_envelopes|runtime_trace_bodies|runtime_trace_body_outbox)" src/db/schema.ts)
[ "$COUNT_TBL" = "3" ] || { echo "FAIL: expected 3 trace tables in schema.ts, got $COUNT_TBL"; exit 1; }
grep -q "unified_trace_events" migrations/054_p10b_unified_trace_events_matview.sql || {
  echo "FAIL: unified_trace_events matview migration missing"; exit 1;
}
grep -q "runtime_trace_body_outbox" migrations/053_p10b_runtime_trace_bodies.sql || {
  echo "FAIL: durable outbox migration missing"; exit 1;
}
echo "OK"

echo "=== Gate B: feature flag + env vars wired ==="
grep -q "FEATURE_RUNTIME_TRACE_V1" src/config/env.ts || { echo "FAIL: FEATURE_RUNTIME_TRACE_V1 missing in env.ts"; exit 1; }
grep -q "RUNTIME_TRACE_HMAC_KEY_VERSION" src/config/env.ts || { echo "FAIL: HMAC key version env missing"; exit 1; }
grep -q "RUNTIME_TRACE_V1" src/types/enums.ts || { echo "FAIL: FeatureFlagName.RUNTIME_TRACE_V1 missing"; exit 1; }
grep -q "RUNTIME_TRACE_V1" src/config/feature-flags.ts || { echo "FAIL: featureFlags singleton missing RUNTIME_TRACE_V1"; exit 1; }
echo "OK"

echo "=== Gate C: 3 workers registrados no JOBS ==="
grep -q "trace_body_writer" src/workers/index.ts || { echo "FAIL: trace_body_writer job missing"; exit 1; }
grep -q "trace_body_recoverer" src/workers/index.ts || { echo "FAIL: trace_body_recoverer job missing"; exit 1; }
grep -q "trace_matview_refresh" src/workers/index.ts || { echo "FAIL: trace_matview_refresh job missing"; exit 1; }
echo "OK"

echo "=== Gate D: unit tests (HMAC + redaction + envelope + body + facade + p99 + migration smoke) ==="
npx vitest run \
  tests/unit/runtime-trace-hmac.spec.ts \
  tests/unit/runtime-trace-redaction.spec.ts \
  tests/unit/runtime-trace-debug-encrypt.spec.ts \
  tests/unit/runtime-trace-envelope-writer.spec.ts \
  tests/unit/runtime-trace-envelope-p99.spec.ts \
  tests/unit/runtime-trace-body-writer.spec.ts \
  tests/unit/runtime-trace-facade.spec.ts \
  tests/unit/trace-body-writer-worker.spec.ts \
  tests/unit/p10b-migrations-smoke.spec.ts

echo "=== Gate E: integration test (6 cenários) ==="
npx vitest run tests/integration/p10b-runtime-trace.spec.ts

echo "=== Gate F: DB objects ==="
if [ -n "$DATABASE_URL" ]; then
  psql "$DATABASE_URL" -c "
    SELECT
      to_regclass('public.runtime_trace_envelopes')        AS envelopes,
      to_regclass('public.runtime_trace_bodies')           AS bodies,
      to_regclass('public.runtime_trace_body_outbox')      AS outbox,
      to_regclass('public.unified_trace_events')           AS matview;
  "
else
  echo "SKIP: DATABASE_URL not set (only static checks ran)"
fi

echo "=== Gate G: TypeScript clean ==="
npx tsc --noEmit

echo "=== Gate H: ESLint clean for P10b files ==="
npx eslint \
  src/control-plane/runtime-trace \
  src/workers/trace-body-writer.ts \
  src/workers/trace-body-recoverer.ts \
  src/workers/trace-matview-refresh.ts \
  tests/unit/runtime-trace-*.spec.ts \
  tests/unit/trace-body-writer-worker.spec.ts \
  tests/unit/p10b-migrations-smoke.spec.ts \
  tests/integration/p10b-runtime-trace.spec.ts

echo ""
echo "All P10b acceptance gates green. Ready to tag p10b-runtime-trace-done."
