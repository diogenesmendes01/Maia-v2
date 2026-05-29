# Runbook — P8d Identity Completion

> Como executar a migração de dados que popula `priorities[]`, monitorar o detector `papel_drift`, e dar rollback rápido em caso de freeze.

## O que é P8d

Quatro completions sobre o `profile_body` (schema v3.1.1, já em produção via P4):

1. **`priorities[]`** populado em todas as versões `active` existentes (script + futuros seeds via `proposal-generator`).
2. **`learned_voice_modifiers`** com tipo concreto (`LearnedVoiceModifier`) + Zod no write-path (era `unknown[]`).
3. **`papel_drift`** — 9º detector de drift (alongside `soul_drift` de P8b).
4. **`identity-slice-builder`** — produz `IdentitySlice` (consumido por `ContextPacket` de P8a).

Uma migration DDL pequena (042 — extende CHECK do `drift_type`); tudo o mais é código + dados.

## Escopo

- 1 migration DDL (`042_p8d_extend_drift_type_papel.sql`) — adiciona `'papel_drift'` ao CHECK constraint de `agent_drift_alerts.drift_type` (idempotente, com `IF EXISTS`). Necessária porque migration 026 fixou os 7 tipos iniciais; sem 042 a `INSERT` de alert papel_drift falha **depois** de freeze/rollback ter mutado o profile (review #100).
- 1 detector novo (`papel_drift`).
- 1 enum novo (`DriftType.PAPEL_DRIFT='papel_drift'`).
- 1 case novo no `decision-engine.ts` (`PAPEL_DRIFT` com floor rules).
- 1 script de migração de dados (idempotente, transactional por tenant/agent via `seedNewActiveAtomic`).
- 1 builder de slice (`identity-slice-builder.ts`) com fallback para legacy `core_immutable`.
- 1 tipo Zod (`LearnedVoiceModifier`).
- 1 método novo no repo (`operationalProfileVersionsRepo.seedNewActiveAtomic`) — wrappa create+freeze+insert em `withTx` + `FOR UPDATE` (review #100).
- Validação de `cognitive_limits` + `learned_voice_modifiers` em `operationalProfileVersionsRepo.create`.

## Feature flag

Sem flag nova. Estende `FEATURE_OPERATIONAL_PROFILE_V2` (já registrada em P4).

- Flag OFF → priorities, papel_drift e slice builder ficam dormentes
- Flag ON → priorities populadas; papel_drift roda no orchestrator semanal; identity-slice-builder pronto para P9 consumir

A validação de write-path (`cognitive_limits`, `learned_voice_modifiers`) é **sempre ativa** (defesa em depth, invariante da DB).

## Aplicar a migração de dados

**Pré-requisito:** PR mergeada em `main`.

### Ordem (espaçar 24h entre ambientes)

1. **Dev (após merge)**
2. **Staging (D+1)**
3. **Prod (D+2)**

### Comando

```bash
npx tsx scripts/p8d-migration-priorities.ts
```

### O que faz

Para cada (tenant, agent) com versão `active`:

1. Lê `src/identity/maia-prompt.md`, infere `priorities[]` via `parsePrioritiesFromMarkdown`.
2. Se a versão `active` já tem `priorities` populated → `skipped` (idempotência).
3. Senão, chama `operationalProfileVersionsRepo.seedNewActiveAtomic` que, numa única transação Postgres:
   - lock `FOR UPDATE` na row `active` atual
   - freeze antiga (`active → frozen`)
   - insert nova row direto como `active`
   - qualquer falha rola tudo back e a versão antiga permanece `active`
4. `expected_current_active_id` protege contra race com Admin UI / drift engine que tenham promovido outra versão entre o `getActive()` e o lock.

### Exit code

- `0` quando todos os agentes pular ou migrar com sucesso
- `1` quando houve ao menos uma falha por-agente (review #100). CI/runbook devem checar exit code.

### Logs estruturados

```
p8d_migrate.seeded     { tenant, agent, old_v, new_v, priorities }
p8d_migrate.already_populated_skip { tenant, agent }
p8d_migrate.failed     { tenant, agent, err }
p8d_migrate.done       { seeded, skipped, failed }
```

### Re-rodar

Idempotente. Re-rodar é seguro (skip quando já populado).

## Rollback

A versão antiga continua em `status='frozen'`. Para restaurar:

1. Identificar a versão antiga via `SELECT id, version FROM agent_operational_profile_versions WHERE tenant_id=$1 AND agent_id=$2 AND status='frozen' ORDER BY version DESC LIMIT 1`.
2. Identificar a versão nova via `... status='active' ...`.
3. Trocar via Admin UI (P8.5 Tela 3) OU manualmente:
   - `transition` nova `active → frozen` (approved_by='manual_rollback')
   - `transition` antiga `frozen → active` (approved_by='manual_rollback')

Lineage está preservado em `metadata.previous_version_id`.

## Detector `papel_drift`

### Quando dispara

Worker semanal (`drift_monitor`, P4) chama `runAllDriftDetectors`. O 9º detector (`papelDriftDetector`) verifica se as últimas mensagens do agente aderem ao `profile_body.identity.role_descriptor`.

### Floor rules de severidade (decision-engine.ts)

| `off_role_examples.length` | Severidade |
|---|---|
| ≥ 5 (ou rolesDiverge + ≥ 3) | `critico` → `rollback` |
| ≥ 3 | `alto` → `frozen` |
| 2 | `medio` → `queued_human` |
| 1 | `baixo` → `auto_approved` |
| 0 | hint do detector ou `baixo` |

### Quando o profile vai a `frozen`

`severity=alto` ou `critico` → state machine transita `active → frozen` (ou `→ rolled_back` se `critico`). O `prompt-builder` (P4 Task 7) detecta `status !== 'active'` e cai no fallback legacy.

### Inspecionar alertas

```sql
SELECT id, drift_type, severity, decision, evidence->>'reasoning' AS reasoning, created_at
  FROM agent_drift_alerts
 WHERE tenant_id = 'default' AND drift_type = 'papel_drift'
 ORDER BY created_at DESC LIMIT 20;
```

## Acceptance gates

```bash
bash scripts/p8d-acceptance-gates.sh
```

Verifica:

1. `priorities` populadas em pelo menos 1 versão active (default tenant/agent).
2. `papel_drift` detector registrado em `src/cognition/drift/index.ts`.
3. `LearnedVoiceModifier` exported como tipo concreto (não `unknown[]`).
4. `IdentitySlice` builder existe em `src/runtime/context-assembly/`.
5. `DriftType.PAPEL_DRIFT` registrado em `src/types/enums.ts`.

## Troubleshooting

### `p8d_migrate.no_priorities_inferable_global`

`maia-prompt.md` não tem `## Prioridades` nem `## Princípios` parseáveis. Edit o markdown e re-rode.

### `seed_atomic_stale_active`

A versão `active` mudou entre o `getActive()` do script (fora da tx) e o lock `FOR UPDATE` dentro do `seedNewActiveAtomic` (race com Admin UI / drift engine que promoveu outra versão). O script trata como `failed`, conta no exit code, e o estado anterior fica intacto. Re-rodar é seguro.

### `seed_atomic_freeze_failed`

A row `active` desapareceu mid-tx (deletada) OU seu `status` mudou para algo
diferente de `'active'` entre o snapshot read (FOR UPDATE) e o UPDATE de
freeze (issue #195 — predicate `status='active'` na WHERE captura escritores
concorrentes que driblam o `lockParentAgent`, ex.: drift `transition`
intercalando com um caminho de rollback out-of-band). Cenário muito raro com
o lock atual — investigar audit log.

### Race com partial unique index

O insert da nova `active` falha se outra thread driblar o lock e inserir antes (`agent_op_profile_unique_active_idx` violation). Postgres aborta a tx; nada é mutado; o script reporta `failed` e segue para o próximo agente.

### Validação de write-path

`operationalProfileVersionsRepo.create` joga `Error` se:

- `cognitive_limits.max_inference_depth` ∉ [0, 10]
- `cognitive_limits.max_speculation_in_response` ∉ [0, 1]
- `cognitive_limits.confidence_floor_for_action` ∉ [0, 1]
- Algum `learned_voice_modifiers[i]` falha o `LearnedVoiceModifierSchema.parse`

Em produção, esses erros sobem como exceção do worker / API. P9b usa esses limites em runtime do SkillRunner.

## Referências

- Plan: `docs/superpowers/plans/2026-05-15-p8d-identity-completion.md`
- Spec: `docs/superpowers/specs/2026-05-15-p8d-identity-completion-design.md`
- Master arch (Runtime v3.1.1): `docs/superpowers/specs/2026-05-15-runtime-architecture-v3-final.md`
- P4 runbook: `docs/runbooks/p4-operational-identity.md`
