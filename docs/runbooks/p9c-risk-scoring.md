# P9c Risk Scoring — Runbook

## Overview

P9c entrega o **Risk Scorer**: fonte única de verdade para o nível de risco
de cada turno e de cada registro de conhecimento da Maia.

**Arquitetura em 2 estágios:**

1. **Heurística determinística** (`heuristic.ts`) — sempre roda, sem I/O,
   ~µs. Produz `RiskBand` + triggers + flag `ambiguous`.
2. **Gate LLM** (`llm-gate.ts`, Haiku 4.5) — roda APENAS se `ambiguous=true`
   AND nível < HIGH. Só pode ELEVAR o risco, nunca rebaixar.

**Dois wrappers de surface:**
- `TurnRiskScorer` — avalia risco de um turno (mensagem do usuário).
- `KnowledgeRiskScorer` — avalia risco de um registro de conhecimento
  (fato/regra/procedimento/lacuna/tool_request).

**Saída:** `ScoredRisk { level, confidence, llm_consulted,
llm_attempted_downgrade, triggers, decided_by }` — carrega o diagnóstico
completo para audit sem precisar reprocessar a entrada.

**Status de wiring: turno conectado em produção; conhecimento ainda no stub
P10a.**

- `TurnRiskScorer` (`src/runtime/decision/turn-risk-scorer.ts`) está
  **conectado ao caminho crítico em produção**. A composição de produção
  `createProductionDecisionEngineEnv` (`src/runtime/decision/prod-env.ts:881`)
  injeta `riskScorer: riskScorerProdAdapter` (`prod-env.ts:896`), um
  `RiskScorerProdAdapter` (`prod-env.ts:808`) que faz a ponte da interface
  `RiskScorer` do Decision Engine para o `scoreTurn` do P9c
  (`prod-env.ts:827`). O `scoreTurn` (`turn-risk-scorer.ts:30`) delega para
  `scoreTurnRisk` com `haikuRiskGate` como gate padrão
  (`turn-risk-scorer.ts:34-35`) — ou seja, o gate Haiku **está ativo** no
  caminho de turno em produção.
- `RiskScorerStubImpl` (P9b) **só** é usado como fallback do composition root
  `createDecisionEngine` (`src/runtime/decision/index.ts:214`,
  `env.riskScorer ?? new RiskScorerStubImpl()`) **quando `riskScorer` é
  omitido** — isto é, em test-harnesses que montam o próprio env. Produção
  nunca cai nesse fallback porque sempre fornece o `RiskScorerProdAdapter`.
  Esse default determinístico (sem LLM, sem I/O de rede) foi introduzido em
  PR #377 / issue #360 para evitar que o gate Haiku ao vivo (`haikuRiskGate`)
  fosse alcançado por harnesses, causa-raiz do flake #358 — ver comentário em
  `index.ts:206-213`. Um harness que realmente queira o gate ao vivo precisa
  injetá-lo explicitamente (ex.: `new TurnRiskScorerAdapter({ gate })`).
- `KnowledgeRiskScorer` (`src/control-plane/knowledge-state-machine/knowledge-risk-scorer.ts`)
  existe e está testado, mas o KSM (`state-machine.ts:22`) ainda importa e usa
  `KnowledgeRiskScorer` de `./risk-scorer.js` — que é o **stub P10a**
  (`source: 'stub:p10a'`), NÃO o wrapper P9c. O stub usa heurística
  determinística simples (kind=rule → high, confidence≥0.6 → low) sem gate LLM.
  Cutover pendente em PR dedicado.

**Risk Scoring de turno (via `RiskScorerProdAdapter`):** ativo em produção e
roda a cada turno. O `RiskScorerProdAdapter` chama `scoreTurn`, que aplica a
heurística determinística e, quando `ambiguous=true AND nível < HIGH`, consulta
o gate Haiku. Ou seja, a pontuação HIGH/CRITICAL via LLM
(`ambiguous=true` → Haiku) **está ativa** no caminho de turno em produção.
(O `RiskScorerStubImpl` determinístico sem LLM continua sendo o default apenas
do test-harness quando `riskScorer` é omitido — ver acima.)

**Risk Scoring de conhecimento (via stub P10a):** o KSM usa
`KnowledgeRiskScorer` de `./risk-scorer.js` (stub), não o wrapper P9c. O gate
Haiku **não está ativo** no caminho de conhecimento até o cutover de
`KnowledgeRiskScorer`.

## Arquivos relevantes

- `src/shared/risk/heuristic.ts` — tabelas TOPIC_RISK / TOOL_RISK, coerção
  de sinais inválidos, `scoreTurnHeuristic`, `scoreKnowledgeHeuristic`
