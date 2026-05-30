# Runbook — P3c Procedures: Governance (Tests + Metrics + Reaper + Step Evaluator Completo)

> Como operar e debugar a camada de governança sobre o runtime stateful de procedimentos.

## O que é P3c

Fase de governança e observabilidade sobre o runtime de procedures entregue em P3b. Adiciona:

- `procedure_tests`: cenários de regressão que validam que uma procedure ainda produz o output esperado antes de ser promovida `proposed → active`.
- `procedure_metrics`: materialized view com agregados por procedure (success_rate, avg_steps, p50/p95 duration etc.), refrescada a cada 15min.
- `procedure_execution_reaper`: worker hourly que força `status='abandoned'` em execuções stale (TTL configurável).
- Step evaluator completo: cobre os 5 tipos de critério — `machine_check`, `tool_result`, `llm_judge`, `user_signal`, `human_confirmed`.

## Escopo

- Materialized view `procedure_metrics` (migration 024)
- Tabela `procedure_tests` (migration 023)
- Worker `procedure_execution_reaper` (TTL default 7d)
- Worker `procedure_metrics_refresh` (refresh CONCURRENTLY a cada 15min)
- Step evaluator com fallback robusto (LLM judge timeout = passed=false; user_signal regex/substring; human_confirmed via `recordHumanConfirmation`)
- Gate de promoção: `proposed → active` exige pelo menos 1 test com `last_run_status='pass'`

## Dependências

P3c depende de P0/P1/P2/P3a/P3b já aplicados:

- P0: schema base + tenant context
- P1: cognitive module wrapper
- P2: reflexão + agent identity
- P3a: `procedure_definitions`, `procedure_assignments`, status lifecycle
- P3b: `procedure_executions`, `procedure_execution_events`, `procedure_selector_decisions`, engine + selector

## Feature flag

`FEATURE_PROCEDURE_RUNTIME` (ativada em P3b — P3c herda). Sem ela, runtime fica desativado mas o schema P3c continua aplicado normalmente.

## Operações

### Aplicar migrations

```bash
pnpm run db:migrate
# ou diretamente:
psql "$DATABASE_URL" -f migrations/023_p3c_procedure_tests.sql
psql "$DATABASE_URL" -f migrations/024_p3c_procedure_metrics.sql
```

A migration 024 popula a matview vazia (`WITH NO DATA` em CREATE seguido de `REFRESH MATERIALIZED VIEW`). Primeiro refresh é blocking; subsequentes são `CONCURRENTLY`.

### Refresh manual da matview

```bash
psql "$DATABASE_URL" -c "REFRESH MATERIALIZED VIEW CONCURRENTLY procedure_metrics;"
```

`CONCURRENTLY` exige unique index na matview (já presente). Sem `CONCURRENTLY` toma lock exclusivo e bloqueia leituras.

### Listar stale executions (preview do que reaper marcaria)

```sql
SELECT id, conversa_id, definition_id, last_activity_at, now() - last_activity_at AS stale_for
FROM procedure_executions
WHERE status = 'in_progress'
  AND last_activity_at < now() - interval '7 days'
ORDER BY last_activity_at;
```

### Forçar reaper ad-hoc

```typescript
import { runProcedureExecutionReaper } from '@/workers/procedure-execution-reaper.js';
await runProcedureExecutionReaper();
```

O worker itera por tenant e respeita `PROCEDURE_TTL_DAYS`.

### Configurar TTL

```env
PROCEDURE_TTL_DAYS=14
```

Default 7. Valores razoáveis: 3 (agressivo, dev), 7 (default), 14-30 (negócio com ciclos longos).

## Criando procedure_tests

Cada test descreve um cenário de conversa esperado, com turns do user/agent e (opcionalmente) confirmações humanas.

### Exemplo de scenario JSON

```json
{
  "turns": [
    { "role": "user", "message": "preciso de ajuda" },
    { "role": "agent", "response_text": "Claro, posso ajudar com X.", "tools_called": [] },
    { "role": "user", "message": "sim, pode prosseguir" }
  ],
  "human_confirmations": []
}
```

Para steps com `human_confirmed`:

```json
{
  "turns": [
    { "role": "user", "message": "executar deploy" },
    { "role": "agent", "response_text": "Aguardando aprovação." }
  ],
  "human_confirmations": [
    { "step_id": "approval_step", "decision": "approved", "by": "ops@example.com" }
  ]
}
```

### Rodar um test ad-hoc

```typescript
import { runProcedureTest } from '@/procedures/test-runner.js';

const result = await runProcedureTest({
  definition_id: '<uuid>',
  test_id: '<uuid>',
});
console.log(result); // { status: 'pass' | 'fail', failed_step?, reason?, duration_ms }
```

### Atualizar `last_run_status`

`runProcedureTest` chama `procedureTestsRepo.recordRun` internamente. Para gravar manualmente:

```typescript
import { procedureTestsRepo } from '@/db/repositories.js';

await procedureTestsRepo.recordRun({
  test_id: '<uuid>',
  status: 'pass',
  reason: null,
  duration_ms: 1234,
});
```

## Lendo procedure_metrics

```sql
-- Procedures com baixa taxa de sucesso
SELECT *
FROM procedure_metrics
WHERE tenant_id = $1
  AND success_rate < 0.8
ORDER BY success_rate;

-- Top 10 mais executadas
SELECT definition_id, name, total_executions, success_rate
FROM procedure_metrics
WHERE tenant_id = $1
ORDER BY total_executions DESC
LIMIT 10;
```

