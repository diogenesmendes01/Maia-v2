# Runbook — P5 Aquisição Dialógica de Capacidades

> Como operar, debugar e dar rollback rápido na camada de aquisição dialógica de capabilities: gap escalation determinístico, capability proposer (LLM), test runner com revert path.

## O que é P5

Fase em que o agent passa de "reconhece limitação" para "propõe formalmente uma capability nova". Adiciona:

- `gap_escalation_rules`: thresholds por tenant (defaults sensatos) — controlam quando um gap sobe de nível (silent → dashboard → mentionable → proposed).
- `capability_proposals`: propostas formais geradas pelo agent. Estado tipado (`submitted → approved | rejected → delivered`). Apenas owner aprova; agent apenas propõe.
- `capability_test_results`: resultados de testes pós-delivery. Outcome `pass` consolida; `fail` aciona revert (cria gap técnico no pipeline).
- Tipo extendido em `agent_capability_gaps.tipo`: agora aceita `technical` (gerado por revert) além dos tipos P2.
- Engine determinístico (`gap-escalation/engine.ts`) — **zero chamadas LLM** — agrega evidência e decide o novo `current_level`.
- LLM proposer (Sonnet) — único módulo que gasta tokens em P5, e só dispara quando engine decide `proposed`.
- Test runner com 2 strategies (`echo_test` smoke, `knowledge_match` placeholder).
- Adapter de notificação respeitando o nível (silent não notifica; outros vão para dashboard, mention canal, etc).
- Worker `gap_escalation_monitor` (cron `*/30 * * * *`).
- Feature flag `FEATURE_DIALOGICAL_ACQUISITION` (default OFF).

## Escopo

- 4 migrations (027 gap_escalation_rules, 028 capability_proposals, 029 capability_test_results, 030 extend tipo).
- 3 repositories tipados (`gapEscalationRulesRepo`, `capabilityProposalsRepo`, `capabilityTestResultsRepo`).
- 1 engine determinístico (`src/cognition/gap-escalation/engine.ts`) — sem LLM, sem network.
- 1 LLM proposer (`src/cognition/capability/proposer.ts`) — usa Sonnet via `runCognitiveModule`.
- 1 test runner com revert path (`src/cognition/capability/test-runner.ts` + `capability-revert.ts`).
- 1 worker (`src/workers/gap-escalation-monitor.ts`).
- 1 notification adapter (`src/agent/notification-adapter.ts`).
- 1 feature flag (`FEATURE_DIALOGICAL_ACQUISITION`).

## Dependências

P5 depende de P0/P1/P2/P3/P4 já aplicados:

- P0: schema base + tenant context.
- P1: cognitive module wrapper (`runCognitiveModule`), `gap-detector.ts` (já existente em `src/agent/`).
- P2: `agent_capability_gaps`, `capability-tracker`, reflexão.
- P3: procedures (referenciadas via `proposed_spec` quando proposta sugere novo procedure).
- P4: identidade operacional versionada (drift signals podem reforçar gap evidence).

## Feature flag

`FEATURE_DIALOGICAL_ACQUISITION` (default OFF). Ativar:

```env
FEATURE_DIALOGICAL_ACQUISITION=true
```

Com a flag OFF, o engine determinístico continua escalando gaps (sem custo Sonnet), mas o LLM proposer **NÃO** dispara em `proposed`. Isso permite shadow mode antes do flip. Test runner também é controlado pela flag.

Kill-switch via REPL no caminho de incidente:

```typescript
import { featureFlags, FeatureFlagName } from '@/config/feature-flags.js';
featureFlags.killSwitch(FeatureFlagName.DIALOGICAL_ACQUISITION);
// Reverter:
featureFlags.unkillSwitch(FeatureFlagName.DIALOGICAL_ACQUISITION);
```

## Como gaps são detectados

Detecção segue exatamente o mecanismo P1/P2:

- `gap-detector.ts` em `src/agent/` (P1) já analisa cada resposta do agent. Se identifica auto-reconhecimento de limitação (ex: "não sei calcular X", "nunca aprendi a Y"), gera um candidato de reflexão.
- `capability-tracker` (P2) atualiza `confidence` do skill envolvido e upserta o gap em `agent_capability_gaps` com `current_level='silent'` no primeiro contato.
- P5 não altera a detecção — apenas observa o ciclo de vida do gap e aplica regras de escalation.

## Escalation rules

Linha em `gap_escalation_rules` por tenant. Se não existir, defaults são aplicados:

- `dashboard_freq = 3` — número de ocorrências para subir de silent para dashboard.
- `mentionable_sev = 5` — severidade mínima (1..10) para chegar a mentionable.
- `proposed_combined = 8` — score combinado (freq + sev + contexts) para subir a proposed.
- `contexts_required = 2` — diferentes contextos onde o gap apareceu (evita escalada por pico ruidoso).
- `cooldown_days = 14` — janela mínima após rejeição/delivery antes de re-escalar o mesmo gap.

Customizar por tenant via SQL:

```sql
-- Conferir defaults aplicados
SELECT * FROM gap_escalation_rules WHERE tenant_id = $1;

-- Inserir/atualizar
INSERT INTO gap_escalation_rules (tenant_id, dashboard_freq, mentionable_sev, proposed_combined, contexts_required, cooldown_days)
VALUES ($1, 5, 6, 10, 3, 21)
ON CONFLICT (tenant_id) DO UPDATE SET
  dashboard_freq = EXCLUDED.dashboard_freq,
  mentionable_sev = EXCLUDED.mentionable_sev,
  proposed_combined = EXCLUDED.proposed_combined,
  contexts_required = EXCLUDED.contexts_required,
  cooldown_days = EXCLUDED.cooldown_days;
```

## Como inspecionar gaps por nível

```sql
-- Todos os gaps de um tenant com nível atual
SELECT id, capability, tipo, severity, frequency, current_level, last_seen_at
FROM agent_capability_gaps
WHERE tenant_id = $1
ORDER BY current_level DESC, severity DESC;

-- Apenas gaps em proposed (aguardando proposer)
SELECT * FROM agent_capability_gaps
WHERE tenant_id = $1 AND current_level = 'proposed';

-- Gaps técnicos criados via revert
SELECT * FROM agent_capability_gaps
WHERE tenant_id = $1 AND tipo = 'technical';
```

Níveis válidos: `silent`, `dashboard`, `mentionable`, `proposed`.

## Como ver propostas pendentes

```sql
-- Propostas submetidas aguardando decisão do owner
SELECT id, title, status, gap_id, motivation, created_at
FROM capability_proposals
WHERE tenant_id = $1 AND status = 'submitted'
ORDER BY created_at;

-- Detalhe de uma proposta (proposed_spec contém JSON tipado)
SELECT id, title, motivation, proposed_spec, test_scenarios, status
FROM capability_proposals
WHERE id = $1;
```

## Como aprovar/rejeitar proposta

Via REPL ou script administrativo:

```typescript
import { capabilityProposalsRepo } from '@/db/repositories.js';

// Aprovar
await capabilityProposalsRepo.transition({
  id: '<proposal-id>',
  to: 'approved',
  decided_by: 'operator-X',
  decision_reason: 'Capability faz sentido — gap recorrente em 3 contextos diferentes',
});

// Rejeitar
await capabilityProposalsRepo.transition({
  id: '<proposal-id>',
  to: 'rejected',
  decided_by: 'operator-X',
  decision_reason: 'Capability fora do escopo do produto — gap deveria ser fechado via FAQ',
});
```

Owner deve revisar `proposed_spec` (campos `kind`, `target_outcome`, `inputs`, `constraints`, etc) antes de aprovar. Rejeições disparam cooldown — gap não re-escala até `cooldown_days` passar.

## Como marcar `delivered`

Após dev implementar a capability (novo procedure, tool, prompt update, etc), marcar a proposta como entregue:

```typescript
import { capabilityProposalsRepo } from '@/db/repositories.js';

await capabilityProposalsRepo.transition({
  id: '<proposal-id>',
  to: 'delivered',
  delivery_artifact_ref: 'pr-1234', // ou commit hash, ou identificador interno
});
```

Isso sinaliza ao test runner (próxima chamada manual ou via worker integration futura) que a capability está pronta pra ser testada.

## Como o test runner funciona

```typescript
import { runCapabilityTests } from '@/cognition/capability/test-runner.js';

const r = await runCapabilityTests({ proposal_id: '<proposal-id>' });
console.log(r); // { passed: N, failed: M, results: [...] }
```

Comportamento:

- Itera por `proposal.test_scenarios[]`.
- Para cada scenario, escolhe strategy:
  - `echo_test`: smoke — valida que o agent consegue produzir output mínimo coerente.
  - `knowledge_match`: placeholder P5 — match simples contra `expected_outcome`. Será substituído por evals reais em P6+.
- Persiste cada resultado em `capability_test_results` com `outcome ∈ {pass, fail}`.
- Outcome `pass`: tudo certo, capability consolidada.
- Outcome `fail`: dispara revert path (próxima seção).

## Revert path

Se algum scenario falhar:

1. `capability-revert.ts` cria **novo** gap em `agent_capability_gaps` com:
   - `tipo = 'technical'`
   - `capability = '[técnica] <título original> falhou pós-ativação'`
   - `severity` proporcional ao número de scenarios que falharam
   - `current_level = 'silent'` (inicia ciclo limpo)
2. `capability_test_results.triggered_revert = true` na row do scenario que falhou.
3. Esse novo gap técnico entra no pipeline de escalation normalmente — pode subir de nível, eventualmente virar nova proposta de correção.
4. Owner audita revert via:

```sql
SELECT ctr.id, ctr.proposal_id, ctr.scenario_index, ctr.outcome, ctr.error_message, cp.title
FROM capability_test_results ctr
JOIN capability_proposals cp ON cp.id = ctr.proposal_id
WHERE ctr.tenant_id = $1 AND ctr.triggered_revert = true
ORDER BY ctr.created_at DESC;
```

