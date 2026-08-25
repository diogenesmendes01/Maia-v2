# cognition

**Path:** `src/cognition/`

**Purpose** — The agent's reasoning, reflection, and self-monitoring. Hosts the reflection pipeline (reflector → classifier → persister), the self-model with deterministic confidence, capability and skill proposers, the drift detector (7 types × 4 severities), the gap-escalation engine (4-level), the role selector chain, and step evaluators for skill execution. Outputs are *evidence* — never decisions.

## Key files

| File | Role |
|---|---|
| `src/cognition/runner.ts` | `runCognitiveModule()` — universal timeout/**cancellation**/fallback/audit wrapper (see [Cancellation contract](#cancellation-contract-issue-507)) |
| `src/cognition/reflector.ts` | Generates reflection candidates per trigger |
| `src/cognition/classifier.ts` | Routes candidates to typed destination |
| `src/cognition/persister.ts` | Persists classified outputs |
| `src/cognition/self-model.ts` | 3-layer model: domain / skill / gap |
| `src/cognition/confidence.ts` | Deterministic confidence formulas |
| `src/cognition/memory-classifier.ts` | Memory-type classifier |
| `src/cognition/capability-proposer.ts` | Proposes new capabilities |
| `src/cognition/capability-test-runner.ts` | Validates acquired capabilities post-hoc |
| `src/cognition/capability-tracker.ts` | Tracks capability lifecycle |
| `src/cognition/skill-proposer.ts` | Proposes specific skills |
| `src/cognition/procedure-builder.ts` | Builds procedure from teaching turns |
| `src/cognition/procedure-selector.ts` | Selects active procedure per turn |
| `src/cognition/procedure-status.ts` | Tracks execution status |
| `src/cognition/proposal-approval-handler.ts` | Hooks fired after owner approves a proposal |
| `src/cognition/tool-request/proposer.ts` | Call site do **pedido de ferramenta**: gap recorrente sem tool vira proposta `capability_type='tool_request'` (#636) — e, desde #637, decide a agregação ANTES de criar |
| `src/cognition/tool-request/types.ts` | Contrato Zod do `proposed_spec` + a marcação de rascunho (`contract_status`) |
| `src/cognition/tool-request/contract-draft.ts` | Rascunho de contrato Zod DERIVADO das ocorrências (nunca imaginado) |
| `src/cognition/tool-request/existing-tool.ts` | "A tool já existe no código?" — casamento por nome, determinístico |
| `src/cognition/tool-request/similarity.ts` | **Métrica e limiar** da agregação (Dice sobre tokens de conteúdo, θ = 0,85) e a medição que os sustenta (#637) |
| `src/cognition/tool-request/draft-merge.ts` | **Política de fusão de rascunhos**: união quando compatíveis, `divergent` quando não (#637) |
| `src/cognition/tool-request/aggregation.ts` | A política de agrupamento: decidir, juntar, recomputar, destacar (#637) |
| `src/cognition/proposal-approval-handlers/holiday.ts` | Holiday-specific approval handler |
| `src/cognition/step-evaluator.ts` | Generic step success check |
| `src/cognition/step-evaluator-llm-judge.ts` | LLM-as-judge evaluator |
| `src/cognition/step-evaluator-user-signal.ts` | User-signal evaluator |
| `src/cognition/behavioral-hint-deriver.ts` | Derives behavior hints |
| `src/cognition/holiday-descriptor.ts` | Holiday descriptor builder |
| `src/cognition/calendar-pattern-detector.ts` | Detects calendar patterns from turns |
| `src/cognition/drift/index.ts` | Drift detector entry — invokes 7 typed detectors |
| `src/cognition/drift/linguagem.ts`, `tom.ts`, `escopo.ts`, `papel.ts`, `confianca.ts`, `valores.ts`, `soul.ts`, `procedimento.ts`, `vies.ts` | Per-type detectors |
| `src/cognition/drift/decision-engine.ts` | Maps drift signals → silent / dashboard / mentionable / proposed |
| `src/cognition/gap-escalation/engine.ts` | 4-level escalation engine |
| `src/cognition/role-selector/engine.ts` | Role-selection orchestrator |
| `src/cognition/role-selector/llm-suggester.ts` | LLM suggests role |
| `src/cognition/role-selector/deterministic-classifier.ts` | Scores suggestion deterministically |
| `src/cognition/role-selector/policy-decider.ts` | Policy decides |
| `src/cognition/role-selector/oscillation-tracker.ts` | Anti-oscillation guard |

## Patterns it follows

- [Cognitive stack](../concerns/cognitive-stack.md) — trigger → candidate → classifier → typed destination
- [Tenant isolation](../concerns/tenant-isolation.md) — every cognitive write scopes by `tenant_id + agent_id`

## How to extend

| Need | Where |
|---|---|
| Add a new classifier destination | Extend `classifier.ts`; add typed persister; add tests for the new branch |
| Add a new drift detector | New file under `src/cognition/drift/`; register in `drift/index.ts`; add to `drift/types.ts` |
| Add a new step-evaluator strategy | New `step-evaluator-<name>.ts`; wire from `step-evaluator.ts` selector |
| Add a new approval handler | New file under `src/cognition/proposal-approval-handlers/`; register from `proposal-approval-handler.ts` |

## Public surface

| Consumed by | What |
|---|---|
| `src/cognitive-graph/` | Wraps cognitive modules as graph nodes via `runner.ts` |
| `src/agent/` | `reflection.ts` triggers reflector; agent core invokes via graph |
| `src/skills/` | Skill modes call step-evaluator |

## Pedido de ferramenta e agregação por similaridade (#636 / #637)

Um gap recorrente cuja tool **não existe no código** vira uma proposta
estruturada e **inerte** (`capability_type = 'tool_request'`). O guardrail é o
recurso, não uma nota de rodapé: **o agente especifica; humano implementa e
instala.** Nada neste caminho registra tool, executa `zod_source` ou cria
capability — nem ao gerar, nem ao aprovar.

A fatia B (#637) fecha a pergunta seguinte: N pedidos parecidos viram **UM**
pedido com contador. Três decisões, e cada uma tem um lugar onde está escrita
por extenso.

### 1 · O limiar, e a medição que o sustenta

| | |
|---|---|
| Métrica | `dice_token_v1` — coeficiente de Dice sobre o conjunto de tokens de conteúdo da `capability_description` |
| Limiar | **0,85** |
| Regra de decisão | o **menor** θ da grade de 0,05 com **zero** falsas fusões no conjunto negativo real |
| Reproduzir | `npx tsx scripts/medir-limiar-tool-request.ts` |
| Mantido honesto por | `tests/unit/tool-request-limiar-medicao.spec.ts` (reroda a medição contra o catálogo VIVO) |

O conjunto negativo tem **rótulo real**: os 2080 pares de tools distintas de
`src/admin-ui/generated/tool-catalog.ts` — duas tools separadas no catálogo são
duas coisas que o projeto já decidiu que merecem implementações separadas. O
conjunto positivo é **sintético** (325 paráfrases por 5 transformações fixas), e
isso está declarado: não existe no repositório um par de gaps rotulado como
"mesmo pedido".

| θ | falsas fusões / 2080 | fusões corretas / 325 | precisão | recall |
|---|---|---|---|---|
| 0,70 | 2 | 294 | 0,993 | 0,905 |
| 0,80 | 1 | 254 | 0,996 | 0,782 |
| **0,85** | **0** | **236** | **1,000** | **0,726** |
| 0,90 | 0 | 203 | 1,000 | 0,625 |

Por que não o vizinho: 0,80 ainda funde um par real (`save_fact` × `save_rule`,
0,833); 0,90 não compra segurança nenhuma e custa 10 pontos de recall.

**Duas ressalvas que mudam como o número deve ser lido.** (a) A margem é de
0,017 sobre **um** par adversarial — daí o teste que reroda a medição. (b) Com
`completeness: 'name_only'` (a limitação herdada da fatia A: o produtor de
ocorrências não conhece `attempted_args`), a assinatura sai de uma frase curta,
e Dice sobre conjuntos pequenos é grosso: a 0,85, duas descrições de 4–5 tokens
só fundem se o conjunto de tokens for **igual**. Na prática, hoje o contador
sobe para repetição quase literal. Quando os rascunhos ficarem ricos, a
assinatura deve mudar — e aí **o limiar não vale como está**. Por isso a
assinatura é versionada (`ASSINATURA_VERSION`) e a versão é persistida por
agregado e por membro.

### 2 · O rascunho Zod quando dois pedidos se fundem

**Nenhum vence, nunca.**

| Situação | O que acontece |
|---|---|
| 1 membro | `contract_state = 'single'` — o contrato é o dele, intocado |
| N membros sem conflito | `'consistent'` — **união** dos campos; `observed_in` soma; `required` só sobrevive quando o campo é obrigatório em todos |
| N membros com conflito | `'divergent'` — **não há** contrato fundido; os rascunhos ficam lado a lado como variantes e o conflito é nomeado (campo, lado, as expressões Zod em disputa, e de quem vieram) |

Incompatível = mesmo nome de campo, mesma face (entrada/saída), expressão Zod
diferente. Nome de tool diferente **não** é incompatibilidade (é o caso normal
do agrupamento; o nome alternativo vira alias). O CHECK
`tool_request_aggregates_divergent_has_no_draft` (migração 129) torna
impossível gravar `divergent` com um rascunho pendurado.

### 3 · Escopo: por tenant + agent, sem contador global

A agregação **compara o texto do pedido de um cliente com o de outro**. Um
contador global exigiria que o dado de A entrasse no cálculo que produz a linha
de B, e "só o número atravessa" não salva — contagem pequena é reconstruível. A
pergunta legítima ("quantos clientes pediram esta ferramenta?") tem caminho
próprio: agregação estatística deliberada com anonimização e ADR, nunca efeito
colateral de agrupar pedidos. **Consequência aceita:** dois tenants que precisam
da mesma ferramenta produzem dois pedidos.

### 4 · A fusão não apaga a evidência

| Camada | O que garante |
|---|---|
| A fusão só escreve em tabelas **novas** | `capability_proposals`, `agent_capability_gaps` e `agent_capability_gap_observations` não são alteradas nem apagadas por agrupamento nenhum |
| `tool_request_aggregate_members.original_spec` | o `proposed_spec` **inteiro** de cada membro, como entrou (situações com trace, janela de frequência, rascunho original). Necessário porque um pedido que se funde **não** gera linha em `capability_proposals` — é esse o "N vira 1" |
| `detached_at` em vez de `DELETE` | desfazer é marcar, com motivo e autor; e um gap já destacado de um agregado **não volta a ele** por similaridade, senão "reversível" duraria até o próximo cron |

O representante não pode ser destacado (o agregado ficaria órfão apontando para
um pedido que não é mais dele); desfazer um agregado inteiro é destacar os
não-representantes, o que o reduz ao pedido original.

Auditoria: `tool_request_proposed`, `tool_request_aggregated` (com similaridade,
limiar, métrica e versão da assinatura) e `tool_request_aggregate_detached`.

## Cancellation contract (issue #507)

`runCognitiveModule` accepts an optional `signal` and hands the `fn` a
**composed** signal (caller cancellation + the module's own timeout). The `fn`
is what actually cancels: it must forward that signal to the underlying
operation (the LLM gateway's `signal` parameter). A `Promise.race` alone only
decides who answers the caller — the work keeps running and keeps being billed.

Five things follow from that, and they are the contract:

| Rule | Why |
|---|---|
| `status: 'cancelled'` is its own outcome, distinct from `timeout` and `error` | `timeout` is "our operation took too long"; `cancelled` is "authority over the turn changed hands". Collapsing them erases the split between budget spent on slowness and budget lost to takeover/shutdown. |
| `fallback_triggered` stays **false** on `cancelled`, and the fallback is never synthesized | Cancellation is not product degradation. Marking fallback here poisons the metric that measures how much worse an answer the user got. |
| A `fn` that resolves **after** the signal aborted has its output **discarded** (`metadata.cancel_cause = 'late_result_discarded'`) | A non-cooperative dependency still returns. The row used to say `success` for a turn that was no longer ours. The work was paid for either way; what must not happen is it becoming an answer, a mutation, or an audited success. |
| A caller signal that is **already aborted** on entry means the `fn` is **never invoked** (`metadata.cancel_cause = 'caller_already_aborted'`) | The contract is generic: a `fn` that ignores its signal would hold the caller for the whole 5 s/30 s budget, and a `fn` with a synchronous effect would have produced it before the first `await`. With the signal now flowing through the cognitive graph, this is the normal case for the second node of a parallel layer. |
| `signal` is **opt-in** | ~30 call sites run outside a claimed turn (batch workers, drift, KSM). Passing no signal keeps the previous behaviour byte-for-byte. |

Who passes it today, all from `getTurnExecutionContext()?.signal` (the lease
signal of issue #504):

| Call site | Path to `callLLM` |
|---|---|
| `src/agent/react-loop.ts` | reasoner, direct |
| `src/agent/pending-gate.ts` | classifier, direct |
| `src/agent/core.ts` → `PreturnContext.signal` | `runNodes` → `runOne` → `runCognitiveModule` → `n.run(ctx, signal)` → `selectProcedure` / `selectRole` |
| `src/runtime/decision/integration.ts` | `engine.run({ base, signal })` → ports (`intent_classifier`) and `riskScorer.score` → `scoreTurn` → `haikuRiskGate` |

In the ReAct loop a `cancelled` reasoner is translated into
`TurnOwnershipLostError('react_reasoner')`, because letting it fall through to
`reasoner_failed` would make `core.ts` schedule a **retry** of a turn another
worker already owns.

**Propagating the signal is not by itself the protection.** A cancelled module
returns `output: null`, and `null` is also what a timeout returns — the caller
cannot tell them apart, and "no output" does not stop the code that comes after
it from writing. What stops the turn is an ownership guard at each boundary,
immediately after the await and **before** the result is consumed:
`assertTurnOwnership('preturn_graph')` after `runNodes`,
`assertTurnOwnership('decision_engine')` inside `runDecisionEngineForTurn`, and
the `{ kind: 'cancelled' }` outcome of the pending gate. The signal saves the
money; the guard saves the state.

Metric: `maia_cognitive_module_cancelled_total`, emitted through
`src/observability/metrics.ts::counter` (never `lib/metrics.ts` directly) so it
carries `tenant_id`/`agent_id` and passes the label guard. Dimensions are the
already-sanctioned `workload` (module name) and `reason` (the cancel cause) —
the bound on cardinality is the sanitizer's per-(metric, key) budget, not the
type, because `procedure-selector.${def.nome}` derives the module name from
tenant data.

Storage: `cognitive_module_log.status` admits `cancelled` since migration
`117_cognitive_module_log_cancelled.sql`.

## Tests

| Test path | What it covers |
|---|---|
| `tests/unit/cognition/` | Per-module contracts |
| `tests/integration/tool-request-guardrail-real-db.spec.ts` | O guardrail do pedido de ferramenta: invariante ABSOLUTA (nenhuma tool viva fora do catálogo committado) + varredura estática pelo grafo de imports — vale para o código da fatia B também |
| `tests/integration/tool-request-aggregation-real-db.spec.ts` | Agregação contra o banco real: N→1 com contador, faixa do limiar (funde a 0,92; não funde a 0,83), **leak entre tenants**, evidência preservada, destaque reversível, contratos incompatíveis |
| `tests/unit/tool-request-limiar-medicao.spec.ts` | A medição do limiar, executável contra o catálogo vivo |
| `tests/unit/tool-request-draft-merge.spec.ts` | A política de fusão de rascunhos, incluindo o caso incompatível |
| `tests/unit/tool-request-similaridade.spec.ts` | A métrica discrimina: pares difíceis dos dois lados |
| `tests/unit/cognition-runner.spec.ts` | The cancellation contract above, including the "already-aborted caller never invokes `fn`" rule and the metric's tenant attribution / cardinality bound |
| `tests/integration/turn-lease-lost-reasoner-real-db.spec.ts` | Lease lost during the ReAct reasoner, real DB |
| `tests/integration/turn-lease-lost-turn-pipeline-real-db.spec.ts` | Lease lost at the pending gate, the pre-turn graph and the Decision Engine — proves no later mutation or reply, through the real `runAgentForMensagem` |
| `tests/unit/control-plane/knowledge-state-machine/` | KSM uses cognition outputs |

## In-flight changes

At last verification (2026-05-28):

- Reflection memory cleanup for pre-fix pollution (#260 → #276 — open)
- Cognition runner clearTimeout after Promise.race settle (#224 → #225 — merged)

Verify: `gh pr list --state open --search "cognition OR reflector OR drift"`.

---

| | |
|---|---|
| Last verified | 2026-05-28 |
| Against `main` HEAD | `c49c3855` |
