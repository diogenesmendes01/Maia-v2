# Runbook — P4 Identidade Operacional Versionada + Drift Detector

> Como operar, debugar e dar rollback rápido na camada de identidade operacional governada e no detector de drift comportamental.

## O que é P4

Fase de governança sobre a identidade comportamental do agent. Adiciona:

- `agent_operational_profile_versions`: versionamento imutável do perfil operacional (tom, valores, fronteiras, vocabulario). Cada mudança gera nova versão (`proposed → active → frozen | rolled_back`). Apenas 1 versão `active` por (tenant, agent) por vez.
- `agent_drift_alerts`: alertas tipados quando o comportamento observado divergir do perfil ativo. 7 tipos × 4 severidades.
- 7 detectores cognitivos: `tom`, `valores`, `confianca`, `vies`, `escopo`, `linguagem`, `procedimento`.
- Decision engine: agrega evidências dos detectores em uma decisão única (`monitor` | `alert_only` | `freeze_version` | `rollback_version`).
- Worker `drift_monitor`: rodada semanal (domingo 03h) que processa uma janela de conversas e dispara detectores.
- Feature flag `FEATURE_OPERATIONAL_PROFILE_V2`: corta consumo do perfil versionado pelo prompt-builder. Default OFF para rollout seguro.

## Escopo

- 2 tabelas (migrations 025+026)
- 7 detectores cognitivos (todos rodando via `runCognitiveModule` para logs + fallback)
- 1 decision engine determinístico
- 1 worker semanal (`drift_monitor`)
- 1 feature flag (`FEATURE_OPERATIONAL_PROFILE_V2`)
- Defesa runtime em `prompt-builder.ts`: só consome profile se `status === 'active'` E flag ON. Fallback automático para `self_state` legado caso contrário.

## Dependências

P4 depende de P0/P1/P2/P3a/P3b/P3c já aplicados:

- P0: schema base + tenant context
- P1: cognitive module wrapper (`runCognitiveModule`)
- P2: reflexão + agent identity
- P3a/P3b/P3c: procedures (referenciadas pelo detector `procedimento`)

## Feature flag

`FEATURE_OPERATIONAL_PROFILE_V2` (default OFF). Ativar:

```env
FEATURE_OPERATIONAL_PROFILE_V2=true
```

Sem a flag, prompt-builder ignora a versão ativa e continua usando o campo `self_state` legado em `agent_identity`. O schema P4 continua aplicado e o worker `drift_monitor` segue rodando (gravando alertas sem afetar prompt) — útil para shadow mode antes do flip.

## Operações

### Aplicar migrations

```bash
pnpm run db:migrate
# ou diretamente:
psql "$DATABASE_URL" -f migrations/025_p4_agent_operational_profile_versions.sql
psql "$DATABASE_URL" -f migrations/026_p4_agent_drift_alerts.sql
```

Migration 026 referencia 025 via FK (`agent_drift_alerts.version_id → agent_operational_profile_versions.id`) — ordem de aplicação é obrigatória.

### Seed inicial

Após migrations aplicadas, rodar uma vez por (tenant, agent) para criar a versão 1 `active` derivada de `agent_identity`:

```typescript
import { runWithTenantContext } from '@/db/tenant-context.js';
import { seedInitialOperationalProfile } from '@/identity/proposal-generator.js';

await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
  const r = await seedInitialOperationalProfile();
  console.log(r);
});
```

Idempotente — segunda chamada retorna `{ created: false, reason: 'already_seeded' }`. Sem seed, prompt-builder cai em fallback (mesmo com flag ON) e loga warning `profile_v2_invalid_fallback_to_legacy`.

### Inspecionar versões

```sql
-- Todas as versões de um agent
SELECT version, status, proposed_by, activated_at, frozen_at, rolled_back_at
FROM agent_operational_profile_versions
WHERE tenant_id = $1
ORDER BY version DESC;

-- Apenas versão ativa
SELECT version, core_immutable, operational_layer, activated_at
FROM agent_operational_profile_versions
WHERE tenant_id = $1 AND status = 'active';
```

### Transições manuais

```typescript
import { operationalProfileVersionsRepo } from '@/db/repositories.js';

// Aprovar proposed → active (ativa a versão e congela a anterior automaticamente)
await operationalProfileVersionsRepo.transition({
  id: '<version-id>',
  to: 'active',
  approved_by: 'operator-X',
});

// Forçar rollback (active → rolled_back)
await operationalProfileVersionsRepo.transition({
  id: '<version-id>',
  to: 'rolled_back',
  approved_by: 'operator-X',
  rollback_reason: 'CRITICAL drift detected em tom — usuários reportaram tom corporativo desalinhado',
});
```

Transições inválidas (ex: `frozen → active`) lançam erro `invalid_transition`.

## Drift detection

### Cron

Worker `drift_monitor` roda semanalmente (`0 3 * * 0` — domingo 03h UTC). Processa janela de 7d de conversations por tenant.

### Rodar manualmente

```typescript
import { runDriftMonitor } from '@/workers/drift-monitor.js';
await runDriftMonitor();
```

Itera por tenant, busca versão ativa, monta janela de evidência, dispara os 7 detectores em paralelo via `runCognitiveModule`, agrega via decision engine, persiste alerts.

### Inspecionar alertas

```sql
-- Alertas não resolvidos por tenant
SELECT drift_type, severity, decision, evidence, created_at
FROM agent_drift_alerts
WHERE tenant_id = $1 AND resolved_at IS NULL
ORDER BY severity DESC, created_at DESC;

-- Histórico por tipo
SELECT drift_type, severity, decision, COUNT(*) AS n
FROM agent_drift_alerts
WHERE tenant_id = $1
GROUP BY drift_type, severity, decision
ORDER BY n DESC;
```