Refresh é assíncrono (a cada 15min via worker `procedure_metrics_refresh`) — leitura pode ter pequena defasagem. Para forçar refresh imediato:

```typescript
import { runProcedureMetricsRefresh } from '@/workers/procedure-metrics-refresh.js';
await runProcedureMetricsRefresh();
```

## Test gate (proposed → active)

Promoção de status `proposed → active` agora exige tests passando:

- **Sem tests cadastrados** → erro `tests_required`. Crie pelo menos 1 test antes de promover.
- **Algum test com `last_run_status != 'pass'`** → erro `tests_not_passing`. A resposta inclui lista de IDs dos tests falhos.
- **Tests com `last_run_status='not_run'`** → tratado como falha. Rode os tests primeiro.

### Workaround para legacy

Procedures antigas (criadas pre-P3c) ficam bloqueadas até receber tests. Para destravar uma procedure já considerada estável:

1. Criar 1 test minimalmente representativo via `procedureTestsRepo.create`.
2. Rodar `runProcedureTest` e confirmar pass.
3. Promover normalmente.

Não há bypass do gate — é intencional.

## Troubleshooting

### Matview desatualizada

1. Rodar refresh manual (ver seção acima).
2. Checar logs do worker `procedure_metrics_refresh` — ele loga duração de cada refresh em `cognitive_module_log`/`worker_log` (depende do setup de logs).
3. Se refresh está lento (> 30s): considerar adicionar partial indexes em `procedure_executions(definition_id, status)`.

### Judge timeout (`llm_judge`)

`runCognitiveModule` aplica fallback automático: na ausência de resposta do LLM (timeout, error), o evaluator retorna `passed=false` — step NÃO avança. Para diagnosticar:

```sql
SELECT module, model, latency_ms, success, error_message
FROM cognitive_module_log
WHERE module LIKE 'step-evaluator.llm_judge%'
ORDER BY created_at DESC
LIMIT 50;
```

Se o judge consistentemente falha: revisar prompt do critério (`criterion.prompt`) — pode estar mal formulado ou exigindo contexto que o evaluator não tem.

### Reaper marcou execução ainda ativa

Cenário: agente estava processando mas demorou > TTL para o próximo turno (ex: long-running tool call).

1. Investigar `last_activity_at` na execution: o agent não está atualizando entre turnos?
2. Verificar se `procedureExecutionsRepo.touchActivity` está sendo chamada no engine antes de cada decisão de step.
3. Reabrir execução manualmente:

```sql
UPDATE procedure_executions
SET status = 'in_progress',
    outcome = NULL,
    ended_at = NULL,
    last_activity_at = now(),
    notes = COALESCE(notes, '') || ' (reopened from abandoned by ops)'
WHERE id = '<uuid>';

INSERT INTO procedure_execution_events (tenant_id, agent_id, execution_id, event_type, payload)
VALUES ('<tenant>', '<agent>', '<uuid>', 'manually_reopened', '{"reason":"reaper_false_positive"}'::jsonb);
```

4. Se padrão recorrente: aumentar `PROCEDURE_TTL_DAYS` ou rever fluxo.

### Step evaluator não avança step com `human_confirmed`

Confirmar que `recordHumanConfirmation` foi chamado com:
- `decision='approved'` (não `'pending'` ou `'rejected'`)
- `step_id` correto (que casa com `current_step_id` da execution)
- Mesmo `execution_id`

Query de diagnóstico:

```sql
SELECT step_id, decision, decided_by, decided_at
FROM procedure_human_confirmations
WHERE execution_id = '<uuid>'
ORDER BY decided_at DESC;
```

Se a confirmação está como `pending`, o evaluator retorna `passed=false` (espera próximo turno). Decisão de approve/reject vem do fluxo de aprovação humana (não do agent).

### Test falha por motivo não-óbvio

`runProcedureTest` grava `reason` em `last_run_reason`. Consultar:

```sql
SELECT id, name, last_run_status, last_run_reason, last_run_at, last_run_duration_ms
FROM procedure_tests
WHERE definition_id = '<uuid>'
ORDER BY last_run_at DESC;
```

Common causes:
- `expected_outcome` mismatch (test esperava `success`, execution terminou `failure`)
- Step diverge (test esperava sair do step X no turn 3, mas saiu no turn 2)
- Human confirmation faltando no scenario

## Rollback

Sequência (drop matview ANTES das tabelas):

```bash
psql "$DATABASE_URL" -f migrations/024_p3c_procedure_metrics_down.sql
psql "$DATABASE_URL" -f migrations/023_p3c_procedure_tests_down.sql
```

Após rollback do schema, desabilitar workers:

1. Comentar as entradas em `src/workers/index.ts`:

```typescript
// { name: 'procedure_execution_reaper', cron: '0 * * * *', fn: runProcedureExecutionReaper, phase: 3 },
// { name: 'procedure_metrics_refresh', cron: '*/15 * * * *', fn: runProcedureMetricsRefresh, phase: 3 },
```

2. Fazer deploy.
3. Step evaluator volta a comportamento P3b (apenas `machine_check` e `tool_result` avançam automaticamente; outros tipos travam até intervenção manual).

Nota: rollback do step evaluator não exige código — basta voltar o branch ou fazer revert dos arquivos `step-evaluator.ts` e workers.

## Validação completa

```bash
bash scripts/p3c-acceptance-gates.sh
```

Se verde:
```bash
git tag p3c-procedure-governance-done
git push origin p3c-procedure-governance-done
```

## Próximas fases

- **P4**: Self-model / capability acquisition (detector de gaps via métricas P3c)
- **P5**: Dialogical capability acquisition usando `procedure_tests` como contrato
