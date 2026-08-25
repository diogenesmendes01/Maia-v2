# runtime

**Path:** `src/runtime/`

**Purpose** — Per-turn runtime infrastructure between gateway and agent: the decision engine, the context packet assembly (slice builders + cache), policy enforcement points (PEPs), and feature flags that gate runtime behaviors. The decision engine takes a typed turn and produces a typed selection (skill / tool / procedure / fallback) via action-decider + skill-selector + risk-scoring. Context packet is rebuilt per turn from independently-cached slices.

## Key files

### Decision (`src/runtime/decision/`)

| File | Role |
|---|---|
| `decision-engine.ts` | Engine entry |
| `action-decider.ts` | Routes turns to skill / tool / procedure / fallback |
| `skill-selector.ts` | Selects candidate skill |
| `skill-match.ts` | Strict `>` threshold matching |
| `agent-selector.ts` | Selects answering agent (no-op today; `MULTI_AGENT_SELECTOR_V2` reserved) |
| `workflow-selector.ts` | Routes to workflows (dual-approval, pending) |
| `intent-classifier.ts` | Intent classification |
| `turn-risk-scorer.ts` | Pre-execution turn risk |
| `risk-scorer.ts` | Generic risk-scoring primitives |
| `early-pep.ts`, `mid-pep.ts` | Policy enforcement points |
| `pep-audit.ts` | Per-PEP audit emission |
| `budget-tracker.ts` | Per-turn budget |
| `integration.ts` | Wires engine into agent loop |
| `prod-env.ts` | Production-only env helpers |
| `types.ts` | Shared types |

### Context packet (`src/runtime/context-packet/`)

| File | Role |
|---|---|
| `build-context-packet.ts` | Assembles packet from slices |
| `base-context-builder.ts` | Base builder |
| `production-builder-set.ts` | Production wiring with real ports |
| `decision-packet-stub.ts` | Stubbed decision packet for early phases |
| `cache/slice-cache.ts` | Per-slice cache (tenant-scoped) |
| `cache/invalidation-bus.ts` | Cross-process invalidation |
| `cache/ttl-policy.ts` | TTL per slice type |
| `types.ts` | Shared types |

### Context assembly (`src/runtime/context-assembly/`)

| Slice | Builder |
|---|---|
| Identity | `slice-builders/identity-slice-builder.ts` |
| Knowledge | `slice-builders/knowledge-slice-builder.ts` |
| Policy | `slice-builders/policy-slice-builder.ts` |
| Skill | `slice-builders/skill-slice-builder.ts` |
| Soul | `slice-builders/soul-slice-builder.ts` |
| Tool | `slice-builders/tool-slice-builder.ts` |
| User | `slice-builders/user-slice-builder.ts` |

### Turn state machine (`src/runtime/turns/`) — issue #503

Máquina de estados **durável** do turno inbound. PostgreSQL é a fonte de verdade
do ciclo de vida; Redis/BullMQ são só wake-up e distribuição. Um turno é
**lógico**: agrega N mensagens inbound (debounce) numa única execução.