`evidence` é JSONB — contém amostras de conversa, scores por detector, output do decision engine.

### Resolver alerta

```typescript
import { driftAlertsRepo } from '@/db/repositories.js';

await driftAlertsRepo.resolve({
  id: '<alert-id>',
  resolution_note: 'Falso positivo — tom mais formal foi solicitado explicitamente pelo cliente neste período.',
  resolved_by: 'operator-X',
});
```

## Rollback < 1 minuto (caminho recomendado em incidente)

Se o profile V2 estiver causando comportamento inadequado em produção, **NÃO** precisa restart.

```typescript
import { featureFlags, FeatureFlagName } from '@/config/feature-flags.js';
featureFlags.killSwitch(FeatureFlagName.OPERATIONAL_PROFILE_V2);
```

Toma efeito **IMEDIATO** — `featureFlags.isEnabled(...)` passa a retornar `false` sem restart de processo. Na próxima chamada a `buildPrompt`, o prompt-builder vê a flag killed e volta a usar o `self_state` legado.

Para reverter o kill-switch:

```typescript
featureFlags.unkillSwitch(FeatureFlagName.OPERATIONAL_PROFILE_V2);
```

Exposição típica é via admin REPL ou endpoint privado em `/admin/feature-flags`.

## Rollback persistente (pós-incidente)

Para tornar o rollback permanente entre reinícios:

```env
FEATURE_OPERATIONAL_PROFILE_V2=false
```

`pm2 restart all` (ou equivalente do orquestrador). ~30s de janela.

Kill-switch runtime é volátil — só vale para o processo atual. Sem flip de env, próximo restart traz a flag de volta ao valor do `.env`.

## Troubleshooting

| Sintoma | Diagnóstico | Ação |
|---|---|---|
| Profile V2 ativado mas prompt usa `self_state` | Conferir `featureFlags.isEnabled(FeatureFlagName.OPERATIONAL_PROFILE_V2)` | Conferir env var + restart, ou conferir kill-switch ativo |
| Warning `profile_v2_invalid_fallback_to_legacy` no log | Profile retornado tem `status !== 'active'` (provavelmente foi para `frozen` ou `rolled_back`) | `SELECT status FROM agent_operational_profile_versions WHERE tenant_id = $1 AND agent_id = $2 ORDER BY version DESC` — promover uma versão para `active` ou criar nova proposed |
| Sem versões para o tenant (`buildPrompt` em fallback constante) | Seed nunca rodou | Rodar `seedInitialOperationalProfile()` para o tenant em questão |
| Drift CRÍTICO disparou `rollback_version` errado | Consultar `agent_drift_alerts.evidence` da decision para entender o gatilho | Reverter manualmente: `operationalProfileVersionsRepo.create` com `core_immutable` da versão anterior, depois `transition({ to: 'active' })`. Documentar incident review |
| Drift detector falhando consistentemente | Conferir `cognitive_module_log` para timeouts/erros | `SELECT module, model, latency_ms, success, error_message FROM cognitive_module_log WHERE module LIKE 'drift.%' ORDER BY created_at DESC LIMIT 50` — investigar Anthropic API health, possivelmente reduzir tamanho da janela de evidência |
| Decision engine sempre `monitor` apesar de drift óbvio | Thresholds podem estar mal calibrados para o tenant | Inspecionar `agent_drift_alerts.evidence.detector_scores`. Se sinal forte mas score baixo, revisar prompts dos detectores em `src/cognition/drift/*.ts` |
| Múltiplas versões `active` simultâneas | Constraint violado — não deve acontecer | Bug grave. Conferir DB: `SELECT count(*) FROM agent_operational_profile_versions WHERE tenant_id = $1 AND agent_id = $2 AND status = 'active'`. Esperado: 1. Se > 1, escolher a mais recente e forçar as outras para `frozen` manualmente |

## Rollback de migration

Ordem importa (FK): drop `agent_drift_alerts` ANTES de `agent_operational_profile_versions`.

```bash
psql "$DATABASE_URL" -f migrations/026_p4_agent_drift_alerts_down.sql
psql "$DATABASE_URL" -f migrations/025_p4_agent_operational_profile_versions_down.sql
```

Após rollback do schema, desabilitar worker em `src/workers/index.ts`:

```typescript
// { name: 'drift_monitor', cron: '0 3 * * 0', fn: runDriftMonitor, phase: 4 },
```

Fazer deploy. Prompt-builder volta a comportamento P3c (flag desativada já levava ao mesmo fallback de `self_state` legado).

## Validação após deploy

```bash
bash scripts/p4-acceptance-gates.sh
```

Exit 0 esperado. Smoke test adicional:

1. `seedInitialOperationalProfile()` para tenant de teste.
2. Conferir versão `active` via SQL.
3. Habilitar flag (`FEATURE_OPERATIONAL_PROFILE_V2=true`).
4. Chamar `buildPrompt({...})` via REPL.
5. Conferir que o prompt renderizado contém o conteúdo de `operational_layer` (tom, valores) e não cai em fallback.

## Próximas fases

- **P4 done + 2 semanas stable** → flip flag default para ON (spec §7.3 P4.5).
- **P5**: dialogical capability acquisition — consome `agent_drift_alerts` como sinal de capability gap (ex: drift recorrente em `escopo` sugere proposta de novo procedure ou tool).
