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

**Status de wiring: wrapper implementado, NÃO conectado ao caminho crítico.**
O módulo `TurnRiskScorer` (`src/runtime/decision/turn-risk-scorer.ts`) existe
e está testado, mas `createDecisionEngine` (`src/runtime/decision/index.ts`)
ainda instancia `RiskScorerStubImpl` (P9b) — ver TODO(P9c #97) em
`risk-scorer.ts:12`. O `KnowledgeRiskScorer` de P10a está conectado ao KSM
e funciona normalmente. A conexão de `TurnRiskScorer` ao `DecisionEngine` é
rastreada separadamente e será feita em PR dedicado de cutover.

**Risk Scoring de turno (via stub P9b):** está ligado e roda a cada turno,
mas usa a heurística determinística sem gate LLM. A pontuação HIGH/CRITICAL
via LLM (`ambiguous=true` → Haiku) **não está ativa** no caminho de turno
até o cutover de `TurnRiskScorer`.

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

Nenhuma — `risk_band` é campo de packet, não persiste standalone. Os
triggers são logados em `cognitive_module_log.metadata.triggers`.

## Rollout

### Estado atual

| Componente | Estado |
|---|---|
| `src/shared/risk/` (heurística + scorer + gate) | Implementado e testado |
| `KnowledgeRiskScorer` (P10a/KSM) | **Conectado e ativo** |
| `TurnRiskScorer` (P9c wrapper) | **Implementado, NÃO conectado ao hot path** |
| `RiskScorerStubImpl` (P9b) | **Em produção** — usado por `createDecisionEngine` |

### Cutover pendente

`TurnRiskScorer` substituirá `RiskScorerStubImpl` em `createDecisionEngine`
(ver `src/runtime/decision/index.ts:105` e TODO em `risk-scorer.ts:12`).
Esse cutover é rastreado em issue/PR separado e **não faz parte deste PR**.

Até o cutover:
- Turnos são pontuados pela heurística do P9b stub (determinística, sem LLM).
- `HIGH`/`CRITICAL` via gate Haiku **não está ativo** para risco de turno.
- `KnowledgeRiskScorer` já usa o gate LLM normalmente via KSM.

### Pós-cutover

Sem flag — o cutover é feito trocando a instância em `createDecisionEngine`.
Adicionar um novo topic após o cutover: editar `TOPIC_RISK` em `heuristic.ts`;
turnos em andamento não são re-scored retroativamente.

## Known issues

Nenhum ativo.