- `src/shared/risk/scorer.ts` — `applyGate`, `scoreTurnRisk`,
  `scoreKnowledgeRisk`, enforcement no-downgrade + `assertNoCriticalSignalLoss`
- `src/shared/risk/llm-gate.ts` — `haikuRiskGate` (Haiku 4.5, 2500ms
  timeout), `LLMGateParseError`, Zod schema de validação
- `src/shared/risk/types.ts` — `TurnRiskSignals`, `KnowledgeRiskSignals`,
  `ScoredRisk`, `RiskTrigger`, interface `LLMGate`
- `src/shared/risk/level.ts` — `maxRiskLevel`, `compareRiskLevel`,
  `isRiskLevel`, `InvalidRiskLevelError`
- `src/runtime/decision/turn-risk-scorer.ts` — `scoreTurn` (wrapper P9c de
  turno; default do gate = `haikuRiskGate`)
- `src/runtime/decision/prod-env.ts` — `RiskScorerProdAdapter` (ponte
  interface `RiskScorer` ↔ `scoreTurn`) e `createProductionDecisionEngineEnv`
  (injeta o adapter de produção)
- `src/runtime/decision/index.ts` — `createDecisionEngine` (composition root;
  fallback para `RiskScorerStubImpl` só quando `riskScorer` é omitido) e
  `TurnRiskScorerAdapter`
- `src/runtime/decision/risk-scorer.ts` — `RiskScorerStubImpl` (P9b),
  default determinístico do test-harness
- `tests/unit/risk-heuristic.spec.ts` — 81 testes (tabelas, coerção)
- `tests/unit/risk-scorer.spec.ts` — 88 testes (orquestração, no-downgrade)
- `tests/unit/risk-llm-gate.spec.ts` — 35 testes (Zod, fail-closed)
- `tests/property/knowledge-state-machine.spec.ts` — 17 property tests

## Tabelas heurísticas

### TOPIC_RISK

| Topic | Risk |
|---|---|
| `casual` | — (nulo, não soma) |
| `operational_simple` | — (nulo, não soma) |
| `unknown` | — (nulo, mas marca `ambiguous=true`) |
| `financial` | MEDIUM |
| `legal` | HIGH |
| `health` | HIGH |
| `critical_decision` | HIGH (CRITICAL se + tool sensível) |

### TOOL_RISK

| ToolKind | Risk |
|---|---|
| `read_local` | — |
| `read_external` | — |
| `communication` | — |
| `write_local` | MEDIUM |
| `write_external` | MEDIUM |
| `transfer` | HIGH |
| `irreversible` | HIGH |

### Composite CRITICAL

**Turn:** `critical_decision` + qualquer tool em
`{irreversible, transfer, write_external}` → baseline CRITICAL.

**Knowledge:** `critical_decision` + (`touches_irreversible=true` OU tool
sensível) + tipo em `{regra, procedimento, tool_request}` → baseline CRITICAL.

## Invariantes

### 1. No-downgrade (3 camadas de defesa)

O gate LLM NUNCA reduz o nível heurístico:

- **Tipo:** `maxRiskLevel(heuristic, llm)` aplicado no scorer.
- **Runtime:** se `llm < heuristic`, `llm_attempted_downgrade=true` é
  logado e o nível heurístico prevalece.
- **Asserção pós-LLM:** `assertNoCriticalSignalLoss` — se algum trigger
  CRITICAL foi gerado, o nível final não pode cair abaixo de CRITICAL.

### 2. Coerção de sinais inválidos (fail-closed)

Strings de topic/tool/knowledge_type desconhecidas chegam de schema drift
ou deserialização de DB. Não caem silenciosamente para undefined:

| Tipo | Inválido → | Efeito |
|---|---|---|
| `TopicSignal` | `'unknown'` | marca `ambiguous=true`; gate LLM consulted |
| `ToolKind` | `'irreversible'` | bucket mais restritivo (HIGH) |
| `knowledge_type` | `'lacuna'` | sempre ambíguo; sem saída silenciosa |

Cada coerção emite `logger.warn` com `module: 'risk_heuristic'` para audit.

### 3. Gate fail-closed — fallback_ambiguous

Se o gate LLM falhar (timeout, JSON inválido, schema Zod) **e** o nível
heurístico for LOW **e** `ambiguous=true`, o scorer escala para MEDIUM:

```
trigger added: { signal: 'gate:fallback_ambiguous', contributes_to: 'medium' }
log: scorer.ambiguous_low_gate_degraded_escalated_to_medium
```

LOW é o único tier com fast-path e perks de budget. Retornar LOW quando
não conseguimos confirmar é fail-open. Escalada é a postura correta.

### 4. Triggers são aditivos

Toda escalação adiciona um trigger em `ScoredRisk.triggers`. Nenhum
trigger desaparece silenciosamente. O log de audit usa a lista de triggers
para post-mortems sem reprocessar o input.