## Rollback < 1 minuto (caminho recomendado em incidente)

Se proposer estiver gerando lixo ou test runner derrubando capabilities boas, **NÃO** precisa restart.

```typescript
import { featureFlags, FeatureFlagName } from '@/config/feature-flags.js';
featureFlags.killSwitch(FeatureFlagName.DIALOGICAL_ACQUISITION);
```

Toma efeito **IMEDIATO**. Engine continua coletando dados (deterministic, custo zero), mas:

- Proposer não dispara em `proposed` → zero gasto Sonnet.
- Test runner não roda.
- Worker `gap_escalation_monitor` segue ativo, mas não invoca paths bloqueados pela flag.

Para reverter:

```typescript
featureFlags.unkillSwitch(FeatureFlagName.DIALOGICAL_ACQUISITION);
```

Exposição típica via admin REPL ou endpoint privado `/admin/feature-flags`.

## Rollback persistente (pós-incidente)

Para tornar o rollback permanente entre reinícios:

```env
FEATURE_DIALOGICAL_ACQUISITION=false
```

`pm2 restart all` (ou equivalente). ~30s de janela.

Kill-switch runtime é volátil — só vale para o processo atual.

## Troubleshooting

| Sintoma | Diagnóstico | Ação |
|---|---|---|
| Gap não escala | Verificar `gap_escalation_rules` thresholds vs evidência atual | Ajustar via SQL UPDATE; conferir `frequency`, `severity`, `contexts` do gap |
| Proposer não dispara em `proposed` | Flag OFF ou Sonnet down | Conferir `featureFlags.isEnabled(FeatureFlagName.DIALOGICAL_ACQUISITION)` + `cognitive_module_log` para `capability.proposer` |
| Test runner stuck | Proposta não está em `delivered` | Marcar via `capabilityProposalsRepo.transition({ to: 'delivered', delivery_artifact_ref: '...' })` |
| Revert criou loop | Gap técnico subiu para `proposed` rapidamente pelo cooldown ainda não atingido | Owner intervém manualmente; gap técnico pode ser rejeitado direto via UPDATE em `capability_proposals.status='rejected'` se já tiver proposta |
| Sonnet drift (muitas propostas rejeitadas) | Prompt do proposer pode estar mal calibrado | Owner pode customizar prompt no proposer (workflow futuro P6+). Curto prazo: aumentar `proposed_combined` threshold no tenant |
| `gap_escalation_monitor` não roda | Worker não registrado ou erro silencioso | `grep gap_escalation_monitor src/workers/index.ts`; conferir logs do scheduler |
| Notification adapter notificou em `silent` | Bug — silent deve sempre ser no-notify | Conferir `src/agent/notification-adapter.ts` — guard `if (level === GapLevel.SILENT) return` deve existir |

## Rollback de migrations

Ordem importa (FKs): 030 → 029 → 028 → 027.

```bash
# Atenção: 030 down dropa rows com tipo='technical'
psql "$DATABASE_URL" -f migrations/030_p5_extend_capability_gap_tipo_down.sql
psql "$DATABASE_URL" -f migrations/029_p5_capability_test_results_down.sql
psql "$DATABASE_URL" -f migrations/028_p5_capability_proposals_down.sql
psql "$DATABASE_URL" -f migrations/027_p5_gap_escalation_rules_down.sql
```

**CUIDADO** com 030 down: deleta todas as rows com `tipo='technical'` em `agent_capability_gaps` antes de restaurar o CHECK constraint original. Se houver auditoria pendente, exportar primeiro.

Após rollback do schema, desabilitar worker em `src/workers/index.ts`:

```typescript
// { name: 'gap_escalation_monitor', cron: '*/30 * * * *', fn: runGapEscalationMonitor, phase: 5 },
```

Fazer deploy. Sistema volta a comportamento P4 (gaps continuam sendo upserted via P2, mas nenhuma escalation/proposta automática).

## Validação após deploy

```bash
bash scripts/p5-acceptance-gates.sh
```

Exit 0 esperado. Smoke test adicional:

1. Criar gap mock para tenant de teste via SQL/repo.
2. Forçar escalação chamando engine direto:
   ```typescript
   import { escalateGap } from '@/cognition/gap-escalation/engine.js';
   const decision = await escalateGap({ gap_id: '<id>' });
   console.log(decision); // { new_level, reason, rule_matched }
   ```
3. Conferir log do worker em `cognitive_module_log` (filtra por `module = 'gap-escalation-monitor'`).
4. Com flag ON: se gap chegar a `proposed`, conferir que `capability_proposals` tem nova row com `status='submitted'`.

## Próxima fase

- **P5 done + 2 semanas stable** → flip flag default para ON.
- **P6**: Channel/Role/Policy — refactor estrutural do gateway multi-channel (Agent ≠ Channel ≠ Role). Separação de identidade de unidade de isolamento das entradas e modos operacionais.
