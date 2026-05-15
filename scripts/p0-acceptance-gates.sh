#!/bin/bash
# P0 Acceptance Gates — run after DB is up (docker compose up -d postgres && npm run db:migrate)
#
# Executa a bateria completa de gates do §9 do spec da P0 (Maia v2 multi-tenant).
# Gates 1, 5, 7, 8, 9 são code-level (rodam sem DB). Gates 2, 3, 4, 6 precisam de DB.
#
# Pré-requisitos:
#   - DATABASE_URL exportado e apontando pra um postgres com migrations P0 aplicadas
#   - psql instalado e disponível no PATH
#   - Node modules instalados (npm install)

set -e

echo "=== Gate 1: MissingTenantContextError check ==="
npx vitest run tests/unit/tenant-context.spec.ts

echo ""
echo "=== Gate 2: NOT NULL forçado em 27 tabelas ==="
# Expected = 57:
#   27 P0 tables × 2 cols (tenant_id + agent_id)       = 54  (migration 012)
#   agents.tenant_id                                    =  1  (migration 007)
#   cognitive_module_log.tenant_id + agent_id           =  2  (migration 008)
# Se este número mudar (nova tabela tenant-aware), atualizar EXPECTED.
EXPECTED_NOT_NULL=57
NOT_NULL_COUNT=$(psql "$DATABASE_URL" -At -c "
SELECT count(*)
FROM information_schema.columns
WHERE column_name IN ('tenant_id', 'agent_id')
  AND is_nullable = 'NO'
  AND table_schema = 'public';
")
echo "NOT NULL tenant_id/agent_id columns: $NOT_NULL_COUNT (expected $EXPECTED_NOT_NULL)"
if [ "$NOT_NULL_COUNT" -ne "$EXPECTED_NOT_NULL" ]; then
  echo "Gate 2 FAIL: esperado $EXPECTED_NOT_NULL colunas NOT NULL, encontrado $NOT_NULL_COUNT."
  echo "  Verifique se todas as migrations P0 (007-012) rodaram e se o EXPECTED está atualizado."
  exit 1
fi
echo "Gate 2 OK"

echo ""
echo "=== Gate 3: Isolation integration test ==="
npx vitest run tests/integration/tenant-isolation.spec.ts

echo ""
echo "=== Gate 4: Backfill cobre 100% (zero NULL) ==="
psql "$DATABASE_URL" -c "
DO \$\$
DECLARE
  null_count INTEGER;
  t TEXT;
  tables TEXT[] := ARRAY[
    'entidades', 'contas_bancarias', 'categorias', 'transacoes',
    'transferencias_internas', 'recorrencias', 'contrapartes',
    'pessoas', 'permission_profiles', 'permissoes',
    'conversas', 'mensagens',
    'agent_facts', 'learned_rules', 'agent_memories', 'self_state',
    'entity_states', 'workflows', 'workflow_steps',
    'pending_questions', 'idempotency_keys',
    'system_health_events', 'dead_letter_jobs', 'dashboard_sessions',
    'import_runs', 'import_entries', 'audit_log'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE tenant_id IS NULL OR agent_id IS NULL', t)
    INTO null_count;
    IF null_count > 0 THEN
      RAISE EXCEPTION 'Found % NULL rows in %', null_count, t;
    END IF;
  END LOOP;
  RAISE NOTICE 'Gate 4 OK: zero NULLs em todas as 27 tabelas';
END \$\$;
"

echo ""
echo "=== Gate 5: Rollback test ==="
npx vitest run tests/integration/p0-rollback.spec.ts

echo ""
echo "=== Gate 6: cognitive_module_log smoke ==="
npx vitest run tests/integration/cognitive-module-log.spec.ts

echo ""
echo "=== Gate 7-8 (no DB): enum + feature flags ==="
npx vitest run tests/unit/feature-flags.spec.ts
grep -qE "TenantStatus" src/types/enums.ts || { echo "Gate 7 FAIL: TenantStatus enum missing"; exit 1; }
grep -qE "AgentStatus" src/types/enums.ts || { echo "Gate 7 FAIL: AgentStatus enum missing"; exit 1; }
grep -qE "CognitiveEventType" src/types/enums.ts || { echo "Gate 7 FAIL: CognitiveEventType enum missing"; exit 1; }
grep -qE "FeatureFlagName" src/types/enums.ts || { echo "Gate 7 FAIL: FeatureFlagName enum missing"; exit 1; }
echo "Gate 7 OK"

echo ""
echo "=== Gate 9: Production build ==="
npm run build

echo ""
echo "================================================="
echo "All P0 acceptance gates PASSED."
echo "Ready to tag p0-foundation-done:"
echo ""
echo "    git tag p0-foundation-done"
echo "    git push origin p0-foundation-done"
echo "================================================="