| File | Role |
|---|---|
| `contract.ts` | Vocabulário PURO: estados, outcomes, tabela de transições, compatibilidade estado/outcome, sanitização do erro persistido. Sem I/O — unit-testável sem Postgres. |
| `claim.ts` | Vocabulário PURO do claim (#504): elegibilidade, resultados tipados, identidade do worker, aritmética do lease. Sem I/O. |
| `job.ts` | Identidade determinística do job na BullMQ (#504): `agentTurnJobId(turn_id)` e a leitura dual do payload V1/V2. Puro — não importa `bullmq`. |
| `lease.ts` | POSSE viva (#504): o único módulo com TEMPO — heartbeat, perda, cancelamento e liberação. Dono do contador `maia_turn_fence_rejected_total`. |
| `execution-context.ts` | Contexto AMBIENTE da tentativa (#504), por AsyncLocalStorage: propaga posse/sinal/deadline aos limites de efeito sem passar por assinatura. Mesmo padrão de `src/db/tenant-context.ts`. |
| `stream-key.ts` | Derivação CANÔNICA da `stream_key` (#505) **e a guarda fail-closed** (`requireStreamIdentity`, `StreamIdentityUnresolvedError`). PURO — só `node:crypto`: material comprimento-prefixado (netstring) sobre `tenant_id + agent_id + canal + linha + identidade remota normalizada`. Nenhum caminho devolve chave "genérica". A pureza é **estrutural**: quem chama a guarda é o repositório, que é compartilhado com o console e não pode alcançar `src/config/env.ts` (#596). |
| `stream-ingress.ts` | O RELATO da decisão (#505): métrica, `audit_log` e log estruturado. Consumido pelo **gateway**, que já paga por `@/config/env.js`. Dono de `maia_stream_ingress_total` e `maia_stream_ingress_rejected_total`. |
| `lifecycle.ts` | Fachada usada por gateway/agent/workers: flag de rollout, fail-soft, auditoria e métricas. |
| `index.ts` | Superfície pública — importe daqui. |

A **única porta de escrita** é `agentTurnsRepo`
([`src/db/repositories/turn-repos.ts`](../../../src/db/repositories/turn-repos.ts)):
nenhum caller atualiza `status` direto e toda transição é compare-and-swap sobre
`state_version`, escopada por `tenant_id + agent_id`.

**Estados** — `received → queued → claimed → running → outbound_pending →
completed`, com `retryable` (falha antes de efeito irreversível), `ignored`
(descarte por regra explícita), `superseded` (absorvido pelo debounce) e
`dead_letter`. `outbound_pending` **nunca** volta para `running`; estado
terminal **sempre** carrega outcome.

**Outcome ≠ estado**: o caller declara o RESULTADO DE NEGÓCIO
(`reply_delivered`, `identity_unknown`, `rate_limited_silent`, …) e a fachada
deriva o estado terminal. É assim que "nenhum turno é concluído simplesmente
porque uma função retornou" fica garantido.

**`pending_race_lost`** (migration 115, follow-up da #545) é o outcome de
`ignored` mais recente e o único que nasce de uma corrida: a mensagem foi
classificada como resposta a uma pergunta pendente e perdeu para outra resposta
que resolveu a mesma pendência. `completed` seria mentira — quem despachou a
ação foi o OUTRO turno; este não executou nada e é descartado por regra
explícita. Ver [`agent.md`](agent.md) § Pending gate.

#### Identidade de stream e sequência de ingresso (#505, fases 1–2)

A #505 quer FIFO **por conversa** sem serializar a fila inteira. A unidade de
serialização precisa existir **no ingresso**, e `conversa_id` não serve: ele é
resolvido depois e é `NULL` na hora em que a ordem de chegada é decidida — uma
unidade que às vezes é NULL colapsa todo mundo numa stream só, que é a
serialização global que a issue proíbe.

**`stream_key`** é derivada de material que já existe no ingresso: `tenant_id`,
`agent_id`, o tipo de canal, a LINHA (`channel_id`) e a identidade remota
normalizada. O encoding é **comprimento-prefixado** (netstring `<bytes>:<valor>,`),
não concatenação com separador: `["a:b","c"]` e `["a","b:c"]` produzem a mesma
string sob `join(':')`, e duas conversas com a mesma chave compartilhariam ordem,
lock e — na fase de enforcement — exclusão mútua. A issue trata colisão como risco
de **segurança**. A versão do algoritmo aparece no valor (`v1:<sha256>`) **e** na
coluna `stream_key_version`.

**Fail-closed.** `tenant_id`/`agent_id` são obrigatórios, `'default'` e `'system'`
são recusados, e a LINHA é obrigatória (desde a migration 090 a conversa é
escopada por canal — sem `channel_id` no material, o mesmo interlocutor em duas
linhas colapsaria numa stream). Um ingresso irresolúvel é RECUSADO e nunca
persistido. Em produção esse caso já era fail-closed antes daqui: todo ramo
não-lançante de `resolveChannel` devolve `channel_id`.

**Onde a decisão mora, e por quê.** A GUARDA (`requireStreamIdentity`) é chamada
por `mensagensRepo.createInbound`, no ponto em que o inbound seria persistido —
a recusa acontece antes de qualquer escrita. O RELATO (métrica, `audit_log`,
log) é chamado pelo GATEWAY, no `catch`. A divisão não é estética:
`src/db/repositories/` é compartilhado entre o container `app` e o console
`admin-ui`, e a cadeia `métrica → labels → src/config/env.ts` faria o console
validar o subset `runtime` no boot (#596, fixado por
`tests/unit/config/admin-import-boundary.spec.ts`). Pela mesma razão a flag é
lida por `contractEnv`, não por `config`. Consequência honesta: um chamador
futuro de `createInbound` que não relate continua fail-closed, mas a recusa dele
não vira série nem `audit_log`.

**`ingress_seq`** é monotônica **por stream**, alocada por
`INSERT … ON CONFLICT DO UPDATE … RETURNING` numa linha de `agent_stream_sequences`
— uma declaração atômica cujo lock de row serializa apenas aquela stream (streams
distintas nunca se veem, e não há lock global por tenant, agente ou fila). A
alocação corre **dentro da transação do INSERT** da mensagem: se a reentrega
colidir na unique de dedup, o rollback devolve o número, e é assim que
"redelivery reusa a sequência original" fica garantido por construção. A dedup
por `whatsapp_id` precede tudo isso, no pre-check de `createInbound`.

**Fronteiras.** O turno persiste `first_ingress_seq`/`last_ingress_seq`. Turno
simples: iguais. Turno agregado pelo debounce: `absorbDebounceInputs` estende a
fronteira com `LEAST`/`GREATEST` e **só** com ingressos da mesma `stream_key` —
uma mensagem de outra conversa não move a fronteira.

**Fora desta fatia** (fases 5–9 da issue): head-of-line como condição do claim,
exclusão "no máximo um turno ativo por stream", debounce transacional, promoção
de sucessor, política de retry/DLQ por stream, fairness e backfill.

#### Claim atômico, lease e fencing (#504)

Enquanto `FEATURE_TURN_CLAIM` está OFF, a máquina de estados **registra** que a
execução começou mas **não decide quem executa** — duas réplicas podem entrar no
mesmo turno. Ligada, três mecanismos independentes fecham essa janela:

**1. Claim atômico.** `agentTurnsRepo.tryClaimTurn` é UM `UPDATE ... WHERE ...
RETURNING`. Sob READ COMMITTED, dois workers disputando a mesma row serializam
no lock de row e o perdedor RE-AVALIA o `WHERE` contra a versão nova
(EvalPlanQual) — como o vencedor deixou `lease_expires_at` no futuro, o
predicado de takeover do perdedor fica falso e ele volta zero linhas.
"SELECT elegível" seguido de "UPDATE" **não** tem essa propriedade. Elegível:
`received`/`queued`; `retryable` com `next_attempt_at` vencido; `claimed`/
`running` com `lease_expires_at <= now()`. `outbound_pending` nunca.
Todo relógio é o do PostgreSQL (`now()`), nunca o do processo — elegibilidade
por lease compara instantes entre máquinas, e clock skew vira takeover falso.

**2. Lease com heartbeat.** `TurnLease` (`lease.ts`) renova enquanto o token e a
posse coincidem. Uma lease **vencida não se renova**: um worker que volta de uma
pausa longa não retoma a posse mesmo que ninguém a tenha tomado. Duas falhas
consecutivas de heartbeat abortam a tentativa ANTES do vencimento.

**3. Fencing.** `claim_token` entra no `WHERE` de toda gravação da tentativa,
junto com `lease_expires_at > now()`. As duas condições são necessárias: só o
token deixaria escrever quem perdeu a lease sem sucessor; só a lease deixaria
passar o zumbi enquanto o sucessor renova. Zero linhas com fence declarado é
`stale_claim` — resultado tipado distinto de `state_mismatch`, porque a reação
é oposta (parar, não reler e reinsistir). Ele cancela o `AbortSignal` da lease,
emite `maia_turn_fence_rejected_total` e audita `turn_fence_rejected`.

**O fence pertence a quem ABSORVE.** Marcar um turno `superseded` são DUAS
operações, não uma, e elas têm regras opostas — colapsá-las numa só foi o que
deixou a transição terminal `superseded` sem fence nenhum:

| Operação | Linha que muda | De quem é a posse exigida |
|---|---|---|
| `markSupersededSelf` | o próprio turno | do **próprio turno** (`claim_token` vigente, como toda transição terminal) |
| `markSupersededByAbsorber` | o turno **irmão** | do turno **ABSORVEDOR** (token + `lease_expires_at > now()`, num `EXISTS` na mesma declaração), mais o compare-and-swap na linha do irmão |

O irmão absorvido **não precisa de claim, e normalmente não tem nenhum**: quem
foi reivindicado é o executor da rajada de debounce, então `claim_token IS NULL`
é o estado normal dele. Exigir claim do irmão tornaria a absorção legítima
impossível no caso comum; não exigir nada dos dois lados deixaria um worker
zumbi — lease vencida, tentativa já sucedida — absorvendo turnos e apagando
trabalho do sucessor. O compare-and-swap na linha do irmão (`expected_version`,
**obrigatório**) é o que decide a corrida entre duas absorções concorrentes; o
fence do absorvedor é o que decide se ela pode sequer ser tentada.

O `WHERE` das duas formas é montado por
[`src/db/repositories/turn-fence-sql.ts`](../../../src/db/repositories/turn-fence-sql.ts),
um módulo PURO — `runTransition` não acrescenta predicado nenhum depois dessa
chamada. É o que permite a `tests/unit/db/turn-fence-sql.spec.ts` compilar o SQL
REAL com `PgDialect` e provar o fence sem Postgres no ar.

**As TRÊS posses.** `resolveFence()` (`lifecycle.ts`) classifica o handle em
`unfenced` (não há lease: `FEATURE_TURN_CLAIM` OFF, regime de #503),
`fenced` (lease viva → token no `WHERE`) e `lost` (a lease EXISTIU e morreu:
`markLost()` por heartbeat, ou `release()` no shutdown). Colapsar `lost` em
`unfenced` — que é o que acontece quando se lê `lease.token` e se traduz `null`
para "sem fence" — transforma o fail-closed em fail-open: sem
`expected_claim_token` sobra apenas o CAS por `state_version`, e ele CASA
sempre que ninguém tomou o turno ainda. Quem recebe `lost` não grava: recusa
localmente, com a mesma métrica, log e auditoria de uma rejeição vinda do banco.

**Cancelamento local e limites de efeito.** O fence protege `agent_turns`; ele
não desfaz um boleto emitido nem despacha de volta uma mensagem entregue. Por
isso o `AbortSignal` da lease é propagado como contexto AMBIENTE
(`execution-context.ts`): `src/agent/core.ts` abre
`runWithTurnExecution(lease.context(), …)` logo depois da barreira do claim, e
cada limite de efeito pergunta pela posse antes de agir —
`src/tools/_dispatcher.ts` (recusa com `turn_ownership_lost`),
`src/agent/output-dispatch.ts` (`OutboundDeliveryError(delivered:false)`),
`src/agent/react-loop.ts` (no topo de cada iteração, para não pagar mais um
round-trip de LLM) e a projeção legada `mensagens.processada_em` no próprio
core. Fora de um turno reivindicado todo guard é no-op.

**Backoff com jitter limitado.** `retryDelayMs` (`lifecycle.ts`) é exponencial
com teto de 15min E jitter simétrico de ±20%, e o valor entra em
`agent_turns.next_attempt_at`. Sem jitter, N turnos que falharam pela MESMA
causa (LLM fora do ar, banco lento, deploy) recebem o mesmo `next_attempt_at` ao
milissegundo e voltam todos juntos contra a dependência que acabou de cair — o
backoff exponencial sozinho não resolve isso, porque ele afasta as tentativas do
MESMO turno e mantém alinhadas as de turnos diferentes. O teto é reaplicado
DEPOIS do jitter, então continua sendo um teto de verdade.

**`jobId` determinístico.** `agentTurnJobId(turn_id)` = `turn-<uuid>`. "Mesmo
trabalho lógico" é o TURNO, não a mensagem nem o evento de enfileiramento: o
debounce agrega N mensagens numa execução, e ingresso e recovery (que podem
rodar em réplicas distintas) armam o mesmo turno sem se conhecer. O preço é a
RETENÇÃO da BullMQ — um job `completed`/`failed` retido bloquearia o rearme
legítimo, então `enqueueAgent` remove o cadáver antes do `add` e deixa job VIVO
intocado (é ele quem faz a deduplicação).

**Contrato do payload: V1 e V2 (`turns/job.ts` + `turns/scope-resolver.ts` +
`turns/job-consumer.ts`).** O job V2 é `{version: 2, turn_id}` e nada mais — sem
tenant, sem conteúdo, sem correlação. Isso obriga o consumidor a traduzir
`turn_id -> (tenant, agent, mensagem representativa)` ANTES de qualquer trabalho
de domínio, e essa tradução é CROSS-TENANT por construção: quem descobre o dono
não pode já estar escopado por ele. `resolveTurnJobScope` é essa fronteira, e o
que a torna aceitável são cinco predicados, não a intenção:

1. o payload **não pode carregar escopo** — `AgentTurnJobV2Schema` é `.strict()`,
   então um `{version, turn_id, tenant_id}` não parseia como V2 nem como V1 e
   vira `invalid` antes de chegar ao banco;
2. escopo e id da mensagem saem da **mesma row, no mesmo SELECT**, com projeção
   mínima (nenhuma coluna de conteúdo atravessa a fronteira);
3. a ligação turno → mensagem é **reconciliada**: `representative_message_id` não
   tem foreign key (migration 097 só cria uma unique), então um turno do tenant A
   apontando para a mensagem do tenant B é fisicamente representável — e é
   recusado (`scope_mismatch`) em vez de atravessado;
4. **fail-closed** em todo desfecho que não seja resolução inequívoca, incluindo
   os sentinelas `default` e `system`;
5. toda recusa é **auditada** (`turn_job_scope_rejected`) e medida, com `reason`
   de vocabulário fechado.

O resolvedor NÃO decide se o turno deve executar — elegibilidade e posse
continuam sendo do claim. Depois dele, o consumidor abre
`runWithTenantContext(escopo)` e entra no mesmo `runAgentForMensagem`; `core.ts`
segue abrindo seu contexto ANINHADO com o par que o canal resolver, que vence
para o escopo interno.

| Métrica | Labels |
|---|---|
| `maia_turn_job_version_total` | `version` = `v1` / `v2` / `invalid` (vocabulário FECHADO `TURN_JOB_VERSION_VALUES`). Emitida no PARSE, em `startAgentWorker` — atribuição `system` por construção (nada resolveu o tenant ainda), pela camada de política de [`src/observability/metrics.ts`](../../../src/observability/metrics.ts). É o critério MENSURÁVEL de remoção do caminho V1: zero `v1` por uma janela definida. |
| `maia_turn_scope_rejected_total` | `reason` = `malformed_turn_id` / `turn_not_found` / `scope_unusable` / `representative_missing` / `scope_mismatch`. Nenhum é normal; `scope_mismatch` é incidente de isolamento. |
| `maia_turn_claim_total` | `result` = `acquired` / `not_eligible` / `not_found` |
| `maia_turn_claim_latency_ms` | `result` |
| `maia_turn_lease_heartbeat_total` | `result` = `renewed` / `token_mismatch` / `error` |
| `maia_turn_lease_lost_total` | `reason` = `token_mismatch` / `heartbeat_failed` / `expired` |
| `maia_turn_fence_rejected_total` | `operation` — incrementado **só** em `reportFenceRejection` (`lease.ts`). O repositório classifica `stale_claim` e NÃO conta: com as duas camadas contando, um CAS recusado valia 2 num `sum()`, e a recusa local (que nunca chega ao SQL) ficava invisível. |
| `maia_turn_effect_blocked_total` | `tenant_id` + `agent_id` (atribuição automática do ALS — issue #601), mais `boundary` (vocabulário FECHADO `EFFECT_BOUNDARY` em [`src/observability/taxonomy.ts`](../../../src/observability/taxonomy.ts), budget de cardinalidade próprio) = `pending_gate` / `scheduling_inbound_hook` / `preturn_graph` / `role_selector_decision` / `decision_engine` / `react_iteration` / `react_reasoner` / `tool_dispatch` / `tool_handler` / `mcp_tool_call` / `outbound_dispatch` / `outbound_send` / `outbound_document` / `outbound_voice` / `outbound_poll` |
| `maia_turn_job_retained_cleared_total` | `state` = `completed` / `failed` |

Issue #601 — `maia_turn_effect_blocked_total` é emitida por
[`src/observability/metrics.ts::counter`](../../../src/observability/metrics.ts),
não por `src/lib/metrics.ts::incCounter`. A diferença é operacional: sem
`tenant_id`/`agent_id` um pico dizia que o fencing atuou e não dizia PARA QUEM,
que é a primeira pergunta de um incidente multi-tenant. `boundary` sobrevive à
migração porque a série tem um consumidor que exige a distinção — a barreira de
`tests/integration/turn-lease-lost-turn-pipeline-real-db.spec.ts` afirma QUAL
limite recusou, não só que alguém recusou. `react_tool_refused` pertence ao
vocabulário do ERRO (`TurnOwnershipLostError`) e NÃO à série: a recusa que o
ReAct traduz já foi contada como `tool_dispatch`/`tool_handler`.

Auditoria: só as ANOMALIAS (`turn_lease_lost`, `turn_fence_rejected`). Claim e
heartbeat rotineiros ficam em métrica — auditá-los seria uma row por batida.

**Rollout** — duas flags, registradas em `ENV_CONTRACT`
([`src/config/contract.ts`](../../../src/config/contract.ts)) e documentadas em
[`docs/configuration.md`](../../configuration.md) (arquivo **gerado**; edite o
contrato, nunca o `.env.example`):

| Flag | Default | Efeito |
|---|---|---|
| `FEATURE_TURN_STATE_MACHINE` | `true` | Cria/transiciona turnos. **Exige as migrations 096/097 aplicadas.** |
| `FEATURE_TURN_STATE_AUTHORITATIVE` | `true` | A LEITURA é do estado: o recovery elege por `agent_turns.status` em vez de `processada_em`, e falha de escrita da máquina vira `TurnStateWriteError` (bloqueante) em vez de fail-soft. |
| `FEATURE_TURN_CLAIM` | `true` | Claim atômico + lease + fencing (#504). É o único regime em que `beginTurnExecution` pode devolver `started: false` e BARRAR a execução. **Exige a migration 114.** |
| `FEATURE_TURN_STREAM_KEY` | `true` | Identidade de stream e sequência de ingresso (#505, fases 1–2: SHADOW). Só ESCRITA — nada lê as colunas para decidir. A ÚNICA mudança observável é a recusa fail-closed de ingresso sem identidade derivável. **Exige as migrations 120/122.** |
| `FEATURE_TURN_JOB_V2` | `false` | PRODUTOR do payload V2. Continua OFF por default: é o passo de rollout que exige TODAS as réplicas de consumo já no build que entende V2. |

**Os três defaults ON valem desde o PRIMEIRO deploy de produção** (decisão do
dono, #504). Numa produção greenfield não existe histórico a backfillar nem
coorte a comparar, e deixar o caminho legado como padrão criaria dependência
dele: `FEATURE_TURN_CLAIM=false` não é "modo conservador", é a janela de
execução dupla aberta, e `FEATURE_TURN_STATE_AUTHORITATIVE=false` faz um turno
`retryable` sumir do recovery. **`false` nas três é rollback emergencial, não
configuração suportada** — o código do caminho legado (`markClaimed` sem lease,
shadow com `processada_em` decidindo) continua existindo e testado justamente
para que o rollback funcione, mas nenhum teste novo deve assumi-lo como padrão.
Desligar SÓ `FEATURE_TURN_STATE_MACHINE` é recusado no boot (as outras duas
ficariam inertes): num rollback, desligue as três juntas.

`TURN_LEASE_TTL_MS` (60s) e `TURN_LEASE_HEARTBEAT_MS` (15s) dimensionam a lease.
O heartbeat DEVE caber ao menos 3× no TTL — com 2×, uma renovação perdida já
deixa a lease vencer com o dono processando, e isso é execução dupla. A regra
`turn-lease/heartbeat-ratio` recusa o boot fora dessa relação.

As combinações `AUTHORITATIVE=true` + `MACHINE=false` e `CLAIM=true` +
`MACHINE=false` são inertes e por isso o boot as **recusa** (regras
`turn-state/authoritative-requires-dual-write` e
`turn-claim/requires-state-machine` em
[`src/config/rules.ts`](../../../src/config/rules.ts)).

Enquanto a segunda flag estiver OFF, `mensagens.processada_em` continua sendo a
decisão de negócio e a máquina roda em **shadow**; a divergência é medida por
`maia_turn_legacy_projection_mismatch_total`. Runbook:
[`docs/runbooks/turn-state-machine.md`](../../runbooks/turn-state-machine.md).

**Com ela ON — o default — `processada_em` deixa de ser o sinal de "o turno
rodou até o fim".** A projeção legada passa a SEGUIR o estado: `runTransition`
([`src/db/repositories/turn-repos.ts`](../../../src/db/repositories/turn-repos.ts))
só carimba `processada_em` em transição **terminal**, na mesma transação do CAS
e restrito às mensagens ligadas por `agent_turn_inputs`; fora disso
`src/agent/core.ts` registra `agent.legacy_projection_skipped_non_terminal`. Um
turno que termina `retryable` (timeout de reasoner, falha pre-send do outbound)
corretamente **não** carimba — carimbar é o que matava o retry, porque a
reentrada morria no early-return legado. Consequência prática para quem escreve
teste, query de suporte ou painel: o fim de um turno lê-se em `agent_turns`
(`status`/`outcome`/`last_error_code`/`state_version`) mais a ligação
`agent_turn_inputs`; `processada_em` responde apenas "este inbound já foi
encerrado por um turno TERMINAL".

### Outbox de saída (`src/runtime/outbound/`) — issue #506, fatias A (#630), B (#631) e C (#632)

| File | Role |
|---|---|
| `contract.ts` | Vocabulário puro do outbox de saída: união Zod dos payloads, serialização canônica versionada, `payload_hash`, as DUAS identidades e a ponte com a coluna legada `channel` |
| `commit.ts` | **#631** — a fronteira que o dispatcher de saída atravessa antes de qualquer chamada ao canal. Constrói o artefato, chama a transação única e **lança** se ela falhar |
| `turn-scope.ts` | **#631** — o `TurnHandle` visível para os limites de saída, por AsyncLocalStorage (aberto em `src/agent/core.ts`, junto de `runWithTurnExecution`) |
| `delivery-contract.ts` | **#632** — contrato PURO da entrega: elegibilidade do claim, capability de idempotência do provedor por tipo de payload, normalização dos SETE desfechos, tabela estado↔desfecho e a política de reenvio |
| `delivery-job.ts` | **#632** — identidade determinística do job por `outbound_id` (`outbound-<uuid>`) e o payload `.strict()` que carrega só o id. Puro, sem `bullmq` |
| `provider-adapter.ts` | **#632** — união de #630 ⇒ primitiva de `LineOutput`, com a chave idempotente entregue só onde ela é honrada |
| `delivery.ts` | **#632** — o CICLO: carregar → claim → validar → deadline → `sending` fenced → adaptador → resultado normalizado → `delivered` → histórico → `completed` |
| `index.ts` | Fachada — importe sempre daqui |

`contract.ts` e `delivery-contract.ts` são **puros**, na mesma natureza de
`src/runtime/turns/contract.ts`: sem `db`, sem I/O, sem ALS, sem relógio. As
fatias irmãs que ainda faltam são #633 (recovery/reconciliação/DLQ), #634
(inventário e migração de TODOS os caminhos de envio) e #635 (multipart).

#### O commit transacional (#631) — "nada vai ao canal antes do banco"

O defeito que a fatia B corrige, textualmente da auditoria da #506: o ledger era
tratado em caminho **opcional e fail-open** (`claimOutboundLedgerOrFailOpen` em
`src/agent/output-dispatch.ts` — *"log the issue and proceed as if there's no
prior row"*), e enviar e persistir ficavam separados por uma janela de crash. As
duas coisas têm a mesma consequência: existe estado do mundo — uma mensagem no
telefone de alguém — que o PostgreSQL nunca soube que ia existir.

A ordem de todo ramo de saída passa a ser, **sem exceção**:

```
assertOutboundOwnership  →  ledger legado (#227)  →  COMMIT  →  canal
```

`commitOutboundIntent` abre **uma** transação
(`src/db/repositories/outbound-outbox-repo.ts::commitTurnOutboundTx`) que faz,
na mesma conexão:

1. `running | outbound_pending -> outbound_pending` com o **fence** da tentativa
   (`claim_token` vigente **e** `lease_expires_at > now()`) mais o CAS por
   `state_version`;
2. `INSERT` do artefato com a `logical_dedupe_key` (`ON CONFLICT DO NOTHING`);
3. o ponteiro `agent_turns.outbound_message_id` (via `coalesce`, então multipart
   não sobrescreve o elo da primeira parte);
4. a auditoria `outbound_committed` por `auditTx` — que **não** engole erro;
5. commit.

Qualquer falha faz ROLLBACK e **lança**. Não há retorno "deu ruim, siga em
frente"; não há `catch` que registre e prossiga. O erro sobe reclassificado como
`OutboundDeliveryError(delivered: false)` — a verdade literal (nada foi ao
canal), e o que faz o caller devolver `not_sent` em vez de `sent_no_persist`.

Decisões que parecem detalhe e não são:

- **`sequence_in_turn` é determinística por call site**, nunca "a próxima
  livre". A posição entra no material da chave: alocá-la dinamicamente faria o
  retry da mesma resposta derivar outra `logical_dedupe_key` e nascer como uma
  SEGUNDA linha — o duplo envio criado pelo mecanismo que existe para
  impedi-lo. Resposta principal = 0; o fallback poll→texto = 1.
- **`idempotency_key` da row durável recebe a `logical_dedupe_key`.** A coluna é
  `NOT NULL` desde a 063 e carrega o unique TOTAL `(tenant, agent,
  idempotency_key)`, enquanto o unique de #630 é PARCIAL — usar a mesma chave
  faz as duas constraints afirmarem a mesma coisa. O prefixo `mol1_` mantém a
  chave fora do espaço de nomes legado (`<conversa_uuid>:<mensagem_uuid>`).
- **O `WHERE` do fence não é reescrito**: vem de `turnWriteConditions()`
  (`src/db/repositories/turn-fence-sql.ts`), a mesma fonte única de
  `runTransition`. `agentTurnsRepo.markOutboundCommittedTx` **não** pode ser
  usada aqui porque ela abre a própria transação (`runTransition` chama
  `withTx`) — duas conexões, dois commits, e exatamente a janela que a fatia
  fecha.
- **O escopo do turno guarda o handle POR REFERÊNCIA.** `concludeTurn` grava com
  `expected_version: handle.state_version`; sem avançar o handle no commit, o
  CAS seguinte usaria a versão anterior, seria recusado como `state_mismatch`, e
  o turno ficaria preso em `outbound_pending` — resposta entregue, turno
  eternamente aberto.
- **Enqueue é wake-up, não fonte de verdade.** No instante do commit a row já
  está `pending` com `next_attempt_at = now()`, ou seja, já é selecionável pelo
  predicado de `idx_outbound_messages_ready` (migração 121). Um crash entre o
  commit e o enqueue deixa trabalho visível sem que nada consulte a BullMQ.

**Exceção declarada:** o ramo de **voz** de `dispatchOutput` não commita
artefato durável. O payload `audio` exige um `MediaRef` (`local_path` /
`storage_object`) e `synthesizeSpeech` devolve um Buffer **em memória** — não há
arquivo nem objeto a referenciar. `FEATURE_OUTBOUND_VOICE` tem default `false`
(não é caminho de produção hoje); decidir onde o áudio sintetizado passa a morar
é #634. O ramo de **documento** commita com `local_path`, válido enquanto quem
entrega é o mesmo processo — a migração para `storage_object` é da mesma fatia.

#### O ciclo de entrega (#632) — "aceito" não é "recebido"

O repositório da posse é `src/db/repositories/outbound-delivery-repo.ts`. Toda
mutação lá é **um** `UPDATE ... WHERE ... RETURNING`, nunca "SELECT elegível,
depois UPDATE": sob READ COMMITTED dois workers que disputam a mesma row
serializam no lock de row e o perdedor RE-AVALIA o `WHERE` (EvalPlanQual) contra
a versão nova, então volta zero linhas. Todo relógio é o do PostgreSQL.

**A máquina de estados da entrega:**

```
pending|retryable --claim--> claimed --markSending--> sending --outcome--> delivered --tx--> completed
                                                                       \-> delivery_unknown | retryable
                                                                           | failed_terminal | cancelled
```

**As três decisões que carregam a fatia:**

- **`sending` existe para tornar o crash diagnosticável.** Uma linha encontrada
  em `sending` com lease morta significa "a chamada ao provedor foi iniciada e o
  desfecho nunca foi registrado" — a mensagem pode estar no telefone do usuário.
  Sem essa escrita, o crash pré-envio e o pós-envio deixariam a linha idêntica
  em `claimed`, e o sucessor reenviaria algo já entregue.

- **O takeover de `sending` NÃO normaliza o estado de volta para `claimed`.** O
  `SET` do claim é
  `CASE WHEN status = 'sending' THEN 'sending' ELSE 'claimed' END`, e
  `markSending` exige `status = 'claimed'` no `WHERE`. O sucessor de uma chamada
  em voo é portanto **estruturalmente incapaz** de enviar — a garantia não
  depende de um `if` no worker. Ele registra `cancelled_after_send_unknown` e a
  linha vai para `delivery_unknown`.

- **`accepted_unconfirmed → delivery_unknown`, não `delivered`.** É a leitura
  literal de "não marcar `delivered` só porque a chamada foi iniciada".
  Consequência operacional concreta: `delivered` sai do radar da reconciliação,
  então uma resposta que nunca chegou ficaria marcada como entregue para sempre.

**Tabela desfecho ⇒ estado** (`statusForOutcome`, fonte única):

| Desfecho normalizado | Estado | Reenvio automático |
|---|---|---|
| `accepted_confirmed` | `delivered` → `completed` | — |
| `accepted_unconfirmed` | `delivery_unknown` | só com chave nativa |
| `rejected_retryable` | `retryable` | **sim** (semântica exclui entrega) |
| `rejected_terminal` | `failed_terminal` | nunca |
| `timeout_unknown` | `delivery_unknown` | só com chave nativa |
| `cancelled_before_send` | `cancelled` | **sim** (semântica exclui entrega) |
| `cancelled_after_send_unknown` | `delivery_unknown` | só com chave nativa |

#### A capability de idempotência do provedor — o Baileys honra UM tipo

`LineOutput` (`src/gateway/line-output.ts`) declara `messageId` em **`sendText`
e mais nada**. Ele desce para `MiscMessageGenerationOptions.messageId`, o
Baileys o grava verbatim na key da mensagem, e o WhatsApp chaveia por
`(remoteJid, fromMe, id)` — para texto a dedupe é do provedor, de verdade.
`sendDocument`, `sendVoice`, `sendPoll` e `sendReaction` não aceitam a chave: um
reenvio produz mensagem NOVA no telefone do usuário.

Isso é encapsulado em `providerIdempotencySupport(channel, payload_type)`, com
`satisfies Record<OutboundPayloadType, …>` — um `payload_type` novo sem entrada
é **erro de compilação**, não um default silencioso (e o default silencioso
perigoso seria `native`). Duas perguntas separadas de propósito:
`shouldPassIdempotencyKey` decide se o valor é passado adiante (inofensivo);
`retrySafety` decide se ele autoriza reenvio (é aí que mora a duplicata).

| `payload_type` | Chave nativa no WhatsApp |
|---|---|
| `text`, `status_fallback` | `native` (`sendText(…, { messageId })`) |
| `audio`, `document`, `reaction`, `interactive_poll` | `none` |

`retrySafety` devolve **três** valores e não dois: `safe` (a semântica exclui
entrega anterior), `idempotent` (pode ter saído, mas o provedor deduplica **para
este tipo**) e `reconcile` (pode ter saído e o provedor não deduplica — #633).

#### Histórico idempotente, e o job determinístico

`delivered → completed` e o `INSERT` em `mensagens` acontecem na **mesma
transação** (`completeDeliveryTx`), fenced pelo `claim_token`. A idempotência é
do ESTADO e é atômica: `delivered` = sem histórico, `completed` = com histórico.
`completed` não é reivindicável, então não há caminho que produza duas linhas de
histórico para a mesma saída lógica — e nenhuma chave de dedupe nova foi
inventada em `mensagens`.

Por isso `recordDeliveryOutcome` **preserva** a posse quando o desfecho é
`accepted_confirmed`: soltar o `claim_token` ali deixaria `completeDeliveryTx`
sem fence a exibir, e a linha ficaria eternamente `delivered` sem histórico.
Nos demais desfechos a posse é liberada, porque a linha é terminal para a
entrega e um dono morto faria o recovery esperar por um worker que já foi
embora.

`outboundDeliveryJobId(outbound_id)` → `outbound-<uuid>` (`delivery-job.ts`). É
por `outbound_id` e **não** por turno: multipart tem N saídas do mesmo turno, e
um id derivado do turno faria a segunda parte colidir com a primeira e ser
descartada pela BullMQ — uma resposta que some. `attempt` não participa da
derivação: incluí-lo daria id novo por tentativa e a colisão desapareceria
exatamente no cenário que ela cobre.

#### O que aconteceu com `recordInlineDeliveryOutcome` (escopo emprestado de #631)

Ele foi **removido**. `src/agent/output-dispatch.ts` agora reivindica a linha e a
move para `sending` antes de cada chamada ao canal
(`claimInlineDeliveryOrRefuse` → `beginInlineDelivery`) e grava o desfecho com o
fence (`recordInlineDelivery`). Os três buracos que a função provisória tinha,
todos fechados: sem claim/lease/fence (o caminho síncrono sobrescrevia o
desfecho de um delivery worker); sem `sending` (crash pós-envio deixava
`pending`, e o recovery reenviaria); e `accepted_unconfirmed → delivered`
(estado desonesto). O que continua diferente do worker de verdade — quem envia
ainda é o processo do turno, montando `line.send*` no dispatcher em vez de usar
`sendPayloadToProvider` — é **#634**.

Isso acrescenta **um** `await` entre o commit e o canal, e é a única coisa que
pode entrar ali: ela FECHA uma janela em vez de abrir (sem ela a linha fica
`pending` durante o envio) e falha fechado (sem posse não há `send*`).

#### Limitações declaradas de #632

- **`sendReaction` devolve `void`.** Sem identificador e sem confirmação, o
  melhor desfecho honesto é `accepted_unconfirmed` — uma reação termina em
  `delivery_unknown`. Fingir `accepted_confirmed` seria inventar confirmação.
- **`storage_object` não é resolvível ainda.** O worker lê `local_path` do
  disco; uma referência de storage é recusada como `rejected_terminal`
  (`media_ref_unresolved`) em vez de enviar outra coisa. O resolvedor é #634.
- **Janela entre `delivered` e `completed`.** Um crash ali deixa a linha com
  claim vivo e lease vencendo, e ela **não** volta a ser reivindicável — o que é
  correto (a mensagem chegou; reenviar duplicaria). O histórico faltante é
  reconciliação de #633, não entrega.
- **Nenhum consumidor de fila foi registrado.** `deliverOutbound` é a
  responsabilidade isolada e o `jobId` é determinístico, mas quem enfileira e
  quem consome é #633/#634 — registrar um worker aqui exigiria uma flag de
  rollout cujo escopo é daquelas fatias.

#### A flag, e por que ela não pode ser desligada em produção

`FEATURE_OUTBOUND_DURABLE_COMMIT` (default ON) é a alavanca de rollback. Uma
garantia de durabilidade que possa ser desligada em produção **não é** um kill
switch — é o caminho fail-open com outro nome. Por isso duas regras cross-field
(`src/config/rules.ts`):

| Regra | Efeito |
|---|---|
| `outbound-commit/production-required` | `false` no profile `production` ⇒ **erro de BOOT**. Escopo `boot` de propósito: a regra vale também sob `MAIA_CONFIG_STRICT_BOOT=false`, senão a alavanca de emergência do contrato viraria a alavanca para desligar a durabilidade. Em staging avisa; em development é silencioso |
| `outbound-commit/requires-state-machine` | `true` com `FEATURE_TURN_STATE_MACHINE=false` é INERTE (sem `turn_id` a FK composta da 121 torna a row inexprimível) ⇒ erro de contrato |

#### As duas identidades, e por que são duas

| Chave | Responde | Quem vê |
|---|---|---|
| `logical_dedupe_key` | "qual saída lógica é esta, dentro da Maia" | só a Maia (é o eixo do UNIQUE parcial) |
| `provider_idempotency_key` | "que identificador o adaptador usa" | o provedor (vira `messageId` do Baileys) |

As duas saem do **mesmo material canônico** — `tenant_id`, `agent_id`,
`turn_id`, `sequence_in_turn`, `payload_hash` — e se separam por **rótulo de
domínio diferente** no hash. Consequências:

- **mesma saída lógica em retry reutiliza as duas chaves** (o material só tem
  campo imutável — `attempt`, `status` e timestamps ficam de fora; uma chave
  que muda entre tentativas garantiria o duplo envio que existe para impedir);
- **payload diferente não reutiliza chave** (`payload_hash` entra no material);
- **o provedor nunca recebe a chave de dedupe interna da Maia** (domínios
  disjuntos: nenhuma é derivável da outra sem o material);
- **nenhuma expõe tenant, telefone ou conteúdo** — são digests, então logá-las
  é inerte.

#### Enquadramento por prefixo de comprimento

`tenants.id` e `agents.id` são `TEXT PRIMARY KEY` **sem CHECK de formato**
(migração `007_p0_tenants_agents.sql`) — um id **pode** conter `:`. A
concatenação sugerida em #506 (`maia:outbound:v1:<tenant>:<agent>:…`) é
portanto ambígua **de verdade**, não em teoria:

```
tenant='acme:x'  agent='y'    →  "…:acme:x:y:…"
tenant='acme'    agent='x:y'  →  "…:acme:x:y:…"
```

Dois tenants diferentes, uma chave só — violação do invariante nº 1. O
material usa **netstring** (`<bytes>:<conteúdo>`, bytes em UTF-8), que é
injetivo para qualquer string, inclusive uma que contenha o separador ou NUL.
Não reusa o separador NUL de `deriveProviderDedupKey`
(`src/governance/idempotency-effects.ts`) porque aquilo depende de "nenhum
componente contém NUL" — outra suposição sobre dado de terceiro.

#### Tipos de payload — o que foi verificado, não presumido

A fronteira única de saída física é a interface `LineOutput`
(`src/gateway/line-output.ts`; acesso direto às primitivas é proibido por
lint). Ela declara `sendText` / `sendVoice` / `sendDocument` / `sendPoll` /
`sendReaction`. Daí:

- suportados: `text`, `audio`, `document`, `reaction`, `interactive_poll`,
  `status_fallback`;
- **`image` e `video` não existem** — não há primitiva, e #506 §Out of Scope
  proíbe implementar tipo que a plataforma ainda não suporta. Admiti-los só no
  schema criaria row que nenhum worker entrega: um `pending` eterno, fail-open
  fantasiado de completude;
- **`interactive` genérico não existe** — a única forma real é a enquete, e o
  nome é `interactive_poll` justamente para ninguém concluir que botão/lista
  estão cobertos.

Mídia entra por **referência** (`local_path` / `storage_object`), nunca URL:
segredo, token e URL assinada não têm forma de ser persistidos porque **não
existe variante do tipo que os aceite** — garantia estrutural, não uma lista
de regex de assinatura que se espera completa.

### Feature flags (`src/runtime/feature-flags/`)

| File | Role |
|---|---|
| `decision-engine-flag.ts` | Gates F1 decision-engine usage |
| `context-packet-flag.ts` | Gates context-packet usage |

### Guardrails (`src/runtime/guardrails/`)

| File | Role |
|---|---|
| `late-pep.ts` | Late policy enforcement (post-execution) |

### Prompt (`src/runtime/prompt/`)

| File | Role |
|---|---|
| `build-prompt-from-packet.ts` | Renders prompt from context packet |

### Lifecycle (`src/runtime/lifecycle/`) — issue #512

Process-level (not per-turn) infrastructure: the explicit `starting → ready →
draining → stopped ↘ failed` state machine, role-aware readiness and the
ordered graceful shutdown. `src/index.ts` drives it; `src/server.ts` exposes it
through `/livez`, `/startupz` and `/readyz`.

| File | Role |
|---|---|
| `roles.ts` | **Process role contract** — `ProcessRole`, `LifecycleComponent`, `ROLE_CONTRACTS`, `roleOwns()`, `roleRequires()`. What a role STARTS vs what gates its readiness. Consumed by issue #513 (topology separation). |
| `controller.ts` | Singleton state machine: legal transitions, component registry, idempotent shutdown with an ordered step list + deadline, `isAcceptingWork()` (the "no new work" gate), abortable startup (`runStartupStep`), background-task registry, `maia_lifecycle_state` gauge |
| `shutdown-sequence.ts` | The ordered steps and the signal handlers. Order is the contract: stop accepting work → drain crons → drain BullMQ → drain background tasks → close the turn-context subscriber (#511, its own ioredis connection) → close sessions → HTTP → audit → pools |
| `readiness.ts` | Composite, role-aware `/readyz` + `/startupz` evaluation. Read-only, per-component timeout, memoized, sanitized output |
| `schema-readiness.ts` | **The `/readyz` schema gate** (#516): cached, single-flight adapter over `getSchemaReadiness()`. Dirty state, checksum divergence, a migration file this build does not ship, an incompatible head and an unreadable database all keep the instance at 503. Verdict cached for `SCHEMA_READINESS_TTL_MS` (10s) so an LB poll is not a load generator |
| `schema-boot-gate.ts` | **The BOOT decision** over that verdict (#516, ADR 0004): blocker kind ⇒ exit code (90-97), precedence between simultaneous blockers, and the actionable death message. PURE — no I/O; `src/index.ts` is the only caller and the only place that calls `process.exit()`. Replaced `schema-version.ts`, the pre-#516 comparison, which was deleted |
| `index.ts` | Public barrel (import the role contract from here) |

Rules this module enforces:

- readiness is impossible outside `ready`, and turns 503 on the first request after a drain starts — the state is checked before AND after the probes, so a drain that begins mid-probe still answers not-ready;
- **no new work after `draining`**: BullMQ workers are paused in the first shutdown step, the processor re-parks a job handed to it during the race, cron ticks are refused, and Baileys reconnect timers are cancelled instead of awaited;
- the STARTUP is cancellable too — a signal mid-boot aborts at the next phase boundary and the shutdown waits for the phase in flight (and records `startup:<phase>` as undrained if that wait expires, which forces a non-zero exit);
- the boot does not declare `ready` — nor audit `system_started`, nor let `/startupz` pass — until every component the ROLE requires is genuinely up, including the first WhatsApp `open` (`waitForComponent`);
- a required component that is `down`/`unknown` keeps the instance out of rotation (fail-closed);
- probes never write and never return raw driver text;
- shutdown is idempotent — concurrent signals share one promise — and closes consumers before the pools they use;
- undrained components are reported (log + `maia_shutdown_total{result="incomplete"}`), never silently dropped.

## Patterns it follows

- [Action layer](../concerns/action-layer.md) — decision engine + PEPs + skill modes
- [Tenant isolation](../concerns/tenant-isolation.md) — every slice cache key includes tenant
- [Governance + observability](../concerns/governance-observability.md) — each PEP emits audit
- [Channel/role/policy](../concerns/channel-policy.md) — agent-selector reads channel_policy

## How to extend

| Need | Where |
|---|---|
| Add a decision step | New file under `src/runtime/decision/`; wire from `decision-engine.ts`; emit audit |
| Add a context slice | New builder under `slice-builders/`; new entry in `cache/ttl-policy.ts`; register in `production-builder-set.ts` |
| Add a feature flag | New file under `feature-flags/`; default `false`; reference from gated code |
| Add a PEP | New PEP file (`<n>-pep.ts`); emit audit; document in `governance-observability.md` |

## Public surface

| Consumed by | What |
|---|---|
| `src/agent/core.ts` | Invokes decision engine per turn |
| `src/skills/` | Receives decision output |
| `src/cognitive-graph/` | Builds context for graph nodes |

## Tests

| Test path | What it covers |
|---|---|
| `tests/unit/decision/skill-match.spec.ts` | Strict `>` threshold |
| `tests/unit/decision/action-decider/` | Routing decisions |
| `tests/unit/runtime/context-packet/` | Slice assembly + cache |
| `tests/unit/runtime/feature-flags/` | Flag defaults |
| `tests/unit/runtime/lifecycle-roles.spec.ts` | Process role contract (#512/#513) |
| `tests/unit/runtime/lifecycle-controller.spec.ts` | State machine, idempotent shutdown, drain deadline |
| `tests/unit/runtime/lifecycle-readiness.spec.ts` | Role-aware `/readyz` + `/startupz` fail-closed cases |
| `tests/unit/runtime/schema-boot-gate.spec.ts` | The boot gate driven through the REAL `src/index.ts` (#516, ADR 0004): exit code per invariant, death-message fields, and the happy path getting past the schema step |
| `tests/unit/runtime/lifecycle-schema-readiness.spec.ts` | The `/readyz` schema gate: every blocking condition through the real decision core, plus the TTL/single-flight cost contract |
| `tests/unit/runtime/lifecycle-shutdown-order.spec.ts` | Shutdown step ORDER as a contract |
| `tests/unit/runtime/lifecycle-startup-abort.spec.ts` | Signal mid-boot: cancellation + serialization |
| `tests/unit/runtime/lifecycle-whatsapp-readiness.spec.ts` | Never-established vs reconnecting |
| `tests/unit/runtime/lifecycle-wait-for-component.spec.ts` | `ready`/`system_started`/`/startupz` gated on the first `open` |
| `tests/unit/runtime/lifecycle-background-tasks-wired.spec.ts` | The drain observes real fire-and-forget work |
| `tests/unit/gateway/queue-drain-guard.spec.ts` | No job starts after draining |
| `tests/unit/gateway/queue-await-ready.spec.ts` | `waitUntilReady` before claiming ready |
| `tests/integration/lifecycle-probes.spec.ts` | Probes against real Postgres/Redis; `/health` writes no rows |
| `tests/unit/server/health-probe-contract.spec.ts` | Which endpoint carries the verdict (#613): `/health` stays 200 when `down`, `/livez` 200 with no I/O, `/startupz`/`/readyz` 503 — all through the real `buildServer()` |
| `tests/integration/lifecycle-drain-queue.spec.ts` | Real Redis: job enqueued during the drain never runs |
| `tests/unit/turn-state-machine.spec.ts` | Tabela completa de transições válidas/inválidas, outcome obrigatório em terminal, sanitização do erro |
| `tests/unit/turn-lifecycle.spec.ts` | Kill switch, derivação outcome→estado, retry/dead letter, fail-soft |
| `tests/integration/agent-turns-real-db.spec.ts` | CAS concorrente, FK composta, projeção legada, backfill idempotente, plano do índice |
| `tests/integration/agent-turns-leak.spec.ts` | Leak cross-tenant do `agentTurnsRepo`, incluindo claim/heartbeat/liberação (parte de `npm run test:leak`) |
| `tests/unit/turn-claim-contract.spec.ts` | Estabilidade do `jobId`, payload V1/V2, aritmética do lease, identidade do worker |
| `tests/integration/turn-claim-real-db.spec.ts` | Corrida de 2/10/50 callers, takeover por lease vencida, fencing do zumbi, elegibilidade por estado, isolamento |
| `tests/integration/turn-claim-lifecycle-real-db.spec.ts` | O claim visto pela FACHADA (`beginTurnExecution`/`concludeTurn`); lease marcada como perdida e lease liberada **sem takeover** não alteram a linha; uma escrita recusada = UM incremento da métrica de fence |
| `tests/integration/turn-claim-core-barrier-real-db.spec.ts` | O core OBEDECE a barreira: entra por `runAgentForMensagem` com o turno genuinamente reivindicado por outro dono e observa o efeito no banco — prova que o cadeado está na PORTA, não só que funciona. Cobre também a posse perdida NO MEIO do turno (o core não carimba `processada_em`), que é o que pinga o `runWithTurnExecution` do core |
| `tests/integration/turn-lease-lost-effects-real-db.spec.ts` | Perda de lease DURANTE a execução, pelo caminho real (takeover + heartbeat): nenhuma linha em `agent_facts` (tool) nem em `outbound_messages` (outbound), com caso de controle exigindo as duas presentes |
| `tests/unit/decision-engine-trace-ownership-boundary.spec.ts` | A janela entre o guard de posse do Decision Engine e o CONSUMO do pacote: com `traceTurnDecision` DEFERIDO, a lease cai enquanto o envelope durável está em voo e o teste exige `TurnOwnershipLostError` — e nenhum efeito posterior — tanto no resolve quanto no reject |
| `tests/integration/turn-job-id-real-redis.spec.ts` | Redis real: colisão do `jobId`, job retido `completed`/`failed` não bloqueia rearme, job vivo é respeitado |
| `tests/unit/runtime/outbound-contract.spec.ts` | #630: união Zod por tipo, canonicalização (ordem de chave não move o hash; ordem das opções da enquete move), e as quatro propriedades das chaves — estabilidade no retry sob campos mutáveis, isolamento entre tenants, não-colisão sob ambiguidade de separador, e payload distinto não reutiliza chave. **Nenhuma cópia da fórmula**: tudo é relação entre saídas da função real |
| `tests/integration/outbound-durable-outbox-schema-real-db.spec.ts` | #630 com Postgres real: row legada continua inserível, uniques PARCIAIS recusam a segunda saída e ignoram o legado, CHECK de completude impede meia-row, FK composta impede apontar para turno de outro tenant |
| `tests/integration/outbound-commit-transacional-real-db.spec.ts` | #631 com Postgres real, entrando por `dispatchOutput`/`sendOutbound` (o call site de produção, não um harness): o double do canal **consulta o banco por conexão própria no instante do envio**, de modo que "nada vai ao canal antes do banco" vira afirmação verificável. Cobre também worker sem posse, CAS de versão, rollback total quando a falha acontece ENTRE as duas escritas, idempotência da saída lógica (uma linha **e** um envio), `delivery_unknown` em vez de `delivered` fingido, e a linha selecionável pelo recovery no instante seguinte ao commit |
| `tests/unit/config/outbound-durable-commit-rule.spec.ts` | #631: a flag não pode ser fail-open — default ON, `false` em production é erro de escopo `boot` (sobrevive a `MAIA_CONFIG_STRICT_BOOT=false`), aviso em staging, silêncio em development, e inerte sem a máquina de estados é erro |
| `tests/unit/runtime/outbound-delivery-contract.spec.ts` | #632: o contrato PURO da entrega — elegibilidade do claim alinhada ao índice de #630, nenhum estado terminal reivindicável, a matriz TOTAL (7 desfechos × 6 tipos) da política de reenvio, a capability declarada para todo `payload_type` (nenhum default otimista), e o jobId determinístico por `outbound_id` (colisão do multipart, namespace disjunto do turno, fail-loud em id malformado, payload `.strict()`) |
| `tests/integration/outbound-delivery-claim-lease-fence-real-db.spec.ts` | #632 com Postgres real, entrando por `deliverOutbound`: claim concorrente com **2, 10 e 50** workers (exatamente um vence, `attempt` prova UM update); takeover por lease com o token velho recusado nas TRÊS gravações (confirmar, reenviar, renovar); **crash depois de o provider aceitar não vira reenvio** (o fake conta 1 chamada e a linha termina `delivery_unknown`); `delivered` não é marcado por chamada iniciada; caminho feliz até `completed` com histórico único e a chave idempotente entregue ao adaptador |
| `tests/unit/observability/outbound-delivery-metrics-sem-pii.spec.ts` | #632: as duas séries que a issue exige existem com o nome e o rótulo (`maia_outbound_lease_lost_total{reason}`, `maia_outbound_delivery_unknown_total{channel}`), e o texto RENDERIZADO do `/metrics` não contém telefone, JID nem conteúdo — nem quando eles são passados como chave (deny list) nem como valor de um label permitido (guarda de PII por valor) |

## In-flight changes

At last verification (2026-05-28):

- Decision-engine F1 Phase 0/1 (#216, #217 — merged)
- Decision-engine harden skill-match threshold to strict `>` (#219, #223 — merged)
- Context-builder defaultResolver fixture-only (#282 → #296 — open)
- Real OperationalProfilePort wired in production-builder-set (#206 → #212 — merged)
- Knowledge_slice cache `agent_id` (#235 → #242 — open)

Verify: `gh pr list --state open --search "decision OR context-packet OR runtime"`.

---

| | |
|---|---|
| Last verified | 2026-05-28 |
| Against `main` HEAD | `c49c3855` |
