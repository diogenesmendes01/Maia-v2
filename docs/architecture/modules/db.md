# db

**Path:** `src/db/`

**Purpose** — Drizzle ORM schema, repositories, query helpers, and the tenant-isolation primitives (`tenant-context.ts`, `tenant-guard.ts`). The schema defines every table; repositories provide the typed query interface; the tenant-context + guard pair enforces `tenant_id + agent_id` scoping on every query. SQL migrations live in `migrations/` at the repo root, not under `src/db/`.

> **The migration runner is a separate module.** Since issue #516 the discovery, checksums, advisory lock, ledger and schema-readiness logic live in [`src/migrations/`](migrations.md) — `scripts/migrate.ts` is only a CLI over it. Anything that needs to know whether the schema is compatible calls `getSchemaReadiness()` from that module; it must never re-derive the answer by querying `schema_migrations` directly.

## Key files

| File | Role |
|---|---|
| `src/db/schema.ts` | Drizzle schema for all tables |
| `src/db/repositories.ts` | Aggregated repository functions (transactions, audit, conversations, etc.) |
| `src/db/repositories/turn-repos.ts` | `agentTurnsRepo` — única porta de escrita da máquina de estados do turno inbound (issues #503/#504, migrations 096/097/114). Toda transição é compare-and-swap sobre `state_version`; transição terminal escreve, na MESMA transação, a projeção de compatibilidade `mensagens.processada_em`. `claimNextEligibleTurn` (`tryClaimTurn` até #625) é o claim ATÔMICO (um `UPDATE ... WHERE ... RETURNING`, relógio do PostgreSQL) e `expected_claim_token` é o FENCE de toda gravação da tentativa — zero linhas com fence declarado vira `stale_claim`, distinto de `state_mismatch`. Vocabulário em [`src/runtime/turns/contract.ts`](runtime.md) e [`claim.ts`](runtime.md). Desde #505 (migrations 120/122) também aloca a `ingress_seq` — `INSERT … ON CONFLICT DO UPDATE … RETURNING` sobre `agent_stream_sequences`, DENTRO da transação do INSERT da mensagem, de modo que uma reentrega que colide na dedup reverte o número em vez de queimá-lo. Desde #625 (fatia B da #505, migration 124) ele é uma TRANSAÇÃO de dois passos, e a ordem é o contrato: primeiro recupera os claims EXPIRADOS da mesma stream (`claimed`/`running` com lease vencida ⇒ `retryable`, preservando `claim_token`/`claimed_by` para a forense e sem gastar tentativa), depois reivindica. Quem DECIDE a exclusão é o índice único parcial `agent_turns_stream_active_uq` — um `23505` naquela constraint (e só naquela) vira o motivo tipado `stream_busy`, distinto de `not_eligible`. A recuperação tranca as linhas ativas da stream com `FOR UPDATE` numa CTE `MATERIALIZED` ordenada por `id`, inclusive o próprio alvo — ordem determinística de lock. Com o índice de pé o conjunto tem no máximo uma linha e a ordem é inócua; ela protege a janela em que o índice não existe (pré-migration, pós-rollback, índice inválido), onde duas réplicas em takeover cruzado poderiam fechar deadlock. Desde #626 (fatia C da #505, migration 126) o método chama-se `claimNextEligibleTurn` e o `WHERE` carrega a condição de HEAD-OF-LINE: não existe turno anterior não terminal na mesma stream (`first_ingress_seq` menor). A regra vive num módulo PURO (`src/db/repositories/stream-head-sql.ts`) — e tem QUATRO consumidores neste arquivo (o `WHERE` do claim, `findRecoverableTurns`, o dispatcher cross-tenant e `listNonHeadTurns`); nenhum monta predicado próprio, porque a issue proíbe a segunda cópia ("duas cópias da regra divergem, e a divergência só aparece durante um recovery"). O `RETURNING` do claim carrega o CANÁRIO (`earlierLiveTurnCount`): quantos anteriores vivos restaram DEPOIS do claim concedido — zero é a resposta única, e `> 0` vira `maia_stream_fifo_violation_total{stage="claim"}`. Desde #629 (fatia F da #505, migration 133) o `WHERE` carrega uma SEGUNDA regra de stream — `streamNotPoisoned`, o `NOT EXISTS` sobre interdições ativas em `agent_stream_blocks` — e a recusa é `stream_poisoned`, distinta de `stream_blocked`: aquela espera o outbox, esta espera um humano. O predicado é INCONDICIONAL (sem flag): uma interdição é uma decisão já tomada e auditada, e o kill switch da fatia (`TURN_POISON_BLOCK_CATEGORIES=`) impede NOVOS bloqueios de nascer em vez de desrespeitar os que existem. A transição terminal para `dead_letter` grava a interdição na MESMA transação e **antes** da eleição da promoção — a ordem é a fatia inteira: a eleição carrega o mesmo predicado, então a promoção vê o bloqueio que a própria conclusão criou e devolve `no_successor`. Inverter as duas produziria conversa bloqueada E sucessor acordado, com o único sintoma sendo um `promoted` que não corresponde a fila nenhuma. `replayDeadLetterTx` ganhou o guarda de ORDEM COMPROMETIDA (`committedOrderNotBroken`) no `WHERE` do `UPDATE` — não numa consulta anterior, porque entre um `SELECT count` e o `UPDATE` um sucessor pode concluir; o modo `reconcile` o desliga, e o caller audita a travessia. E `snapshotStreamScheduling`/`countBlockedStreams` são os agregados CROSS-TENANT de fairness lidos no scrape (só números e um token opaco `md5`, nunca `stream_key`). |
| `src/db/repositories/stream-head-sql.ts` | #626 (fatia C da #505) — a REGRA FIFO por stream, PURA (sem `db`, sem ALS): `streamHeadOfLineNotExists` (o `NOT EXISTS` sobre turnos anteriores não terminais), `earlierLiveTurnCount` (o canário de `maia_stream_fifo_violation_total`) e `earlierLiveTurnProbe` (quem está na frente, só no caminho de fracasso). Puro pela mesma razão de `turn-fence-sql.ts`: `turn-repos.ts` importa `../client.js`, que constrói o pool no import — enquanto a regra morar lá, a única prova de que ela existe é um teste de integração, e um teste de integração que não roda não prova nada. Aqui `PgDialect().sqlToQuery()` compila o SQL REAL sem banco. Os estados terminais entram como LITERAIS, não parâmetros: o PostgreSQL só usa o índice PARCIAL `agent_turns_stream_head_live_idx` quando prova que a cláusula implica o predicado, e com `$1..$4` a prova depende de plano CUSTOM — a degradação apareceria só depois da sexta execução da mesma sessão. Desde #627 também `streamSuccessorCandidate` (a eleição do sucessor, `ORDER BY first_ingress_seq LIMIT 1 FOR UPDATE`) e, desde #629, as três funções da fatia F: `streamNotPoisoned` (a conversa está interditada?), `streamPoisonProbe` (QUEM interditou — só no caminho de fracasso do claim) e `committedOrderNotBroken`/`committedOrderAfterCount` (o guarda do replay manual: existe turno POSTERIOR já terminal?). Todas moram aqui pela mesma razão estrutural — este módulo é o dono de tudo que a `stream_key` e a `first_ingress_seq` do alvo decidem, e uma segunda cópia divergiria em silêncio. `streamNotPoisoned` fica FORA de `streamHeadOfLineNotExists` de propósito: o canário de FIFO usa o núcleo do head-of-line, e misturar o bloqueio ali faria uma conversa interditada contar como violação de FIFO — uma métrica que a issue-mãe trata como critério de ABORTAR o rollout passaria a subir por uma decisão de política deliberada. |
| `src/db/repositories/stream-block-repos.ts` | #629 (fatia F da #505, migration 133) — `streamBlocksRepo`: o ciclo de vida da conversa INTERDITADA. `listActiveCrossTenant` (a pergunta do plantão, que não tem tenant, com o `backlog` de cada interdição — o número que decide prioridade), `findActiveByTurn` e `unblockTx`. O desbloqueio é um CAS (`unblocked_at IS NULL` no `WHERE`): dois operadores simultâneos produzem UM desbloqueio, e um `UPDATE` cego sobrescreveria o `unblocked_by` de um desbloqueio ANTIGO — apagando exatamente o campo pelo qual o histórico existe. `unblockTx` devolve o HEAD a re-armar na mesma leitura, pela razão de `promoteStreamSuccessor`: buscá-lo depois abriria a janela em que a fila muda entre as duas consultas. Arquivo separado de `turn-repos.ts` porque quem BLOQUEIA é a transação do CAS terminal e quem DESBLOQUEIA é uma operação de operador sem transação compartilhada com nada. |
| `src/db/repositories/conversation-repos.ts` | `mensagensRepo.createInbound` é a porta ÚNICA do ingresso e, desde #505, a fronteira FAIL-CLOSED da identidade de stream: dedup ⇒ `requireStreamIdentity` (lança quando a stream não é derivável — a recusa acontece ANTES de qualquer escrita) ⇒ alocação transacional da sequência. As três colunas de stream saem do tipo de INPUT de propósito: um caller capaz de passar `stream_key` seria um caller capaz de escolher a fila de outra conversa. A guarda é PURA e a flag é lida por `contractEnv` porque este arquivo é compartilhado com o console e não pode alcançar `src/config/env.ts` (#596) — quem MEDE e AUDITA a recusa é o gateway. |
| `src/db/repositories/runtime-trace-repos.ts` | `runtimeTraceRepo` — leitura tenant-scoped do Trace Explorer sobre `runtime_trace_envelopes`/`_bodies`. `listAttempts()` agrupa as tentativas de um turno e exige os TRÊS: `tenantId`, `rootTraceId` e o `turnoId` **assinado** (issue #535). Sem o `turnoId` ele falha fechado (`TraceAttemptScopeError`) em vez de agrupar só por `root_trace_id` — que é editável sem detecção numa linha v1 e permitiria enxertar a tentativa de um turno na cadeia de outro. Irmão cuja própria assinatura verifica como `invalid` é descartado e devolvido em `refused`, que o router audita. Ver [`concerns/governance-observability.md` §4.4a/§4.4b](../concerns/governance-observability.md). |
| `src/db/repositories/outbound-outbox-repo.ts` | `outboundOutboxRepo` — a TRANSAÇÃO ÚNICA do commit da resposta (#631, fatia B da #506). `commitTurnOutboundTx` faz, na MESMA conexão: transição `running \| outbound_pending -> outbound_pending` com fence de `claim_token` + CAS de `state_version`, INSERT do artefato com `logical_dedupe_key` (`ON CONFLICT DO NOTHING` ⇒ retry da mesma saída lógica devolve a linha existente), o ponteiro `agent_turns.outbound_message_id` por `coalesce`, e a auditoria `outbound_committed` por `auditTx` (que **não** engole erro). Qualquer falha ⇒ ROLLBACK + `OutboundCommitError`, e o chamador NÃO pode enviar. **Não usa `agentTurnsRepo.markOutboundCommittedTx`** porque `runTransition` abre a própria transação: duas conexões seriam dois commits, e a janela de crash é justamente o que a fatia fecha. O `WHERE` do fence vem de `turn-fence-sql.ts`, a mesma fonte única. |
| `src/db/repositories/turn-fence-sql.ts` | `turnWriteConditions()` — fonte ÚNICA do `WHERE` de qualquer gravação de turno (escopo, CAS de estado, CAS de versão, fence de posse). Módulo PURO: um teste unitário compila o SQL real sem banco. Consumido por `runTransition` **e** por `outbound-outbox-repo.ts` |
| `src/db/repositories/holidays-repo.ts` | Holiday repository |
| `src/db/repositories/holiday-entidades-repo.ts` | Per-entity holiday repository |
| `src/db/client.ts` | Postgres connection pool (`max: 10`, process-wide) + Drizzle init |
| `src/db/repositories/finance-repos.ts` | `entidadesRepo`, `contasRepo`, `entityStatesRepo`, … — includes `byIdsWithState`, the entity ⋈ state LEFT JOIN the turn-context loader reads |
| `src/db/tenant-context.ts` | `runWithTenantContext`, `tryGetCurrentContext`, `getCurrentContext`, `MissingTenantContextError` |
| `src/db/tenant-guard.ts` | `applyTenantGuard()` — query-builder helper that injects scoping predicates |
| `src/db/capability-risk.ts` | Capability risk scoring helper |

## The pool is shared, and one caller must not take all of it

`pool` in `src/db/client.ts` opens `max: 10` connections **for the whole
process** — every tenant, every turn, every worker. A repository that fans out,
or a caller that issues its whole read set in one tick, does not just make
itself faster: it converts the pool into a queue for everybody else. Two numbers
therefore need reviewing together whenever either moves:

| Where | Number | Meaning |
|---|---|---|
| `src/db/client.ts:8` | `max: 10` | total connections in the process |
| `src/agent/turn-context/types.ts` | `TURN_CONTEXT_MAX_CONCURRENT_READS = 6` | most one agent turn may hold at once |

The agent turn is the hot path that hits this, so the ceiling lives with it and
is enforced by a shared FIFO semaphore in `src/agent/turn-context/concurrency.ts`
(background and rationale: [`agent`](agent.md#concurrency-ceiling)). A new
batched read on this path is a change to that budget, not just to a repository.

## Batched reads: bound the side that was bounded before

A `LIMIT` on a joined read is a contract, not a safety net, and folding two
reads into one JOIN does **not** let you fold their bounds. `entidadesRepo.byIdsWithState`
learned this the hard way (issue #525, PR #541 review): it replaced
`entidadesRepo.byIds` (never limited) plus `entityStatesRepo.byIds(ids, 500)`
(limited) with a single LEFT JOIN carrying one `LIMIT 500` over the merged rows.
Entities past row 500 disappeared entirely, and the prompt rendered their UUIDs
where names belong.

Two rules follow, and both are asserted in
`tests/integration/turn-context-scope-cardinality.spec.ts`:

1. **Each side of a JOIN keeps the cardinality it had.** `byIdsWithState` now
   returns every entity (bounded only by `ids.length`, which the caller
   controls) and caps only the state projection; a capped row comes back as
   `state: null`, indistinguishable from an entity that has no state row — the
   shape callers already handle.
2. **A truncation that reaches a non-truncatable surface is a bug, not a
   budget.** The scope/permissions block has no `SECTION_BUDGETS` entry on
   purpose. Silently dropping rows that feed it is a governance failure wearing
   a performance costume.

Tenant predicates survive both rules: on a LEFT JOIN the `(tenant_id, agent_id)`
predicate for the joined table belongs in the **JOIN condition**, never the
`WHERE`. `entity_states`'s PK is `entidade_id` alone, so a foreign state row
exists for an owned id; in the `WHERE` it would drop the whole row and turn a
foreign STATE into a missing ENTITY, which is the same name-loss bug by another
route.

## Patterns it follows

- [Tenant isolation](../concerns/tenant-isolation.md) — `runWithTenantContext` + `applyTenantGuard` are the canonical scoping mechanism
- Migrations are append-only: new `<n>_<name>.sql` files in `migrations/`; never edit a merged file. Since #516 this is enforced, not just documented — the runner records a checksum per applied migration and blocks (`up`, `status` and readiness all fail) when a merged file's content changes. See [`migrations`](migrations.md).

## Acrescentar constraint a tabela que já tem dado (issue #630)

Um `CREATE UNIQUE INDEX` sobre coluna **já populada** aborta a migração
inteira se houver uma duplicata — e o operador descobre isso em produção, no
meio da janela. `outbound_messages` é o caso canônico e a migração 121 é o
padrão a copiar:

1. **A coluna nova nasce NULL em toda row existente.** `ALTER TABLE … ADD
   COLUMN` sem `DEFAULT` garante isso.
2. **O unique é PARCIAL** (`WHERE <coluna> IS NOT NULL`). Row legada não
   satisfaz o predicado, não entra no índice, não pode colidir: o conjunto
   indexado no apply é **vazio**. Isso troca "pode explodir com dado que não
   dá para inspecionar" por "não existe entrada possível para explodir".
3. **Nada de backfill na mesma migração.** Promover row legada em massa é
   decisão de dado, não de schema, e exige classificar por nível de confiança.
4. **Pré-checagem com `RAISE EXCEPTION` legível**, para o caso de a migração
   rodar depois de um backfill de outra branch: a mensagem conta as duplicatas
   e diz o que reconciliar, em vez de "duplicate key value violates…".
5. **Row nova completa por CHECK, não por nulabilidade de coluna.** A coluna
   fica nullable para conviver com o legado; um CHECK
   `CASE WHEN <discriminante> IS NULL THEN true ELSE (… IS NOT NULL AND …) END`
   exige o tuplo inteiro na row nova. Nunca escreva esse CHECK com `IN` —
   ver a armadilha ternária abaixo.

**Armadilha ternária (bug real, pego pelo CI na PR #532):** um CHECK do
Postgres só **reprova** quando o predicado dá `FALSE`. Se der `NULL`, a row é
**aceita**. `col IN (...)` com `col` NULL dá NULL. Escreva
`col IS NULL OR col IN (...)`, ou `CASE` com `IS NULL`/`IS NOT NULL` — formas
que nunca produzem NULL.

**O `_down` precisa de envelope `BEGIN;`/`COMMIT;`.** Os `_down.sql` não são
executados pelo runner forward; são aplicados à mão com
`psql -v ON_ERROR_STOP=1 -f`, que faz **autocommit por statement**. Um `_down`
sem envelope que falha no meio é fail-open: metade do rollback fica aplicada e
ninguém sabe qual metade. (Exceção: arquivo `-- maia:no-transaction`, que não
pode ter envelope — os dois regimes não convivem no mesmo arquivo.)

## How to extend

| Need | Where |
|---|---|
| Add a table | (1) New migration in `migrations/` with `_up` and `_down`; (2) Schema definition in `schema.ts`; (3) Repository functions in `repositories.ts` or new `repositories/<name>-repo.ts`; (4) All queries through `applyTenantGuard()` or explicit `tenant_id + agent_id` predicates |
| Add a column | Migration first; then schema; then repo functions; then call sites |
| Add a complex query | Prefer a repo function over inline queries at call sites — keeps tenant scoping centralized |
| Override Drizzle defaults | Extend in `client.ts`; never per-call |

## Public surface

| Consumed by | What |
|---|---|
| All `src/*/` modules | Import schema types and repo functions |
| `src/governance/audit.ts` | Uses `auditRepo` + `runWithTenantContext` |
| `src/admin-ui/` | Reads schema directly (shared Drizzle types) |

The repositories are the only sanctioned interface. Raw `client.query()` is reserved for migrations and admin scripts.

## Tests

| Test path | What it covers |
|---|---|
| `tests/integration/leak.spec.ts` | Cross-tenant leak protection |
| `tests/integration/repos-leak.spec.ts` | Repository-level leak |
| `tests/unit/db/` | Schema + repo unit tests |
| `tests/integration/db/` | Live Postgres repo tests |
| `tests/integration/turn-context-batch-repos.spec.ts` | Batched reads: isolation on both JOIN sides, constant query cost |
| `tests/integration/turn-context-scope-cardinality.spec.ts` | `byIdsWithState` past 500 entities: entity side uncapped, state side capped |
| `tests/integration/turn-context-pool-fairness.spec.ts` | One caller's share of the shared pool, measured under real contention |

## In-flight changes

At last verification (2026-05-28):

- `'default'` literal rejection in tenant-context whitespace validation (#283 → #293 — open)
- DefaultResolver fixture-only + reject `'default'` in ALS (#282 → #296 — open)

Verify: `gh pr list --state open --search "tenant-context OR tenant-guard OR drizzle"`.

---

| | |
|---|---|
| Last verified | 2026-05-28 |
| Against `main` HEAD | `c49c3855` |
