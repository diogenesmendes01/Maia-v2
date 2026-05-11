# Runbook — P0 Multi-Tenant Foundation

> Como operar e debugar a fundação multi-tenant da Maia v2.

## Quando usar este runbook

- Erro `MissingTenantContextError` em runtime
- Erro `tenant mismatch` em insert/update
- Performance ruim em queries grandes (talvez índice faltando)
- Necessidade de criar novo tenant ou agente
- Rollback de emergência da P0

## Criar tenant novo

```sql
INSERT INTO tenants (id, nome) VALUES ('cliente-x', 'Cliente X Ltda');
INSERT INTO agents (id, tenant_id, nome) VALUES ('cliente-x-maia', 'cliente-x', 'Maia Cliente X');
```

## Debugar MissingTenantContextError

Significa que uma query foi feita fora de `runWithTenantContext`. Localizar:

```bash
# Grep pelo stack trace; geralmente é um worker ou cron novo
grep -rn "db.select\|db.insert\|db.update" src/ | grep -v "runWithTenantContext"
```

Solução: envolver a operação em `runWithTenantContext({ tenant_id, agent_id }, async () => { ... })`.

## Debugar tenant mismatch

Significa que código passou `tenant_id` explícito diferente do contexto atual. Geralmente é bug. Stack trace mostra a origem.

## Rollback de emergência da P0

> Use apenas em produção quebrada. Voltar P0 perde fail-closed em isolamento.

```sql
BEGIN;

-- Drop NOT NULL (mas mantém colunas e dados)
DO $$
DECLARE
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
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id DROP NOT NULL', t);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN agent_id DROP NOT NULL', t);
  END LOOP;
END $$;

COMMIT;
```

Depois desligar `FEATURE_P0_TENANT_GUARD_ENFORCED` via env var ou dashboard.

## Métricas a observar pós-P0

- Latência p95 de queries em `transacoes`, `mensagens`, `conversas` (não deve subir significativamente — índices novos compensam o filtro extra)
- Counts em `cognitive_module_log` (deve haver atividade do reflection)
- Logs de `MissingTenantContextError` (deve ser zero em produção depois de P0 completo)

## Ordem das migrations P0

```
007 — tenants + agents tables + seed 'default' row
008 — cognitive_module_log table
009 — tenant_id + agent_id columns (nullable, default 'default')
010 — backfill rows existentes pra 'default'
011 — índices (tenant_id, agent_id)
012 — flip NOT NULL (fail-closed final)
```

Para aplicar em produção: `npm run db:migrate`.
Para rollback de uma migração específica: aplicar o `*_down.sql` correspondente.

## Comandos úteis

```bash
# Verificar quantas tabelas têm tenant_id NOT NULL
psql $DATABASE_URL -c "
SELECT count(*) FROM information_schema.columns
WHERE column_name = 'tenant_id' AND is_nullable = 'NO';
"
# Esperado: 28+ (27 P0 + agents + cognitive_module_log)

# Listar agentes de um tenant
psql $DATABASE_URL -c "SELECT * FROM agents WHERE tenant_id = '<tenant_id>';"

# Ver últimas execuções cognitivas
psql $DATABASE_URL -c "
SELECT module_name, status, latency_ms, created_at
FROM cognitive_module_log
ORDER BY created_at DESC LIMIT 20;
"
```
