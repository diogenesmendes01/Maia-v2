# Runbook — P7 Grafo Cognitivo Formal

> Como operar e debugar a camada de orquestracao via grafo cognitivo declarativo. P7 formaliza modulos cognitivos como descriptors (runWhen, timeoutMs, fallback, model, version), fecha a lacuna de cobertura de auditoria (todo modulo cognitivo emite row em `cognitive_module_log` — ver "Escopo de 100% audit coverage" em Limitacoes) e instrumenta p95 do sync path.

> **ATUALIZACAO (#412): a flag `FEATURE_COGNITIVE_GRAPH` foi REMOVIDA — o grafo e agora o unico caminho turn-time.** Nao ha mais dual-path, kill switch de flag, nem rollback "flag OFF". As secoes "Feature flag", "Rollout", "Kill switch" e "Rollback" abaixo descrevem o estado HISTORICO (pre-#412) e estao marcadas como obsoletas; o rollback hoje e por revert de commit. As secoes de **diagnostico** (queries `cognitive_module_log`, p95) e **invariantes** permanecem validas.

## O que e P7

Refactor de orquestracao que substitui o fluxo imperativo "agent chama modulo apos modulo" por um **grafo declarativo de descriptors** executado por um orchestrator generico. Zero regressao user-facing — flag `FEATURE_COGNITIVE_GRAPH` controla dual-path.

Componentes:

- **6 arquivos em `src/cognitive-graph/`**:
  - `types.ts` — `CognitiveDescriptor`, `GraphContext`, tipos da fase (preturn/postturn).
  - `registry.ts` — registro tipado de descriptors por modulo.
  - `orchestrator.ts` — executa grafo respeitando `runWhen`, `timeoutMs`, `fallback`, sync vs async, emite row em `cognitive_module_log` por execucao.
  - `latency-budget.ts` — `measureSyncP95` + `assertWithinBudget` helpers para o acceptance gate de latencia.
  - `preturn-graph.ts` — grafo de pre-turn (decisao + raciocinio).
  - `postturn-graph.ts` — grafo de pos-turn (reflexao + persistencia, async).
- **Wrappers `runCognitiveModule`** em **12 call sites** (`callLLM` envelopado): classifier, reflector, memory-classifier, behavioral-hint-deriver, procedure-selector, procedure-builder, behavioral-hint-validator, reflection-batch, conversation-summarizer, pending-gate, react-loop, role-selector/llm-suggester.
- **Feature flag `FEATURE_COGNITIVE_GRAPH`** (default OFF) — quando ON, runtime troca para o orchestrator; quando OFF, path legacy intacto.
- **Auditoria total**: cada execucao de modulo cria 1 row em `cognitive_module_log` (tenant_id, agent_id, turno_id, module_name, module_version, status, latency_ms, fallback_reason, triggered_by).

## Escopo

- Grafo declarativo: descriptor por modulo com timeout / runWhen / fallback / model / version.
- Sync vs async: descriptors marcam `triggered_by ∈ {sync_required, sync_conditional, async}`. Async nao bloqueia resposta (fire-and-forget pos-resposta).
- Isolamento de falha periferica: orchestrator captura erro/timeout de cada descriptor; se `fallback` definido, executa; senao, propaga apenas se o modulo for `sync_required`.
- 100% audit coverage: nenhum `callLLM` no codebase pode escapar do envelope `runCognitiveModule` em modulos do agente (defesa em 3 camadas: spec + integration test grep + acceptance gate script).
- Instrumentacao p95: helper `measureSyncP95` agrega `cognitive_module_log` por `turno_id`, calcula p95 das somas. `assertWithinBudget` verifica vs baseline.

## Dependencias

P7 depende de P0/P1/P2/P3/P4/P5/P6 aplicados:

- P0: `cognitive_module_log` table (migration 008) — base da auditoria.
- P1: `runCognitiveModule` wrapper (cognitive runner).
- P2: memoria/self-model — modulos referenciados pelos graphs.
- P3: procedures — `procedure-selector` e `procedure-builder` viram nodes no preturn graph.
- P4: identidade operacional — `drift-monitor` postturn (async).
- P5: aquisicao dialogica — `capability-proposer` postturn (async).
- P6: channel/role/policy — `role-selector` no preturn graph.

Compatibilidade legacy preservada com flag OFF: orchestrator nao executa; chamadas viajam pelo path imperativo herdado de P0..P6 — comportamento identico.

## Feature flag

`FEATURE_COGNITIVE_GRAPH` (default OFF). Ativar:

```env
FEATURE_COGNITIVE_GRAPH=true
```

Com a flag OFF:

- Path legacy serve 100% do trafego.
- `runCognitiveModule` (envelope) **ainda executa** — isto e, **audit coverage ja esta completa independente da flag**. A flag controla apenas o uso do orchestrator novo (preturn-graph / postturn-graph).

Com a flag ON:

- `runAgentForMensagem` chama `orchestrator.run(preturnGraph, ctx)` em vez do fluxo imperativo.
- Postturn async fica registrado em `cognitive_module_log` com `triggered_by='async'`.

## Rollout (3 etapas)

1. **Merge + deploy com flag OFF**
   - Acceptance gates verdes (`scripts/p7-acceptance-gates.sh`).
   - Path legacy continua 100% do trafego.
   - Audit coverage ja capturando 100% das chamadas LLM (envelope `runCognitiveModule` ativo).

2. **Canary com flag ON em tenant interno**
   - REPL: `featureFlags.override(FeatureFlagName.COGNITIVE_GRAPH, true)` (runtime, sem deploy).
   - Monitorar `cognitive_module_log` por 50+ turns: timeouts, fallbacks, latencia por modulo.
   - Criterio go/no-go: zero desvio user-facing detectavel + p95 dentro do budget.

3. **Flip global**
   - `FEATURE_COGNITIVE_GRAPH=true` no `.env`.
   - Manter path legacy no codigo por **>= 1 sprint** apos flip (defesa de regressao).

## Kill switch (< 1min, sem deploy)

```typescript
import { featureFlags, FeatureFlagName } from '@/config/feature-flags.js';
featureFlags.killSwitch(FeatureFlagName.COGNITIVE_GRAPH);
// Proxima request volta ao path legacy. Sem restart de processo.
```

Reverter:

```typescript
featureFlags.unkillSwitch(FeatureFlagName.COGNITIVE_GRAPH);
```

Efeito imediato:

- Orchestrator deixa de ser chamado.
- Path legacy serve a request.
- Audit continua (runCognitiveModule envelope independe da flag).

## Acceptance gates

```bash
bash scripts/p7-acceptance-gates.sh
```

Cobre 7 gates:

1. **Estrutura modular** — 6 arquivos em `src/cognitive-graph/`.
2. **Testes verdes** — unit (orchestrator, registry, types, latency-budget, preturn-graph, postturn-graph) + integration (audit-coverage, p7-cognitive-graph).
3. **Typecheck** — `tsc --noEmit` limpo.
4. **100% audit coverage** — grep prova zero `callLLM` em `src/{agent,workers,cognition}/` sem `runCognitiveModule` (claude.ts e cognition/runner.ts excluidos: infra e definicao do envelope).
5. **Flag singleton** — `FEATURE_COGNITIVE_GRAPH` registrada conforme padrao P4/P5/P6.
6. **p95 budget** — opcional (skipa se `SYNC_LATENCY_P95_BASELINE_MS` nao definido).
7. **Canary** — confirma execucao em prod quando flag ON (verificacao manual SQL post-deploy).

Variaveis de ambiente para Gate 6 (opcionais):

```bash
export SYNC_LATENCY_P95_BASELINE_MS=2500       # baseline medido pre-P7
export SYNC_LATENCY_P95_BUDGET_PERCENT=20      # default 20%
export LATENCY_TENANT_ID=default               # default 'default'
export LATENCY_AGENT_ID=default                # default 'default'
```

## Diagnostico

### "Modulo X timeoutou — onde olhar?"

Query `cognitive_module_log`:

```sql
SELECT module_name, module_version, status, latency_ms, fallback_reason, ended_at
FROM cognitive_module_log
WHERE tenant_id = $1 AND module_name = $2
  AND status IN ('timeout', 'error')
  AND ended_at > now() - interval '1 hour'
ORDER BY ended_at DESC
LIMIT 50;
```

Se timeout for sistematico:

1. Bumpar `timeoutMs` no descriptor (em `preturn-graph.ts` ou `postturn-graph.ts`).
2. Bumpar `version` do descriptor (audit fica rastreavel via `module_version`).
3. Deploy.

### "p95 estourou o budget"

Top-20 turns mais lentos nas ultimas 24h:

```sql
SELECT turno_id, SUM(latency_ms) AS total_ms
FROM cognitive_module_log
WHERE tenant_id = $1 AND triggered_by IN ('sync_required', 'sync_conditional')
  AND ended_at > now() - interval '24 hours'
GROUP BY turno_id
ORDER BY total_ms DESC
LIMIT 20;
```

Breakdown por modulo dentro de um turno especifico:

```sql
SELECT module_name, module_version, status, latency_ms, triggered_by
FROM cognitive_module_log
WHERE turno_id = '<turno_uuid>'
ORDER BY started_at;
```

Investigar:

- Qual modulo dominou o tempo?
- Tem padrao por canal/role/procedure?
- Reasoner (react-loop) emite N rows (1 por iteracao). Agregar por `turno_id` antes de comparar p95.

Mitigacao curta: kill switch o modulo via `runWhen: () => false` no descriptor (commit + deploy, ou direto via flag se modulo for opcional). Investigacao completa em seguida.

### "Audit nao esta capturando turns"

Confirmar:

1. `tenant_id` propagado via `runWithTenantContext` no entry point (`runAgentForMensagem`).
2. `turno_id` passado no `runCognitiveModule({ turno_id: inbound.id })` — verificavel em `preturn-graph.ts` (passado via `GraphContext.turno_id`).
3. `cognitive_module_log` recebe INSERT — checar pino logs do runner.

### "Gate 4 (audit coverage) falhou apos refactor"

Significa que algum arquivo em `src/{agent,workers,cognition}/` adicionou `callLLM(` sem `runCognitiveModule` no mesmo arquivo. Fix:

```typescript
// ANTES (proibido):
const result = await callLLM({ ... });

// DEPOIS:
const result = await runCognitiveModule(
  { module_name: 'my_module', module_version: 'v1', triggered_by: 'sync_required', turno_id: ctx.turno_id, ... },
  async () => callLLM({ ... }),
);
```

Gate fala qual arquivo falhou (lista offenders).

## Invariantes provados

- **Falha periferica nao derruba response** — orchestrator isola via `fallback` em descriptors `sync_conditional` (ex: drift-detector falha -> resposta segue sem flag de drift).
- **User-facing identico (zero regressao)** — dual-path + golden test (Task 10, simplificado: smoke + audit invariant) + path legacy preservado por >= 1 sprint apos flip.
- **100% audit coverage** — grep gate Task 9 (integration test) + acceptance Gate 4 + defesa em 3 camadas (spec + test + script).
- **p95 <= baseline +20%** — helper `latency-budget.ts` + acceptance Gate 6 (opcional, skipa sem baseline).

## Limitacoes conhecidas

- **Reasoner (react-loop) emite N rows** — cada iteracao da ReAct chama `runCognitiveModule`. Analytics devem agregar por `turno_id` (vide query de breakdown acima). Informacao util (latencia por iteracao), mas exige cuidado.
- **Golden test simplificado** — Option B (smoke + audit invariant), nao snapshot 1:1 do outbound text. Defesa principal de nao-regressao e o dual-path manter codigo legacy intacto + monitoring p95.
- **Gate 6 skip-friendly** — sem baseline pre-P7 medido, gate passa. Recomendacao: medir baseline antes do flip global (`SYNC_LATENCY_P95_BASELINE_MS` no `.env` da CI).
- **Sem migration nova** — P7 reusa `cognitive_module_log` (migration 008 do P0). Nao ha rollback de schema; rollback eh apenas flag OFF + revert do branch.
- **Escopo de "100% audit coverage"** — significa "todo modulo cognitivo (catalogo §8.1) emite >= 1 row por execucao". Modulos compostos (drift detectors) auditam no nivel do **orchestrator** (`drift_detector_<type>`), nao na chamada LLM interna — auditoria nested. Infra nao-cognitiva (image OCR em `src/lib/vision.ts`, embeddings, tokenizers) NAO emite row em `cognitive_module_log` por design. Grep gate cobre apenas o helper `callLLM`; chamadas SDK diretas em modulos ja envelopados em nivel superior nao sao bypass.
- **Shift de cobertura de success-reflection (PERMANENTE pos-#412)** — historicamente, no path legacy, success-reflection rodava **antes** do rate-limit/pending-gate, entao mesmo turns que terminavam em warn/resolved geravam reflexao. No grafo (postturn, agora o unico caminho), o trigger so dispara apos a resposta — turns bloqueados por rate-limit ou resolvidos no pending-gate **nao geram success-reflection**. Este e o comportamento definitivo (#412 removeu o trigger legacy). Trade-off aceitavel: reflexao nao e user-facing e e fire-and-forget; o trigger pre-turn era best-effort e nunca bloqueava resposta. Operadores que monitoram volume de reflection devem usar este post-turn como baseline.

## Rollback

> **OBSOLETO pos-#412.** A flag `FEATURE_COGNITIVE_GRAPH` foi removida e o path imperativo legacy foi deletado de `src/agent/core.ts` — nao existe mais rollback "flag OFF" nem kill switch de flag. P7 nao introduz schema, entao rollback hoje e **apenas por codigo**:

1. `git revert <commit-do-#412>` (restaura flag + path legacy) + redeploy. **Atencao:** o commit #412 tambem corrigiu paridade de auditoria do node `step-evaluator-trigger`; um revert reintroduz a divergencia (graph mode perde `tool_called`/`criterion_checked`/`step_failed`/`branch_taken`).
2. Mitigacao cirurgica sem revert total: desabilitar um node especifico via `runWhen: () => false` no descriptor (`preturn-graph.ts` / `postturn-graph.ts`) + redeploy.

Audit log (`cognitive_module_log`) permanece intacto — defesa para forensics.

## Validacao pos-deploy

```bash
bash scripts/p7-acceptance-gates.sh
```

Exit 0 esperado. Smoke test adicional:

1. Flag OFF: enviar mensagem -> conferir resposta normal + `cognitive_module_log` recebe rows (envelope ativo).
2. Flag ON em tenant interno: enviar mesma mensagem -> resposta comportamentalmente identica + `cognitive_module_log` mostra `triggered_by` correto por modulo (sync/async).
3. Comparar p95 ultimas 24h vs baseline pre-P7.

## Proxima fase

Roadmap P0..P7 completo. Proximo trabalho seria **P8+ (ex: multi-agent collaboration, ferramentas externas via MCP, ou refinamentos de seguranca)** — fora do escopo deste sprint.
