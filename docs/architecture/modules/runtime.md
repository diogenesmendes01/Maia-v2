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
| `claim.ts` | Vocabulário PURO do claim (#504): elegibilidade, resultados tipados, identidade do worker, aritmética do lease. Sem I/O. Desde #625 também guarda a exclusão POR STREAM: `STREAM_OCCUPYING_STATUSES` (o predicado do índice `agent_turns_stream_active_uq` escrito em TypeScript), `STREAM_EXCLUSION_CONSTRAINT` (o nome que o `23505` precisa carregar para virar `stream_busy`) e o próprio motivo `stream_busy`. Desde #626 é também o VOCABULÁRIO ÚNICO do escalonamento por stream: `STREAM_SCHEDULING_RESULTS` (os cinco códigos que a issue manda centralizar — `eligible`, `not_head`, `stream_blocked`, `stream_busy`, `promoted`), `STREAM_BLOCKED_REASONS` (o subconjunto que vira label de `maia_stream_blocked_total`), `STREAM_FIFO_VIOLATION_STAGES` e `STREAM_HEAD_OF_LINE_INDEX`. `promoted` entra sem produtor de propósito: a #627 acrescentar um sexto rótulo a uma série já em uso quebraria alertas em silêncio. Desde #629 há um SEXTO código, `stream_poisoned` — a conversa está interditada por política de poison —, e ele é ACRESCENTADO, não redefinido: nenhuma série existente muda de significado. Reusar `stream_blocked` não era opção: as duas param a conversa e as remediações são opostas ("vá ao runbook do outbox e espere" contra "nada acontece sem um humano"). Também o tipo `StreamBlockRecord`, a moeda entre o repositório que PRODUZ a interdição, a fachada que a AUDITA e a operação que a resolve. |
| `job.ts` | Identidade determinística do job na BullMQ (#504): `agentTurnJobId(turn_id)` e a leitura dual do payload V1/V2. Puro — não importa `bullmq`. |
| `lease.ts` | POSSE viva (#504): o único módulo com TEMPO — heartbeat, perda, cancelamento e liberação. Dono do contador `maia_turn_fence_rejected_total`. Desde #625 também AUDITA a exclusão por stream: `turn_stream_busy` (o banco recusou um segundo turno ativo) e `turn_stream_claim_recovered` (um claim expirado foi recuperado dentro da transação do claim). O repositório continua puro-DB e não audita. Desde #626, também `turn_stream_blocked` (a conversa tem fila) e `turn_stream_fifo_violation` (o canário disparou) — e é ele que SEMEIA `maia_stream_fifo_violation_total`/`maia_stream_blocked_total` em zero no import, para que "sempre zero" seja uma afirmação medida em vez de uma série ausente. |
| `stream-metrics.ts` | #626 — as séries do escalonamento por stream (`maia_stream_fifo_violation_total{stage}`, `maia_stream_blocked_total{reason}`) e o SEMEADOR que as publica em ZERO. Existe porque quem DETECTA a violação é o repositório (o canário roda no `RETURNING` do claim), e `turn-repos.ts` é compartilhado com o console — não pode alcançar `src/config/env.ts` (#596). Importa só `@/lib/metrics.js` e o vocabulário puro de `claim.ts`. Desde #629 também `maia_stream_poison_total{category,disposition}` (a DECISÃO da política, semeada nas 12 combinações) e os BALDES em segundos de `maia_stream_turn_wait_seconds` — declarados por `declararBaldesDeEspera()`, que é chamada TAMBÉM no ponto de observação (`lease.ts`) e não só no boot: `src/lib/metrics.ts` congela os baldes de uma série na PRIMEIRA amostra, então um processo que só roda workers nasceria com os baldes de milissegundos e ficaria assim para sempre. |
| `poison-policy.ts` | #629 (fatia F da #505) — a POLÍTICA de poison/DLQ, PURA (sem `db`, sem ALS, sem `@/config/env.js`, sem métricas). `classifyPoison` mapeia `(código de erro, outcome)` em seis categorias de cardinalidade FECHADA (`effect_committed`, `model`, `transport`, `infrastructure`, `operator`, `unknown`) e `poisonDisposition` decide entre `release` e `block_stream` contra um conjunto que entra como PARÂMETRO — ler a env aqui faria todo teste de política medir `process.env` em vez da regra. O `outcome` DOMINA o código: `unsafe_to_retry` é produzido por `decideTurnAction` exatamente quando uma tool irreversível já rodou, e o código que o acompanha é o motivo da saída do ReAct, isto é, sintoma. `parsePoisonBlockCategories` falha FECHADA numa categoria desconhecida — silenciá-la produziria um dashboard sem bloqueio nenhum, e a leitura natural seria "não aconteceu nenhum caso" em vez de "a política está desligada". |
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
| `maia_turn_claim_total` | `result` = `acquired` / `not_eligible` / `not_found` / `stream_busy` (#625) / `not_head` / `stream_blocked` (#626) / `stream_poisoned` (#629). `stream_busy` fala da STREAM (a conversa está ocupada), `not_eligible` fala do TURNO — colapsar os dois apagaria o único sinal de uma conversa serializando, que é o risco que a #505 manda vigiar no rollout. Depois de #626 `stream_busy` deve CAIR quase a zero: o head-of-line recusa antes, e o que sobra para o índice são turnos sem `first_ingress_seq` e sequências empatadas. |
| `maia_stream_blocked_total` | `reason` = `not_head` / `stream_blocked` / `stream_busy` (#626) / `stream_poisoned` (#629 — sobe e NÃO volta sozinha: cada ponto é uma tentativa contra uma conversa que nenhum worker vai destravar). `not_head` é ROTINA — cada mensagem que chega enquanto a anterior roda conta um ponto. O que se vigia é a FORMA: `not_head` crescendo sem `acquired` correspondente é conversa parada. |
| `maia_stream_fifo_violation_total` | `stage` = `claim` / `recovery` (#626). **Sempre zero** — a issue-mãe lista `> 0` entre os critérios de ABORTAR o rollout. Publicada em ZERO no import de `lease.ts`: um contador que nasce na primeira violação satisfaria "sempre zero" por AUSÊNCIA, e nenhum alerta escrito contra ele dispararia. |
| `maia_stream_head_age_seconds` / `maia_stream_head_age_p95_seconds` | Sem labels (#629). Idade do head MAIS VELHO e o p95, lidos no SCRAPE do banco por `src/observability/stream-fairness-collector.ts`. O MÁXIMO e não a média: fairness é uma pergunta sobre o PIOR caso, e uma média com 10 mil conversas instantâneas e uma parada há duas horas fica excelente escondendo o usuário abandonado. Sem o p95, "uma conversa presa" e "a plataforma toda atrasada" produzem o mesmo máximo. |
| `maia_stream_turn_wait_seconds` | Histograma sem labels (#629), baldes em SEGUNDOS com cortes nos marcos REAIS do sistema (120s = `STUCK_AFTER_MS`, 300s = starvation, 900s = teto do backoff). Observado no CLAIM, a partir de `now() - COALESCE(queued_at, created_at)` medido pelo relógio do BANCO — com `Date.now()` a série mediria skew de NTP junto com a espera. Par de `head_age`: esta mede quem JÁ COMEÇOU, aquela mede quem AINDA NÃO — e medir só a primeira é a forma clássica de não ver starvation. |
| `maia_stream_active_total` / `maia_stream_live_total` | Sem labels (#629). Conversas com turno ATIVO agora, e conversas com qualquer turno vivo. Com head-of-line cada stream ocupa no máximo UMA vaga, então `active_total` é literalmente "quantas conversas distintas estão sendo atendidas em paralelo"; preso em 1 com `live_total` alto é serialização. |
| `maia_stream_backlog_max` | Sem labels (#629). Maior backlog de uma ÚNICA conversa. É a MEDIÇÃO do que a issue-mãe chama de "limites de backlog por stream"; o limite NÃO é aplicado, porque a única pressão possível no ingresso seria recusar mensagem de usuário — perda de dado. Ver runbook §14.5. |
| `maia_stream_starvation_total` | Sem labels (#629). EPISÓDIOS de head parado além de `TURN_STREAM_STARVATION_AFTER_MS`, deduplicados por token opaco (`md5(tenant:agent:stream_key)`) em memória — sem a deduplicação a série mediria a frequência do Prometheus, não a saúde da plataforma. O token nunca vira label nem log. |
| `maia_stream_poisoned_streams` | Sem labels (#629). Conversas INTERDITADAS agora. Cada ponto é uma conversa que nenhum mecanismo automático destrava; não voltar a zero é trabalho de operador acumulando. |
| `maia_stream_poison_total` | `category` × `disposition` (#629). As DUAS dimensões, e nenhuma é redundante: a pergunta operacional é o cruzamento. `{category="effect_committed",disposition="release"}` crescendo significa que alguém tirou a categoria da lista e a plataforma segue conversas por cima de efeitos irreversíveis pela metade. |
| `maia_turn_stream_claim_recovered_total` | `from` = `claimed` / `running` (#625). Quantos claims EXPIRADOS a transação de claim devolveu à fila. Em operação saudável é ZERO — cada ponto é um worker que morreu segurando uma conversa. |
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

Auditoria: só as ANOMALIAS (`turn_lease_lost`, `turn_fence_rejected`, e desde
#625 `turn_stream_busy` e `turn_stream_claim_recovered`). Claim e heartbeat
rotineiros ficam em métrica — auditá-los seria uma row por batida.

**Exclusão por stream (#625, fatia B da #505).** A invariante é "no máximo um
turno ativo por stream", e ela vive em DUAS metades que só funcionam juntas:

1. **estrutural** — o índice único parcial `agent_turns_stream_active_uq`
   (migration 124) sobre `(tenant_id, agent_id, stream_key)` onde
   `status IN ('claimed','running')`. É ele que DECIDE: um segundo claim na
   mesma stream levanta `23505` e vira `stream_busy`. O escopo faz parte da
   chave — sem `tenant_id`/`agent_id` nela, duas tenants com a mesma
   `stream_key` passariam a competir;
2. **temporal** — a recuperação de claims EXPIRADOS dentro da MESMA transação
   do claim (`agentTurnsRepo.tryClaimTurn`). Sem ela, o primeiro crash de worker
   deixa uma linha `claimed` com lease vencida ocupando a chave e a stream fica
   bloqueada para sempre: o índice deixa de ser proteção e vira o defeito.

`outbound_pending` está deliberadamente FORA do predicado — a resposta já está
comprometida no outbox (#506) e quem finaliza é o delivery worker, que não
disputa posse. Incluí-lo prenderia a conversa pela latência do provedor de
saída. Consequência honesta: entre `outbound_pending` e o terminal a stream
aceita um novo claim. Isso não é reordenação — QUEM pode ser reivindicado é o
head-of-line (#626), que é outra fatia; esta decide QUANTOS podem estar ativos.

**Head-of-line (#626, fatia C da #505).** A pergunta desta fatia é a outra:
**quem** pode ser reivindicado. A resposta é "o de menor `first_ingress_seq`
entre os não terminais da stream", e ela é um `NOT EXISTS` no `WHERE` do claim
— [`src/db/repositories/stream-head-sql.ts`](../../../src/db/repositories/stream-head-sql.ts),
um módulo PURO com QUATRO consumidores e nenhuma segunda cópia.

Três consequências que não são óbvias:

1. **`outbound_pending` bloqueia a ORDEM, mesmo não ocupando a stream.** As duas
   afirmações convivem porque respondem a perguntas diferentes. O efeito
   prático é que uma indisponibilidade do outbox para a CONVERSA (não o tenant,
   não a fila), com o código `stream_blocked` — distinto de `not_head`
   justamente porque esperar não resolve. É o preço de FIFO, e a alavanca para
   não pagá-lo é a flag, não o predicado.
2. **O recovery usa a MESMA função.** `findRecoverableTurns` e o dispatcher
   cross-tenant filtram pelo mesmo `streamHeadOfLineNotExists`. Sem isso o
   varredor rearmaria turnos que o claim vai recusar: a fila cresce, a métrica
   de recovery diz que houve trabalho, e a conversa não anda.
3. **A recuperação de claim expirado deixou de beneficiar o sucessor.** Antes,
   o sucessor reivindicava e a transação destravava o head morto — a conversa
   andava na hora, fora de ordem. Agora o head volta a `retryable` e o sucessor
   é recusado; quem avança é o head, na vez dele, quando o recovery o rearmar
   (até `STUCK_AFTER_MS`). Ordem comprada com latência no caminho de crash; a
   promoção idempotente do sucessor (#627) devolve a latência sem devolver a
   inversão.

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

### Outbox de saída (`src/runtime/outbound/`) — issue #506, fatias A (#630), B (#631), C (#632), D (#633) e E (#634)

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

**A exceção de voz foi FECHADA em #634.** O ramo de voz de `dispatchOutput`
commita artefato durável como qualquer outro: os bytes da síntese vão para o
store de `src/runtime/outbound/media-store.ts` **antes** do commit e o payload
`audio` referencia um `storage_object`. O ramo de **documento** também deixou de
usar `local_path`. Ver "Onde a mídia de saída mora (#634)" abaixo.

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
- ~~**`storage_object` não é resolvível ainda.**~~ **Resolvido em #634**:
  `resolveOutboundMediaPath` (`media-store.ts`) devolve o caminho real,
  fail-closed em bucket, forma da chave, ESCOPO (tenant/agent) e contenção. Uma
  referência que não resolve continua terminando em `rejected_terminal`
  (`media_ref_unresolved`) — mas isso agora significa "o objeto sumiu", não "o
  worker não sabe ler".
- **Janela entre `delivered` e `completed`.** Um crash ali deixa a linha com
  claim vivo e lease vencendo, e ela **não** volta a ser reivindicável — o que é
  correto (a mensagem chegou; reenviar duplicaria). O histórico faltante é
  reconciliação de #633, não entrega.
- **Nenhum consumidor de fila foi registrado.** `deliverOutbound` é a
  responsabilidade isolada e o `jobId` é determinístico, mas quem enfileira e
  quem consome é #633/#634 — registrar um worker aqui exigiria uma flag de
  rollout cujo escopo é daquelas fatias. **Fechado por #633** (ver abaixo).

#### A recuperação (#633) — o que fazer com o que ficou para trás

Quatro operações por tick de `outbound_recovery`
(`src/workers/outbound-recovery.ts`, 1 min, gated por `FEATURE_OUTBOUND_RECOVERY`):

1. **rearmar o entregável** — `pending`/`retryable` com o gate de backoff vencido
   E `claimed`/`sending` com lease morta (takeover). As duas famílias saem juntas
   porque o consumidor faz a MESMA coisa com as duas: rearmar o job. A diferença
   entre "nunca teve dono" e "o dono morreu" é resolvida DENTRO do claim atômico
   (`claimDisposition`), que é onde ela precisa ser resolvida;
2. **reconciliar o incerto** — `delivery_unknown`, `reconciling` e a janela
   `delivered -> completed`;
3. **DLQ** — teto de tentativas (12) e prazo de reconciliação (24h), auditados;
4. **divergência turno↔outbound**, nos dois sentidos, como OBSERVAÇÃO.

##### Por que sweepers concorrentes não duplicam — sem advisory lock

O sweeper legado (#292) usa um advisory lock GLOBAL, e ali faz sentido: aquele
sweep promove rows por predicado de idade, e duas promoções concorrentes da
mesma row seriam dois efeitos. Aqui a garantia é mais forte e mais barata:

- toda MUTAÇÃO é `UPDATE ... WHERE status = <origem esperada>` (CAS). Duas
  réplicas que decidam o mesmo produzem UM vencedor e um `UPDATE` que volta zero
  linhas — no lock de row do PostgreSQL, não em disciplina de código;
- o REARME é idempotente pelo `jobId` determinístico;
- a ENTREGA é protegida pelo claim atômico de #632, que já é a camada que
  sobrevive a jobs duplicados de qualquer origem.

Um lock global não acrescentaria segurança e custaria disponibilidade: enquanto
uma réplica varre, as outras não fariam nada — e a recuperação é justamente o
que precisa continuar funcionando quando uma réplica está doente.

##### A decisão da reconciliação, e o que ela NÃO consegue expressar

`reconciliationDisposition` (`src/runtime/outbound/recovery-contract.ts`) é pura
e tem quatro saídas: `await_grace`, `resend_idempotent`, `escalate_manual`,
`dead_letter`. **Não existe `resend_blind`** — não é omissão nem TODO: o tipo
não consegue expressá-lo, então nenhum call site consegue pedi-lo.

A ordem das perguntas é a garantia:

1. **prazo total / teto de tentativas primeiro** — uma linha que estourou o
   orçamento não ganha mais uma chance por ser de tipo idempotente; reordenar
   produziria um laço infinito de reenvios "seguros";
2. **carência depois** — nem escalada acontece antes dela, para não encher a
   fila humana com linhas que o worker vivo ainda vai fechar;
3. **a política de reenvio por último, e DELEGADA** a `autoResendAllowed` (#632).
   Reimplementar a condição aqui — mesmo "para deixar explícito" — criaria duas
   cópias que divergem no dia em que um canal novo entrar, e a divergência nesse
   ponto é a mensagem duplicada no telefone do usuário.

##### O rearmamento manual é a falha #12 da épica, virada tipo

`rearmOutboundByOperator` (`src/ops/outbound-rearm.ts`) recusa quando o estado é
INCERTO **e** o provedor não deduplica aquele `payload_type`, a menos que o
operador reconheça o risco EXPLICITAMENTE (`acknowledge_duplicate_risk === true`
— `undefined` é recusa). O reconhecimento vai para a auditoria
`outbound_manual_rearm` junto com `actor`, `reason` e `from_status`.

`failed_terminal` **não** é rearmável: recusa definitiva do provedor, e rearmar
é pedir a mesma recusa num laço.

##### O heartbeat, e o que ele protege

`withDeliveryHeartbeat` (`src/runtime/outbound/delivery.ts`) renova a lease a
cada terço do TTL enquanto a chamada ao provedor está em voo. Sem ele, uma
chamada mais longa que `TURN_LEASE_TTL_MS` perdia a posse **com o desfecho já
conhecido**: o fence impedia o duplo envio, mas a tentativa viva era descartada
e a linha ficava incerta quando alguém sabia a resposta. Uma renovação recusada
NÃO aborta a chamada — o efeito externo já pode ter ocorrido, e abortar só
trocaria um desfecho conhecido por um `aborted`.

##### O índice da varredura, e o que o EXPLAIN mostrou

Migração 131: `idx_outbound_messages_expired_claims (lease_expires_at,
tenant_id, agent_id) WHERE status IN ('claimed','sending')`. `lease_expires_at`
na FRENTE porque o dispatcher cross-tenant não tem igualdade em `tenant_id` para
ancorar a sondagem — mesmo diagnóstico da 114 para `agent_turns`.

**MEDIDO:** sem esse índice o planejador NÃO cai em Seq Scan; cai em
`idx_outbound_messages_tenant_agent_status_created` (067) com `lease_expires_at`
como filtro, exatamente como #632 previu. O ganho é SELETIVIDADE — a 067 indexa
toda row, inclusive as terminais que são a maioria sob retenção, então o custo
cresce com o HISTÓRICO; o parcial cresce com o trabalho EM VOO. A sonda de
EXPLAIN exige o índice NOMEADO por isso: só "sem Seq Scan" ficaria verde sem ele.

##### O sweeper LEGADO deixou de tocar a linha durável

`outbound_messages_sweeper` (#292) promovia a `unknown` toda row `pending` mais
velha que `OUTBOUND_SWEEPER_STALE_PENDING_SEC`. Depois da #630 a mesma tabela
hospeda o outbox durável, cuja row NASCE em `pending` esperando o worker — e
`unknown` é TERMINAL para o claim (`DELIVERY_TERMINAL_STATUSES`). O housekeeping
do ledger antigo estava a caminho de virar uma máquina de perder respostas do
ledger novo, em silêncio. Todas as consultas daquele worker agora filtram
`turn_id IS NULL`.

#### Limitações declaradas de #633

- **`delivered` sem histórico não é reparado automaticamente.** A varredura
  detecta, loga com `ops_alert` e para. Fabricar o histórico exigiria
  re-renderizar o texto do payload num segundo lugar (a lógica de
  `buildHistorico` já existe em `delivery.ts`), e reconstrução de conteúdo é
  #635.
- **Não há retenção para a linha DURÁVEL.** O sweeper legado agora a ignora, e
  a retenção do outbox durável (#506 §Retenção) não tem dono. A tabela cresce.
- ~~**`storage_object` continua irresolúvel**~~ — resolvido em #634.
- **Os limites de política são constantes, não env vars** —
  `OUTBOUND_MAX_DELIVERY_ATTEMPTS`, `RECONCILIATION_GRACE_MS`,
  `RECONCILIATION_DEADLINE_MS`. Uma env var aqui seria a alavanca com que
  alguém, no meio de um incidente, silencia o alarme subindo o teto.
- **Nada enfileira no caminho QUENTE.** O commit de #631 continua sem
  `enqueueOutboundDelivery`; quem arma é a varredura (até 1 min de latência) ou o
  operador. #634 **não** fechou esta: o texto da issue não a pede, e ligar o
  enqueue ao commit reabriria o `await` entre o commit e o `send*` que #631
  fechou deliberadamente. Continua sem dono nomeado.

#### A flag, e por que ela não pode ser desligada em produção

`FEATURE_OUTBOUND_DURABLE_COMMIT` (default ON) é a alavanca de rollback. Uma
garantia de durabilidade que possa ser desligada em produção **não é** um kill
switch — é o caminho fail-open com outro nome. Por isso duas regras cross-field
(`src/config/rules.ts`):

| Regra | Efeito |
|---|---|
| `outbound-commit/production-required` | `false` no profile `production` ⇒ **erro de BOOT**. Escopo `boot` de propósito: a regra vale também sob `MAIA_CONFIG_STRICT_BOOT=false`, senão a alavanca de emergência do contrato viraria a alavanca para desligar a durabilidade. Em staging avisa; em development é silencioso |
| `outbound-commit/requires-state-machine` | `true` com `FEATURE_TURN_STATE_MACHINE=false` é INERTE (sem `turn_id` a FK composta da 121 torna a row inexprimível) ⇒ erro de contrato |
| `outbound-recovery/requires-delivery-worker` | (#633) `FEATURE_OUTBOUND_RECOVERY=true` com `FEATURE_OUTBOUND_DELIVERY_WORKER=false` enfileira jobs que ninguém consome ⇒ erro de contrato. **O consumidor precede o produtor** |
| `outbound-recovery/requires-durable-commit` | (#633) `FEATURE_OUTBOUND_DELIVERY_WORKER=true` com `FEATURE_OUTBOUND_DURABLE_COMMIT=false` é INERTE (sem #631 não há linha a entregar) ⇒ erro de contrato |

As duas flags de #633 nascem **OFF** e nenhuma é `boot`-required: desligá-las
NÃO restaura fail-open (o caminho síncrono de #631/#632 continua entregando com
posse e fence). O que se perde é a RECUPERAÇÃO automática.

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

#### Onde a mídia de saída mora, e a trava do envio direto (#634)

**O store.** `src/runtime/outbound/media-store.ts`. A mídia de saída vive em
`<MEDIA_ROOT>/outbound/<tenant_id>/<agent_id>/<pessoa_id>/<sha256>.<ext>` e o
artefato persiste `{kind:'storage_object', bucket:'maia-outbound-media',
object_key}` — sem caminho, sem URL, sem credencial.

Por que `MEDIA_ROOT` e não um bucket novo: o projeto não tem object storage, e
`MEDIA_ROOT` já é o volume que a plataforma declara como o lugar durável da
mídia (`media.blobs`, `backup_behavior: excluded_volume`, volume próprio no
`docker-compose.yml`). Trocar o backend por S3 é trocar esse módulo, e só ele.

Por que isso **não** é `local_path` com outro nome — a diferença é o dono do
ciclo de vida:

| | quem apaga | o que a 2ª tentativa encontra |
|---|---|---|
| `local_path` (#631) | o `finally` do próprio envio | ENOENT, com certeza |
| `storage_object` (#634) | o GC, só após entrega CONFIRMADA | os mesmos bytes |

Cada segmento da chave tem função verificável: `tenant_id`/`agent_id` são
comparados com o escopo ALS no resolvedor (é essa comparação, e não a contenção
de `media-guard`, que carrega o isolamento — todos os objetos moram sob a mesma
raiz); `pessoa_id` é o que torna o apagamento por titular expressável; `sha256`
torna a escrita idempotente.

**GC.** O objeto é descartado quando a entrega é **confirmada**. Desfecho
incerto, recusa transitória ou terminal **preserva** o objeto: a reconciliação
de #633 e o rearmamento de `src/ops/outbound-rearm.ts` precisam dos bytes, e
apagá-los transformaria uma entrega recuperável num `media_ref_unresolved`
permanente. O que sobra é responsabilidade do ciclo de retenção.

**Retenção/LGPD.** Classe própria `media.outbound_artifacts`
(`src/ops/retention/data-classes.ts`), `sensitive_personal`, escopo
`tenant_agent`, `purge_mechanism: delete`. Ela **não** está em
`UNSUPPORTED_CLASSES`: o adapter de privacidade (`src/ops/privacy/adapters.ts`)
implementa a purga por titular removendo o diretório do `pessoa_id`. Mecanismo
**ligado**; política (o prazo) continua `pending_dpo` como as demais treze —
`resolveRetention` devolve `purgeable:false` para todas.

Isso é o contrário de `media.blobs` (mídia de ENTRADA), que continua com
`mechanism_not_implemented` porque o layout dela (`<tenant>/<mês>/<sha>`) não
tem ligação com o titular. As classes ficaram separadas exatamente por isso.

**A trava de envio direto.** Duas camadas, e cada uma pega o que a outra não
pega:

1. **Runtime** — `src/runtime/outbound/egress-guard.ts`. Um ALS carrega a
   autorização de egresso; `src/gateway/line-output.ts` envolve as CINCO
   primitivas de mensagem com `assertEgressAuthorized`. Fora de escopo: emite
   `maia_outbound_direct_send_violation_total{kind}` e **lança**. Sem flag — uma
   trava cujo default fosse "só contar" é o fail-open que #506 lista como risco.
   `startTyping`/`markRead` ficam de fora: são presença, não saída lógica.
2. **Estático** — `tests/unit/runtime/outbound-trava-envio-direto.spec.ts` varre
   `src/` (removendo comentários antes de casar) e reprova um `LineOutput.send*`
   num módulo ausente do inventário, ou um módulo cujo inventário não declare a
   primitiva que ele chama.

**O inventário.** `src/runtime/outbound/send-paths.ts`, em código e não em
markdown, para que o teste possa lê-lo. Três estados: `outbox`,
`declared_exception` (com `reason` **e** `containment` obrigatórios) e
`infrastructure`. Estado hoje:

| Estado | Caminhos |
|---|---|
| `outbox` | `agent/output-dispatch.ts` (texto, `status_fallback`, documento, voz, enquete), `runtime/outbound/delivery.ts` |
| `declared_exception` | `agent/message-update.ts`, `agent/react-loop.ts` (reação), `identity/quarantine.ts`, `scheduling/outbox-drain.ts`, `tools/_dispatcher.ts`, `workers/briefings.ts`, `workers/idempotency-outbox-relayer.ts`, `workers/pending-reminder.ts`, `workflows/dual-approval.ts`, `workflows/engine.ts` |
| `infrastructure` | `gateway/line-output.ts`, `gateway/line-sessions.ts`, `runtime/outbound/provider-adapter.ts` |

A issue pede o inventário de exceções "idealmente vazio"; ele não está, e o
denominador comum das dez é literal: **nenhuma tem `turn_id`**. O outbox exige
`turn_id NOT NULL` (migração 121) e o commit faz fence do `claim_token` do
turno — não há turno a cercar num briefing das 7h nem numa expiração de
workflow. Duas delas (`scheduling.outbox_drain`, `workers.idempotency_relayer`)
já são outboxes duráveis próprios; migrá-las é fundir dois ledgers, trabalho que
a issue-mãe não pede.

**Fallback e timeout.** `sendOutbound` já aceitava `fallback_reason` desde #631,
mas nenhum call site o passava — todo fallback nascia como `payload_type:'text'`
e era indistinguível de conteúdo do agente. #634 ligou os quatro call sites reais
de `src/agent/core.ts`: rate limit (`policy_refusal`), bloqueio do Decision
Engine (`policy_refusal`), escalada para aprovação (`policy_refusal`) e
fail-closed do Decision Engine (`internal_error`). Não há caminho de TIMEOUT
visível ao usuário hoje — ele é de #507, e o `reason` `timeout` já existe no
contrato esperando por ele.

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
| `schema-boot-gate.ts` | **The BOOT decision** over that verdict (#516, ADR 0004): blocker kind ⇒ exit code (90-98), precedence between simultaneous blockers, and the actionable death message. PURE — no I/O; `src/index.ts` is the only caller and the only place that calls `process.exit()`. Replaced `schema-version.ts`, the pre-#516 comparison, which was deleted |
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
| `tests/unit/runtime/stream-head-of-line-contract.spec.ts` | #626: compila a regra FIFO com `PgDialect` (sem banco) e amarra os quatro textos que precisam concordar — o predicado da migration 126, os terminais do contrato, o vocabulário dos cinco códigos e a ESTRUTURA ("uma única função"): conta as chamadas de `streamHeadOfLineNotExists` no repositório e proíbe uma segunda cópia escrita à mão |
| `tests/integration/turn-head-of-line-real-db.spec.ts` | #626 com Postgres real: só o menor `first_ingress_seq` avança (M1/M2/M3 tentados em ordem INVERTIDA — um teste que tentasse M1 primeiro passaria com a regra removida), `retryable` não é ultrapassado, terminal não bloqueia, `outbound_pending` anterior devolve `stream_blocked`, 12 conversas em pontos DIFERENTES do próprio contador seguem em paralelo (fica vermelho sob serialização global), o recovery devolve só heads pela mesma função, e `maia_stream_fifo_violation_total` publicada em zero continua zero sob rajada legítima |
| `tests/unit/runtime/poison-policy-contract.spec.ts` | #629: a classificação é TOTAL e o `outcome` domina o código; a leitura da config falha FECHADA numa categoria desconhecida; o contrato de env e o vocabulário do módulo puro listam as MESMAS categorias (`src/config/contract.ts` não pode importar o módulo — regra de pureza —, então a lista está escrita duas vezes por necessidade e é aqui que as duas cópias são amarradas); o predicado casa TEXTUALMENTE com o índice parcial da 133; e o repositório tem exatamente QUATRO chamadas de `streamNotPoisoned` e nenhuma cópia escrita à mão |
| `tests/unit/observability/stream-fairness-metrics.spec.ts` | #629: `starvation_total` conta EPISÓDIOS (a mesma conversa faminta não recontada por scrape; uma que sai e volta conta de novo); uma falha da fonte devolve o ÚLTIMO valor conhecido e não zero (um head age que despenca durante uma indisponibilidade do banco é a leitura mais enganosa possível); NENHUMA série de stream carrega label de alta cardinalidade; e o coletor é fiado a partir de `registerRuntimeObservability` |
| `tests/integration/turn-poison-dlq-real-db.spec.ts` | #629 com Postgres real: os DOIS modos da política pela porta real (`unsafe_to_retry` bloqueia, `reasoner_failed` libera — sem mexer em `process.env`, porque `config` é singleton e o classificador de produção ficaria de fora); ATOMICIDADE com a falha caindo ENTRE as duas escritas (gatilho no `INSERT` do bloqueio: o turno NÃO pode ficar `dead_letter` com a conversa livre); idempotência do bloqueio; o varredor não churna numa conversa interditada; desbloqueio audita, re-arma o head e deixa o morto morto; ISOLAMENTO com a colisão FORÇADA nos dois eixos (mesma `stream_key` literal em dois tenants E dois agents do mesmo tenant); replay recusado por ordem comprometida e atravessado com `--reconcile`; e retry antigo com backoff em aberto bloqueando o turno novo |
| `tests/integration/turn-stream-fairness-real-db.spec.ts` | #629 com Postgres real: uma SIMULAÇÃO do pool de workers (4 vagas puxando da mesma fila, entrando por `beginTurnExecution` e concluindo por `concludeTurn`, com a promoção devolvendo o job do sucessor). Prova que uma conversa lenta com o head segurado não impede as outras 30 de terminarem INTEIRAS; que uma conversa quente de 25 turnos nunca ocupa mais de UMA vaga e as pequenas saem com mediana de posição 11 de 45; que `maia_stream_turn_wait_seconds` recebe uma amostra por turno atendido com os baldes de SEGUNDOS; e que `starvation_total` não reconta por scrape |
| `tests/integration/outbound-durable-outbox-schema-real-db.spec.ts` | #630 com Postgres real: row legada continua inserível, uniques PARCIAIS recusam a segunda saída e ignoram o legado, CHECK de completude impede meia-row, FK composta impede apontar para turno de outro tenant |
| `tests/integration/outbound-commit-transacional-real-db.spec.ts` | #631 com Postgres real, entrando por `dispatchOutput`/`sendOutbound` (o call site de produção, não um harness): o double do canal **consulta o banco por conexão própria no instante do envio**, de modo que "nada vai ao canal antes do banco" vira afirmação verificável. Cobre também worker sem posse, CAS de versão, rollback total quando a falha acontece ENTRE as duas escritas, idempotência da saída lógica (uma linha **e** um envio), `delivery_unknown` em vez de `delivered` fingido, e a linha selecionável pelo recovery no instante seguinte ao commit |
| `tests/unit/config/outbound-durable-commit-rule.spec.ts` | #631: a flag não pode ser fail-open — default ON, `false` em production é erro de escopo `boot` (sobrevive a `MAIA_CONFIG_STRICT_BOOT=false`), aviso em staging, silêncio em development, e inerte sem a máquina de estados é erro |
| `tests/unit/runtime/outbound-delivery-contract.spec.ts` | #632: o contrato PURO da entrega — elegibilidade do claim alinhada ao índice de #630, nenhum estado terminal reivindicável, a matriz TOTAL (7 desfechos × 6 tipos) da política de reenvio, a capability declarada para todo `payload_type` (nenhum default otimista), e o jobId determinístico por `outbound_id` (colisão do multipart, namespace disjunto do turno, fail-loud em id malformado, payload `.strict()`) |
| `tests/integration/outbound-delivery-claim-lease-fence-real-db.spec.ts` | #632 com Postgres real, entrando por `deliverOutbound`: claim concorrente com **2, 10 e 50** workers (exatamente um vence, `attempt` prova UM update); takeover por lease com o token velho recusado nas TRÊS gravações (confirmar, reenviar, renovar); **crash depois de o provider aceitar não vira reenvio** (o fake conta 1 chamada e a linha termina `delivery_unknown`); `delivered` não é marcado por chamada iniciada; caminho feliz até `completed` com histórico único e a chave idempotente entregue ao adaptador |
| `tests/unit/runtime/outbound-recovery-contract.spec.ts` | #633: o contrato PURO da recuperação — a matriz TOTAL (tipos × desfechos incertos) provando que nenhum tipo sem chave nativa alcança `resend_idempotent`, a concordância obrigatória com `autoResendAllowed` (a política tem um dono só), a ordem das perguntas (teto vence idempotência; prazo vence carência), e a confirmação de risco FAIL-CLOSED (`undefined` e `false` são recusa) |
| `tests/integration/outbound-recovery-reconciliation-real-db.spec.ts` | #633 com Postgres real, sob tenant PRÓPRIO (as contagens são invariantes absolutas, não deltas), entrando por `runOutboundRecoveryForScope` e `rearmOutboundByOperator`: reenvio cego impossível, capability discriminando `text` × `audio` no MESMO tick, takeover com o fence antigo recusado, 10 varreduras concorrentes produzindo UMA promoção e UMA auditoria, DLQ por teto e por prazo, rearmamento manual recusado sem confirmação e auditado com ela, divergência turno↔outbound nos dois sentidos, e a janela `delivered -> completed` |
| `tests/integration/outbound-delivery-job-real-redis.spec.ts` | #633 com Redis/BullMQ e Postgres reais: dois `add` do mesmo `outbound_id` colidem num job só; o consumidor de PRODUÇÃO concede UMA posse (`attempt = 1`) mesmo com o job entregue duas vezes; um job RETIDO em `completed` não veta o rearme legítimo; payload malformado não derruba o worker |
| `tests/integration/outbound-legacy-sweeper-ignora-outbox-duravel-real-db.spec.ts` | #633: o sweeper LEGADO (#292) não toca a linha do outbox durável, nas TRÊS consultas (promoção, retenção, dispatcher). Cada caso carrega um CONTROLE legado que **tem** de ser tocado no mesmo passe — sem ele, o teste ficaria verde com o sweeper desligado ou com o advisory lock global tomado. É integração e não unidade de propósito: `tests/unit/workers/outbound-messages-sweeper.spec.ts` reimplementa o `WHERE` em JS e por isso fica VERDE com o predicado removido da produção — armadilha do espelho, medida |
| `tests/integration/outbound-recovery-explain-real-db.spec.ts` | #633: o PLANO das quatro varreduras sob ~20k rows, explicando o SQL de PRODUÇÃO (as mesmas funções que o repositório executa). Exige o índice NOMEADO e RECUSA o de fallback — porque, medido, a ausência do índice da 131 não produz Seq Scan, produz a 067 com `lease_expires_at` como filtro |
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