## Quando o gate LLM roda

```
ambiguous=true  AND  level < HIGH  →  gate roda
ambiguous=false OR   level >= HIGH →  gate pulado (decided_by='heuristic')
```

HIGH e CRITICAL nunca passam pelo gate: custo de Haiku não agrega valor
para casos já determinísticos. CRITICAL via LLM exige sinal determinístico
forte, não inferência.

## Configuração

| Parâmetro | Valor atual | Onde mudar |
|---|---|---|
| Timeout do gate | 2500ms (hardcoded no `runCognitiveModule`) | `llm-gate.ts:74` |
| Modelo do gate | `claude-haiku-4-5-20251001` | `llm-gate.ts:96` |
| Tabela TOPIC_RISK | ver seção acima | `heuristic.ts:37` |
| Tabela TOOL_RISK | ver seção acima | `heuristic.ts:47` |

Para adicionar um novo topic: editar `TOPIC_RISK` em `heuristic.ts` +
adicionar o literal ao tipo `TopicSignal` em `types.ts` + adicionar um
caso no `VALID_TOPICS` (automático via `Object.keys`).

## Troubleshooting

### "Turno pontuou LOW mas era esperado HIGH/CRITICAL"

1. Verificar que o Decision Engine classificou o `topic` corretamente.
   Se `topic='unknown'`, o gate é consultado — confirmar nos logs se o
   gate retornou LOW (verify `decided_by`, `llm_reason`).
2. Confirmar que `tool_kinds` foi preenchido — tool `irreversible` ou
   `transfer` ausente pode fazer com que o composite CRITICAL não dispare.
3. Procurar `scorer.llm_disagreed_down_ignored` nos logs — indica que o
   LLM tentou rebaixar e foi ignorado; o nível heurístico prevaleceu.

### "Turno pontuou MEDIUM com trigger gate:fallback_ambiguous"

O gate LLM falhou. Verificar:
- Saúde do provider Anthropic.
- Log `haikuRiskGate.parse_failure_*` (no_json / malformed_json /
  schema_invalid) — indica regressão de prompt.
- Se for timeout: o `runCognitiveModule` registra `status='timeout'` em
  `cognitive_module_log` — verificar latência de rede / sobrecarga.

### "Turno pontuou CRITICAL inesperadamente"

Procurar nos `triggers` do `ScoredRisk`:
- `composite:critical_decision+sensitive_tool` → topic `critical_decision`
  com tool `irreversible/transfer/write_external` presentes.
- `topic:legal` ou `topic:health` + `procedure:critical_step` somando
  para HIGH, escalado para CRITICAL pelo gate.
- `owner:override` com nível CRITICAL — owner declarou explicitamente.

### "scorer.critical_signal_loss_corrected" no log

`assertNoCriticalSignalLoss` corrigiu uma under-classification —
algum caminho tentou comprimir um trigger CRITICAL. Este log é sinal de
regressão: abrir bug e investigar qual decorator/branch causou a perda.

### Gate retornou suggested_level inválido

Log `scorer.gate_returned_invalid_level_ignored` — o nível sugerido não
pertence ao enum `RiskLevel`. O scorer ignora e mantém o heurístico.
Indica regressão no prompt do Haiku.

## Testes críticos

- `tests/unit/risk-heuristic.spec.ts` — 81 testes: tabelas, coerção de
  sinais inválidos, composites, ambiguidade
- `tests/unit/risk-scorer.spec.ts` — 88 testes: orquestração, no-downgrade
  (10k inputs aleatórios com mock LLM que tenta rebaixar), fallback_ambiguous
- `tests/unit/risk-llm-gate.spec.ts` — 35 testes: Zod validation,
  LLMGateParseError, fail-closed em cada estágio de parse
- `tests/unit/risk-wrappers.spec.ts` — testes de TurnRiskScorer /
  KnowledgeRiskScorer end-to-end
- `tests/property/knowledge-state-machine.spec.ts` — 17 property tests
  cobrindo a invariante no-downgrade em inputs aleatórios

## Migrations

Nenhuma — `risk_band` é campo de packet, não persiste standalone.

Os triggers são retornados em `ScoredRisk.triggers` (em memória) mas **não são
persistidos** em `cognitive_module_log.metadata`. O campo `metadata` é registrado
como `{}` por `runCognitiveModule` — `scoreTurnRisk`/`scoreKnowledgeRisk` retornam
triggers no objeto `ScoredRisk`, mas não gravam esse dado no log de audit. Para
post-mortems baseados em triggers, capture-os no callback do scorer antes de
descartar o `ScoredRisk`; queries em `cognitive_module_log.metadata.triggers`
sempre retornarão `{}`.

## Rollout

### Estado atual

| Componente | Estado |
|---|---|
| `src/shared/risk/` (heurística + scorer + gate) | Implementado e testado |
| `TurnRiskScorer` (P9c wrapper, turno) | **Em produção** — `createProductionDecisionEngineEnv` injeta `RiskScorerProdAdapter` (`prod-env.ts:896`), que chama `scoreTurn` com gate Haiku ativo |
| `KnowledgeRiskScorer` (P9c wrapper, conhecimento) | **Implementado, NÃO conectado ao KSM** |
| `RiskScorerProdAdapter` (P9c, turno) | **Em produção** — injetado por `createProductionDecisionEngineEnv` (`prod-env.ts:881`) |
| `RiskScorerStubImpl` (P9b) | **Default apenas do test-harness** — usado por `createDecisionEngine` (`index.ts:214`) somente quando `riskScorer` é omitido (PR #377 / #360) |
| `KnowledgeRiskScorer` stub em `./risk-scorer.js` | **Em produção** — usado pelo KSM (`state-machine.ts:22`), `source: 'stub:p10a'` |

> **Nota de verificação:** o caminho de **turno** já fez cutover — produção
> injeta `RiskScorerProdAdapter` (`prod-env.ts:896`), que delega ao `scoreTurn`
> do P9c com gate Haiku ativo. O `RiskScorerStubImpl` (P9b) permanece apenas
> como default do test-harness em `createDecisionEngine` (`index.ts:214`) quando
> `riskScorer` é omitido (PR #377 / #360). O caminho de **conhecimento** ainda
> NÃO fez cutover: o KSM importa `KnowledgeRiskScorer` de `./risk-scorer.js`
> (stub P10a, `src/control-plane/knowledge-state-machine/risk-scorer.ts`), não
> do wrapper P9c (`knowledge-risk-scorer.ts`). O stub retorna
> `source: 'stub:p10a'` e não consulta o gate Haiku.

### Cutover

- **TurnRiskScorer — CONCLUÍDO em produção.** `createProductionDecisionEngineEnv`
  injeta `RiskScorerProdAdapter` (`prod-env.ts:896`), que faz a ponte para o
  `scoreTurn` do P9c. O fallback `RiskScorerStubImpl` em `createDecisionEngine`
  (`index.ts:214`) só é usado quando `riskScorer` é omitido (test-harnesses).
- **KnowledgeRiskScorer P9c — PENDENTE**, em PR dedicado. Substituirá o stub em
  `src/control-plane/knowledge-state-machine/state-machine.ts:22` — a linha
  `import { KnowledgeRiskScorer } from './risk-scorer.js'` passará a importar
  de `./knowledge-risk-scorer.js`.

O cutover de conhecimento não faz parte deste PR. Até ele:
- Conhecimento é pontuado pelo stub P10a (heurística simples, sem gate Haiku).

Em produção, no caminho de turno:
- Turnos são pontuados pelo `RiskScorerProdAdapter` → `scoreTurn` (heurística
  determinística + gate Haiku quando `ambiguous=true AND nível < HIGH`).
- `HIGH`/`CRITICAL` via gate Haiku **está ativo** para risco de turno.

### Pós-cutover

Sem flag. No caminho de turno o cutover já está feito por injeção: a fábrica
de produção `createProductionDecisionEngineEnv` injeta `riskScorer:
riskScorerProdAdapter` (`prod-env.ts:896`), e o composition root usa o adapter
injetado em vez do `RiskScorerStubImpl` (`index.ts:214`). O cutover de
conhecimento (pendente) será feito trocando o import em `state-machine.ts:22`.
Adicionar um novo topic após o cutover: editar `TOPIC_RISK` em `heuristic.ts`;
turnos em andamento não são re-scored retroativamente.

## Known issues

### KSM ainda usa stub P10a — gate Haiku inativo para conhecimento

**Arquivo:** `src/control-plane/knowledge-state-machine/state-machine.ts:22`
**Evidência:** `import { KnowledgeRiskScorer } from './risk-scorer.js'` →
`src/control-plane/knowledge-state-machine/risk-scorer.ts` — stub que retorna
`source: 'stub:p10a'` em todos os caminhos normais, sem consultar o gate LLM.

O wrapper P9c (`knowledge-risk-scorer.ts`) existe mas não é referenciado pelo
KSM. O cutover (trocar o import em `state-machine.ts`) é rastreado em PR
dedicado separado deste.

**Impacto:** risk scores de conhecimento usam heurística simples
(kind=rule → high, confidence≥0.6 → low, origin humano → low, resto → medium).
Casos ambíguos que deveriam escalar via Haiku gate **não escalam**. O
comportamento é conservador (regras sempre vão para `pending_review`), mas
menos preciso para tipos fact/memory/hint com baixa confiança.
