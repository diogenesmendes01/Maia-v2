# Runbook — máquina de estados durável do turno (issues #503 e #504)

Cobre: rollout, backfill, turno preso, divergência com o campo legado, replay de
dead letter, posse do turno (claim/lease/fencing) e rollback.

Fonte de verdade do vocabulário: [`src/runtime/turns/contract.ts`](../../src/runtime/turns/contract.ts)
e, para a posse, [`src/runtime/turns/claim.ts`](../../src/runtime/turns/claim.ts).
Única porta de escrita: [`src/db/repositories/turn-repos.ts`](../../src/db/repositories/turn-repos.ts).

## 1. Modelo em 30 segundos

Um **turno** é a execução lógica de um inbound. Ele agrega N mensagens quando o
debounce está ligado. `agent_turns` guarda o estado; `agent_turn_inputs` guarda
quais mensagens o turno consumiu (uma mensagem pertence a **no máximo um** turno).

```
received → queued → claimed → running → outbound_pending → completed
```

| Estado | Significa | Recovery rearma? |
|---|---|---|
| `received` | persistido, enqueue não confirmado | sim, se antigo |
| `queued` | wake-up armado | sim, se antigo |
| `claimed` | worker com lease | só com lease vencida (#504) |
| `running` | executando | só com lease vencida (#504) |
| `outbound_pending` | resposta comprometida no outbox | **NUNCA** |
| `retryable` | falhou antes de efeito irreversível | sim, quando `next_attempt_at` vence |
| `completed` / `ignored` / `superseded` / `dead_letter` | terminal | não |

Todo terminal carrega **outcome** (`reply_delivered`, `identity_unknown`,
`retry_exhausted`, …). Um CHECK no banco recusa terminal sem outcome e par
estado/outcome incompatível.

**`ignored` / `pending_race_lost`** (migration 115) é o outcome que um operador
vai encontrar sem contexto óbvio, então vale o parágrafo: o usuário respondeu
duas vezes a uma mesma pergunta pendente (duas mensagens, ou mensagem + reação /
voto), as duas respostas correram, uma venceu o `SELECT … FOR UPDATE` e a outra
foi descartada **sem rodar o ReAct**. É o comportamento correto: a mensagem
perdedora já significava "opção X da pergunta Y", e reinterpretá-la como comando
novo entregaria ao LLM uma entrada com outro significado. O usuário fica sem
resposta para a segunda mensagem — a primeira já foi respondida pelo turno
vencedor.

Correlação: `audit_log` tem `pending_race_lost` (a corrida perdida) para a mesma
conversa, e `metadata.stage` diz em qual das travessias do lock ela foi perdida.
**Os três valores NÃO levam ao mesmo desfecho** — só dois deles emparelham com
`pending_race_lost` no turno:

| `metadata.stage` | Onde é gravado | Desfecho do turno |
|---|---|---|
| `resolution` | `src/agent/pending-resolver.ts` — `resolveAndDispatch` recusou porque a pendência esperada já não é a ativa | **terminal**: `ignored` / `pending_race_lost` + `turn_ignored_by_policy` |
| `cancellation` | `src/agent/pending-gate.ts` — a mensagem cancelava a pendência e ela já tinha sumido | **terminal**: `ignored` / `pending_race_lost` + `turn_ignored_by_policy` |
| `topic_change` | `src/agent/pending-gate.ts` — o classificador disse que a mensagem **não** é resposta à pendência, é assunto novo | **segue para o ReAct**: o gate devolve `unresolved/topic_change` e o turno termina com o outcome normal (`completed`/`reply_delivered`, …) |

`topic_change` é deliberado, não omissão: a mensagem nunca foi resposta à
pendência, então não há reinterpretação a evitar, e o caminho **sem** race já
segue para o ReAct. Tornar a race terminal faria a mesma pergunta do usuário ser
respondida ou descartada conforme sorteio de timing. Consequência prática para
quem investiga: uma linha `pending_race_lost` com `stage = 'topic_change'` e
**nenhum** `turn_ignored_by_policy` na mesma conversa é o esperado — não procure
o turno descartado, ele não existe.

```sql
SELECT metadata->>'stage' AS stage, count(*)
  FROM audit_log
 WHERE acao = 'pending_race_lost' AND tenant_id = $1 AND agent_id = $2
 GROUP BY 1;
```

**Não** é incidente. Vira incidente se o volume subir sem tráfego correspondente
— aí o suspeito é reentrega duplicada no gateway, não o gate.

## 2. Rollout

### 2.0 Produção GREENFIELD — o caminho que a Maia usa hoje

**As três flags de turno já vêm `true` no contrato**
(`FEATURE_TURN_STATE_MACHINE`, `FEATURE_TURN_STATE_AUTHORITATIVE`,
`FEATURE_TURN_CLAIM`), e é assim que o **primeiro deploy** sobe — decisão do
dono na #504. Não há coorte, não há shadow, não há backfill: numa base sem
histórico não existe `mensagens.processada_em` divergente para comparar, e um
rollout por etapas só serviria para deixar a produção rodando, por semanas, no
caminho que **não** tem exclusão mútua.

Só isto é obrigatório:

1. `npm run db:migrate` — 096, 097 e 114. **Antes** de subir o processo: com as
   flags ligadas e as migrations ausentes, o ingresso inteiro cai.
2. Confirme `TURN_LEASE_TTL_MS` acima da duração p99 do turno
   (`maia_turn_duration_ms`). O heartbeat precisa caber 3× no TTL — o boot
   recusa fora dessa relação.
3. Suba. `.env.app.prod.example` já traz as três escritas explicitamente.
4. Observe por uma janela: `maia_turn_lease_lost_total{reason="token_mismatch"}`
   próximo de zero significa TTL bem dimensionado. Ver §6.2.

`FEATURE_TURN_JOB_V2` continua **`false`** e é o único knob que ainda exige
etapa: só ligue depois que TODAS as réplicas de consumo estiverem no build que
entende V2 (§7).

**`false` nas três é rollback emergencial, não configuração suportada.** O
código do caminho legado continua existindo — e continua testado — só para que o
rollback funcione. Ver §2.2.

### 2.1 Base COM histórico — rollout por etapas

Aplique este caminho quando existir volume anterior à máquina de estados (uma
instalação que rodou o runtime antigo). Aqui as flags precisam ser desligadas
explicitamente no `.env` antes do deploy, porque o default é ON:

1. `npm run db:migrate` — aplica 096 (índices `CONCURRENTLY` em `mensagens`) e
   097 (tabelas). A 096 **não** roda em transação; se ela falhar no meio, o
   índice fica `INVALID` — rode o `_down` da 096 e reaplique.
2. Deploy com `FEATURE_TURN_STATE_MACHINE=true` e
   `FEATURE_TURN_STATE_AUTHORITATIVE=false` **declarada**. Nesse ponto o turno é
   **shadow**: escreve, mede, não decide. Comportamento observável idêntico ao
   anterior.
3. `npm run backfill:turns` — em lotes, idempotente, resumível.
   `npm run backfill:turns -- --dry-run` mostra o volume antes.
4. Observe `maia_turn_legacy_projection_mismatch_total` por pelo menos um ciclo
   de retenção. Ver §4 para o que fazer com divergência.
5. Só então volte `FEATURE_TURN_STATE_AUTHORITATIVE` ao default (`true`). A
   partir daí o recovery elege por estado — e turnos `retryable` (timeout de
   reasoner, falha pre-send) voltam para a fila em vez de morrerem
   silenciosamente.
6. Mantenha o dual-write por, no mínimo, uma janela de rollback completa.
   `mensagens.processada_em` **não** é removido nesta fase.

### 2.2 Rollback emergencial das flags de turno

Desligue as **três juntas**:

```
FEATURE_TURN_STATE_MACHINE=false
FEATURE_TURN_STATE_AUTHORITATIVE=false
FEATURE_TURN_CLAIM=false
```

Desligar só `FEATURE_TURN_STATE_MACHINE` **é recusado no boot** (regras
`turn-state/authoritative-requires-dual-write` e
`turn-claim/requires-state-machine`): com as outras duas em ON por default, a
combinação seria inerte, e o contrato prefere reprovar a deixar o operador
acreditar que reivindicou algo. A mensagem de remediação diz isso.

O que você perde ao fazer isso, e precisa estar escrito antes de alguém decidir
sob pressão:

| Flag desligada | O que volta |
|---|---|
| `FEATURE_TURN_CLAIM` | A janela de **execução dupla**. O claim de estado de #503 não é exclusão mútua, e as gravações deixam de carregar fence. |
| `FEATURE_TURN_STATE_AUTHORITATIVE` | `mensagens.processada_em` volta a decidir; um turno `retryable` fica **invisível** para o recovery. Falha de escrita da máquina volta a ser fail-soft. |
| `FEATURE_TURN_STATE_MACHINE` | Tudo acima, e nenhum turno novo é criado. |

Nenhum turno, claim ou lease já gravado é apagado. As leases vivas simplesmente
vencem e param de ser renovadas.

## 3. Turno preso

```sql
-- distribuição por estado e idade (por tenant/agent)
SELECT tenant_id, agent_id, status,
       count(*) AS n,
       max(now() - updated_at) AS mais_antigo
FROM agent_turns
GROUP BY 1,2,3
ORDER BY 1,2,3;
```

| Sintoma | Leitura | Ação |
|---|---|---|
| Pilha de `received` antigos | enqueue falhando (Redis OOM/queda) | Ver [`redis.md`](redis.md). O sweep rearma sozinho quando o Redis voltar. |
| Pilha de `queued` antigos | worker parado ou job perdido | Checar o worker `agent`; o sweep rearma. |
| `claimed`/`running` parados | worker morreu no meio | Até #504 (lease) **não** rearme automaticamente. Investigue antes: reexecutar um turno que já chamou tool duplica efeito colateral. |
| `outbound_pending` parado | resposta comprometida, entrega travada | **Nunca** rearmar via recovery. É o delivery worker (#506) que finaliza. |
| Crescimento de `retryable` | reasoner ou envio falhando | `SELECT last_error_code, count(*) FROM agent_turns WHERE status='retryable' GROUP BY 1;` |
| `dead_letter` com `unsafe_to_retry` | a tentativa falhou DEPOIS de uma tool com efeito externo | **Não replaye às cegas.** Confira o efeito (`outbound_message_id`, trilha de tools) antes de decidir — replayar pode duplicar cobrança/envio. |

Logs estruturados: `turn.created`, `turn.transitioned`, `turn.transition_conflict`,
`turn.retry_scheduled`, `turn.dead_lettered`, `turn.legacy_projection_mismatch`.
Nenhum deles carrega texto, prompt, telefone ou JID — se você precisa do conteúdo,
ele está em `mensagens`, sob as mesmas regras de acesso de sempre.

**Gauges** (os dois sinais de "turno preso"; só estados vivos — terminais são
volume histórico, não saúde):

| Gauge | Lê como |
|---|---|
| `maia_turns_current{status}` | quantos turnos em cada estado agora |
| `maia_turn_state_age_seconds{status}` | idade do turno mais ANTIGO naquele estado |

`maia_turns_current{status="running"}` que não desce, ou
`maia_turn_state_age_seconds{status="outbound_pending"}` que cresce, **é** o
incidente. Snapshot com TTL de 15s compartilhado entre as séries: um scrape faz
uma query. Falha do banco mantém o último snapshot em vez de derrubar
`/metrics`.

Contadores: `maia_turn_transitions_total{from,to,outcome}`,
`maia_turn_state_conflicts_total{transition}`,
`maia_turn_recovery_candidates_total{reason}`,
`maia_turn_retries_total{error_code}`,
`maia_turn_legacy_projection_mismatch_total{kind}`,
`maia_turn_state_errors_total{op,error_code}`.

## 4. Divergência com `processada_em`

Duas direções, ambas contadas por `agentTurnsRepo.countLegacyProjectionMismatch()`
(o sweep de recovery a executa por par e emite auditoria
`turn_state_inconsistency_detected` quando encontra algo):

| Divergência | Significa | Ação |
|---|---|---|
| `terminal_without_projection` | turno terminal, mensagem ainda `processada_em IS NULL` | A projeção falhou. Investigue; enquanto a leitura legada for autoritativa, o recovery vai reprocessar a mensagem. |
| `projection_without_terminal` | `processada_em` preenchido, turno não-terminal | Esperado **em shadow** quando o turno virou `retryable` (o caminho legado carimbou por fora). Some ao ligar `FEATURE_TURN_STATE_AUTHORITATIVE`. Fora desse caso, é código legado escrevendo `processada_em` por um caminho não instrumentado — encontre-o antes do flip. |

Não existe correção automática: a decisão é do operador.

## 5. Replay de dead letter

`dead_letter` **não** volta sozinho. O replay é operação explícita e auditada
(`turn_replayed`), gera nova tentativa e descarta o `claim_token` anterior:

```bash
npm run dlq -- replay-turn <turn_id> --reason "<por quê>" --actor "ops:<seu-usuario>"
```

O comando faz três coisas, **nesta ordem**, e a ordem é a garantia:

1. **resolve o dono** pelo `turn_id` (`resolveTurnJobScope`). Você não informa
   tenant — deixar o operador escolher o escopo é deixar um erro de digitação
   virar escrita cross-tenant. Se a mensagem representativa pertencer a outro
   par (tenant, agent), o comando **recusa** (`scope_mismatch`) e não escreve
   nada; isso é corrupção de ponteiro e pede investigação, não rearme;
2. **transiciona `dead_letter -> queued`** por CAS auditado (`turn_replayed`),
   gerando nova tentativa e descartando o `claim_token` anterior. Um turno que
   **não** está em `dead_letter` é recusado aqui — e nada é rearmado;
3. **rearma o job** com o `jobId` determinístico, removendo antes o job retido
   pela BullMQ. Sem este passo o turno voltaria a `queued` e ficaria lá: com
   `FEATURE_TURN_STATE_AUTHORITATIVE=false` (o default hoje) nada mais o
   rearmaria.

Exit code 0 = replayado e rearmado. Qualquer recusa sai com 1 e diz o motivo.

A mesma operação, de dentro de um script Node:

```ts
import { replayTurnByOperator } from '@/ops/turn-replay.js';
await replayTurnByOperator({ turn_id, actor: 'ops:<seu-usuario>', reason: '<por quê>' });
```

Antes de replayar, confirme que o efeito colateral do turno **não** ocorreu
(cheque `outbound_message_id` e a trilha de tools). Replayar um turno que já
enviou resposta duplica a mensagem para o usuário.

## 6. Posse do turno: claim, lease e fencing (#504)

`FEATURE_TURN_CLAIM=true` liga a exclusão mútua. Antes dela, duas réplicas
podiam processar o mesmo turno; a máquina de estados registrava a execução mas
não decidia quem executa.

### 6.1 Diagnóstico de lease

```sql
-- Quem tem o quê, e há quanto tempo deu sinal de vida.
SELECT id, status, claimed_by, attempt_count,
       lease_expires_at - now()  AS lease_restante,
       now() - heartbeat_at      AS desde_ultimo_heartbeat
  FROM agent_turns
 WHERE status IN ('claimed','running')
 ORDER BY lease_expires_at;
```

Como ler as duas últimas colunas juntas — é para isso que `heartbeat_at` existe:

| `lease_restante` | `desde_ultimo_heartbeat` | Leitura |
|---|---|---|
| positivo | menor que o intervalo de heartbeat | Worker **saudável** processando algo longo. Não faça nada. |
| positivo | perto do TTL | Worker **agonizante**: renovou uma vez e parou. Vai virar takeover. Investigue o processo dono AGORA. |
| negativo | qualquer | Lease **vencida**: o turno já é elegível para takeover e o recovery o rearma no próximo tick. |

Sem `heartbeat_at` as duas primeiras linhas seriam indistinguíveis até o lease
vencer — exatamente quando já é tarde para agir.

```sql
-- Leases vencidas por par (tenant, agent) — o que o recovery vai rearmar.
SELECT tenant_id, agent_id, count(*)
  FROM agent_turns
 WHERE status IN ('claimed','running') AND lease_expires_at <= now()
 GROUP BY 1,2 ORDER BY 3 DESC;
```

### 6.2 Sinais e o que fazem

| Sinal | Significado | Ação |
|---|---|---|
| `maia_turn_claim_total{result="not_eligible"}` alto | Muitos workers acordando para o mesmo turno. **Normal** se acompanha rearme; suspeito se cresce sozinho. | Confira se o `jobId` determinístico está sendo aplicado (log `queue.turn_job_retained_cleared`, job ids `turn-*`). |
| `maia_turn_lease_lost_total{reason="heartbeat_failed"}` | O banco não respondeu duas batidas seguidas. | É saúde do PostgreSQL, não do turno. O turno volta ao pool sozinho. |
| `maia_turn_lease_lost_total{reason="token_mismatch"}` | Alguém tomou o turno. | Se recorrente, o TTL está **curto demais** para a duração real do turno — takeover falso. Aumente `TURN_LEASE_TTL_MS`. |
| `maia_turn_fence_rejected_total` | Um worker tentou gravar sem posse e foi recusado. **Uma escrita recusada = um incremento**, qualquer que seja o `operation`; o counter é emitido só pela camada de runtime (`reportFenceRejection`). Se o número parecer o dobro do esperado, alguém devolveu o incremento ao repositório. | O fence trabalhou. Investigue POR QUE ele perdeu a posse (audit `turn_lease_lost` do mesmo `turn_id`). |
| `maia_turn_effect_blocked_total{tenant_id,agent_id,boundary}` | A posse acabou NO MEIO da execução e um limite de efeito foi cancelado antes de agir. Desde a issue #601 a série é atribuída (`tenant_id` + `agent_id` do ALS), então dá para responder QUAL tenant está perdendo turnos por takeover. `boundary` tem cardinalidade FECHADA e nomeia o ponto que recusou: `pending_gate`, `scheduling_inbound_hook`, `preturn_graph`, `role_selector_decision`, `decision_engine`, `react_iteration`, `react_reasoner`, `tool_dispatch`, `tool_handler`, `mcp_tool_call`, `outbound_dispatch`, `outbound_send`, `outbound_document`, `outbound_voice`, `outbound_poll`. | Sozinho não é incidente — é o cancelamento local funcionando, e sempre vem depois de um `turn_lease_lost` do mesmo turno. Crescimento sustentado significa takeover falso: veja o TTL. |

Auditoria: `turn_lease_lost` e `turn_fence_rejected` carregam `turn_id`,
`worker_id`, `attempt` e o motivo — nunca conteúdo de conversa.

Um `turn_fence_rejected` pode nascer **sem ida ao banco**: quando a tentativa já
sabe que a lease morreu (heartbeat perdido, `release()`), a gravação é recusada
em memória — `turn.write_refused_lease_not_alive` no log, com o mesmo counter e
a mesma auditoria. É deliberado: para quem investiga "por que este turno não
concluiu", o fato é o mesmo, e a diferença entre o predicado SQL e o guard local
não muda a ação.

### 6.3 Turno preso com dono vivo

Não force. A lease vence sozinha em, no máximo, `TURN_LEASE_TTL_MS`, e forçar
(zerar `claim_token` na mão) libera o turno para um sucessor **enquanto o dono
ainda executa** — que é a execução dupla que esta issue fecha. Se for
inevitável (dono comprovadamente morto e TTL longo demais), o movimento seguro
é vencer a lease, nunca apagar o token:

```sql
UPDATE agent_turns SET lease_expires_at = now()
 WHERE id = '<turn_id>' AND status IN ('claimed','running');
```

Isso é o mesmo que o shutdown gracioso faz: o sucessor reivindica no próximo
tick e o dono antigo perde o direito de escrever no mesmo instante (toda
gravação fenced exige `lease_expires_at > now()`).

### 6.4 Rearme bloqueado por job retido

Sintoma: o turno está elegível no PostgreSQL mas nenhum worker o pega.

```bash
# O job existe e está em estado terminal?
npm run dlq   # e procure o id `turn-<turn_id>`
```

`enqueueAgent` remove sozinho jobs `completed`/`failed` antes de rearmar (log
`queue.turn_job_retained_cleared`). Se o log não aparece e o job continua lá, o
produtor não está passando `turn_id` — o job foi armado por um processo anterior
a #504, e nesse caso o rearme cria um job novo com id gerado pela BullMQ, que
também funciona.

### 6.5 Rollout e rollback do claim

**Produção greenfield: `FEATURE_TURN_CLAIM=true` já é o default e sobe no
primeiro deploy** — ver §2.0. Só isto é obrigatório:

1. `npm run db:migrate` (migration **114**) ANTES de subir o processo;
2. confirme `TURN_LEASE_TTL_MS` acima da duração p99 do turno (`maia_turn_duration_ms`);
3. observe por uma janela: `maia_turn_lease_lost_total{reason="token_mismatch"}`
   próximo de zero é o sinal de que o TTL está bem dimensionado.

Numa base COM histórico, e só nela, faz sentido a etapa intermediária: declarar
`FEATURE_TURN_CLAIM=false` no `.env`, deployar, medir, e então remover a
declaração para voltar ao default.

**Abortar** se: `lease_lost{token_mismatch}` cresce (TTL curto — takeover falso),
`fence_rejected` cresce sem `lease_lost` correspondente (algo está gravando com
token velho por outro caminho), ou a idade dos turnos em `claimed` sobe.

**Rollback de feature**: `FEATURE_TURN_CLAIM=false` volta ao regime de #503
imediatamente. Nenhum claim gravado é apagado; as leases vivas simplesmente
vencem e param de ser renovadas, e as gravações voltam a não carregar fence.
Note que isso REABRE a janela de execução dupla — é rollback de segurança
reduzida, não neutro.

**Rollback de migration**: `114_agent_turns_lease_heartbeat_down.sql` derruba
`heartbeat_at` e o índice. Pare o consumo antes e confirme que nenhum turno está
em `claimed`/`running` com lease viva. O claim não quebra sem a coluna, mas o
diagnóstico de §6.1 fica cego.

## 7. Contrato do payload do job: V1 → V2 (#504)

O job da fila `agent` existe em duas formas durante a janela de compatibilidade:

| Forma | Payload | Quem resolve o tenant |
|---|---|---|
| **V1** (legado, o default hoje) | `{ mensagem_id, turn_id?, trace_id?, enqueued_at_ms?, received_at_ms? }` | `src/agent/core.ts`, pelo canal, depois que o worker já começou |
| **V2** (`FEATURE_TURN_JOB_V2=true`) | `{ version: 2, turn_id }` e **nada mais** | `src/runtime/turns/scope-resolver.ts`, **antes** de qualquer trabalho de domínio |

O worker lê **as duas** desde esta entrega (`parseAgentTurnJob`, chamado uma vez
no topo de `startAgentWorker`). O produtor só muda com a flag.

### 7.1 A ordem é obrigatória e não é simétrica

1. deploy do código com `FEATURE_TURN_JOB_V2=false` — o consumidor passa a
   entender V2, o produtor continua armando V1. **Todas** as réplicas de consumo
   precisam estar neste build antes do passo 2: um worker antigo que receba um
   payload V2 procura `mensagem_id`, não acha, e falha o job;
2. confirme em `maia_turn_job_version_total` que a série existe e está toda em
   `version="v1"`;
3. ligue `FEATURE_TURN_JOB_V2=true`. Jobs armados a partir daí saem V2 — mas só
   quando o produtor conhece o `turn_id` (exige `FEATURE_TURN_STATE_MACHINE`);
   sem turno, o produtor continua armando V1, por construção;
4. **o critério de remoção do V1** é esta série:
   `sum(rate(maia_turn_job_version_total{version="v1"}[1h])) == 0` por uma
   janela definida. Só então o ramo legado pode sair, em PR separado.

`version="invalid"` **nunca** é ruído de fundo: é um payload que nenhum dos dois
parsers reconheceu. O turno correspondente não roda, o job vai para retry e
depois DLQ. Um ponto aqui é alerta.

### 7.2 O que o V2 muda na observabilidade

O payload V2 não carrega `received_at_ms`, `enqueued_at_ms` nem `trace_id` — a
issue exige "apenas `version` e `turn_id`". O consumidor **recompõe** os três do
banco, assim que o resolvedor devolve o escopo:

| Sinal | V1 | V2 |
|---|---|---|
| `maia_turn_e2e_latency_ms` | `received_at_ms` do payload | `mensagens.created_at` |
| `maia_queue_wait_ms` | `enqueued_at_ms` do payload, atribuída a `system` | `agent_turns.queued_at`, **atribuída ao dono** |
| `trace_id` | do payload, ou derivado de `mensagem_id` | derivado de `mensagem_id` após a resolução (a janela pré-resolução usa o `turn_id`) |
| span `queue.wait` | emitido | **não** emitido (não há instante de armação no payload) |

Consequência operacional: um turno rearmado direto de `claimed`/`running` (lease
vencida) pode não ter `queued_at`, e nesse caso a amostra de espera na fila
simplesmente não existe — inventar uma seria pior.

### 7.3 Recusas do resolvedor de escopo

`maia_turn_scope_rejected_total{reason}` + audit `turn_job_scope_rejected`.
Nenhum desses motivos é normal:

| `reason` | Significa | Ação |
|---|---|---|
| `malformed_turn_id` | o payload trouxe algo que não é UUID | Payload forjado ou produtor fora do contrato. O banco nem é consultado. |
| `turn_not_found` | nenhum turno com esse id | Payload forjado, retenção que apagou o turno, ou banco errado. |
| `scope_unusable` | o par (tenant, agent) da linha é vazio, tem espaço, ou é `default`/`system` | Dado corrompido. Um turno inbound tem dono por definição. |
| `representative_missing` | o turno aponta para uma mensagem que não existe | Corrupção de ponteiro. `representative_message_id` não tem FK. |
| `scope_mismatch` | **a mensagem representativa pertence a outro par (tenant, agent)** | **Incidente de isolamento.** Não rearme. Investigue quem escreveu esse ponteiro. |

### 7.4 Rollback

`FEATURE_TURN_JOB_V2=false` faz o próximo `enqueueAgent` voltar a armar V1
imediatamente. Jobs V2 já na fila continuam sendo entendidos pelo worker — é
justamente por isso que o consumidor precede o produtor. Não há migration
envolvida.

## 8. Identidade de stream e sequência de ingresso (#505, fases 1–2)

Fase SHADOW: as colunas `stream_key`/`stream_key_version`/`ingress_seq`
(`mensagens`) e `stream_key`/`first_ingress_seq`/`last_ingress_seq`
(`agent_turns`) passam a ser preenchidas, e **nada as lê para decidir**.
Head-of-line, exclusão por stream, debounce transacional e promoção de sucessor
são fases posteriores.

### 8.1 Ordem obrigatória do deploy

1. `npm run db:migrate` (aplica `118` e `119`);
2. só então suba o código com `FEATURE_TURN_STREAM_KEY=true` (o default).

Subir o código antes da migration derruba **todo o ingresso**: a coluna não
existe e o INSERT falha. Mesma armadilha, mesma ordem, do
`FEATURE_TURN_STATE_MACHINE` com as `096`/`097`.

### 8.2 A única mudança de comportamento observável

Um ingresso cuja identidade de stream não é derivável passa a ser **recusado**
pelo repositório, ANTES de qualquer escrita. O gateway converte a recusa em
trilha: `audit_log` recebe `stream_ingress_rejected`, o log estruturado
`baileys.stream_identity_unresolved_drop` traz o `whatsapp_id`, e a mensagem
**não** é persistida. Nunca há queda para stream genérica ou `'default'` — a
issue nomeia esse fallback como uma das falhas que ela existe para impedir.

Em produção esse caso já era fail-closed antes desta issue: todo ramo
não-lançante de `resolveChannel` devolve `channel_id`, e um miss de resolução já
derrubava a mensagem no `handleIncoming`. Se
`maia_stream_ingress_rejected_total` sair de zero, a causa provável é
configuração (linha não semeada, `MAIA_CHANNEL_ROUTING_MODE` mal ajustado) e
**não** tráfego legítimo.

### 8.3 O que olhar

| Sinal | Onde | Leitura |
|---|---|---|
| `maia_stream_ingress_total{channel_kind,result}` | `/metrics` | `result="rejected"` deve ser ZERO. Qualquer ponto é mensagem de usuário não processada. |
| `maia_stream_ingress_rejected_total{reason}` | `/metrics` | Vocabulário fechado: `missing_tenant`, `missing_agent`, `reserved_scope_literal`, `missing_channel_kind`, `missing_channel`, `missing_remote_identity`, `unnormalizable_remote_identity`. |
| `stream.ingress_sequenced` | log estruturado | `stream_key`, versão, `ingress_seq`, `mensagem_id` — é daqui que se reconstrói a ordem de uma conversa. |
| `stream_ingress_sequenced` | `audit_log` | Só o NASCIMENTO da stream (`ingress_seq = 1`). Auditar cada mensagem inflaria a tabela na razão do tráfego. |

Buraco na numeração de uma stream:

```sql
SELECT s.stream_key, s.last_ingress_seq, count(m.id) AS ingressos
  FROM agent_stream_sequences s
  LEFT JOIN mensagens m
    ON m.tenant_id = s.tenant_id AND m.agent_id = s.agent_id
   AND m.stream_key = s.stream_key
 WHERE s.tenant_id = $1 AND s.agent_id = $2
 GROUP BY s.stream_key, s.last_ingress_seq
HAVING count(m.id) <> s.last_ingress_seq;
```

Zero linhas é o esperado. Uma linha significa sequência queimada — o sintoma de
alocação fora da transação, ou de remoção de mensagens sem ajuste do contador.

### 8.4 Rollback

`FEATURE_TURN_STREAM_KEY=false` faz o próximo ingresso voltar a persistir sem
stream (colunas NULL) e desliga a recusa fail-closed. As sequências já alocadas
ficam: religar a flag CONTINUA de onde o contador parou, então o kill switch não
reordena nada — só abre um trecho sem ordem canônica.

**De migration** — ordem inversa do deploy, e a `119` cai **antes** da `118` (as
constraints e os índices da `119` dependem das colunas da `118`). O `_down` da
`119` não tem envelope `BEGIN`/`COMMIT` porque `DROP INDEX CONCURRENTLY` é
recusado dentro de transação; em compensação todo statement dele é idempotente e
independente, e reexecutar termina o trabalho. O `_down` da `118` **tem**
envelope e apaga `agent_stream_sequences` — a ordem das streams vivas se perde e
não é reconstruível. Só é seguro enquanto o protocolo for shadow.

## 9. Rollback

**De aplicação** — volte o código; mantenha as tabelas; mantenha o dual-write
enquanto houver versão mista rodando. `processada_em` nunca deixou de ser
escrito, então o caminho legado está íntegro.

**De feature** — as três flags de turno vêm ON por default (#504), então o
rollback é DECLARÁ-LAS `false`, e as **três juntas**: desligar só
`FEATURE_TURN_STATE_MACHINE` é recusado no boot. Ver §2.2, que tem a lista do
que cada uma devolve ao ser desligada. Nenhum turno, outcome, claim ou lease já
gravado é apagado.

**De migration, `115`** (`pending_race_lost`) — ordem obrigatória, e ela é o
inverso do deploy. No deploy, a `115` vai **antes** do código: subir o código
primeiro faz o `concludeTurn` da perna perdedora bater no CHECK antigo e virar
`TurnStateWriteError` em modo autoritativo. No rollback, derrube o código
primeiro e só então rode `115_agent_turns_pending_race_lost_down.sql` — que
**falha de propósito** se já houver turno com `outcome = 'pending_race_lost'`,
porque apagar essas linhas destruiria a evidência de que a perna perdedora foi
descartada em vez de reinterpretada.

**De migration, `097`** — `097_agent_turns_down.sql` é **destrutivo** (apaga a trilha).
Só execute com TODAS estas condições: nenhuma versão nova rodando, nenhum turno
em estado não-terminal, backup validado, runtime de volta à leitura legada. A
`096` só pode cair **depois** da `097` (a FK composta depende do índice único).
Nunca rode down migration automática durante incidente — ver
[`migrations.md`](migrations.md).

## 10. Exclusão de um turno ativo por stream (#625, fatia B da #505)

Fase 5 do rollout da #505. Depois desta fatia o banco garante que **no máximo um
turno de cada stream está em `claimed` ou `running`**. Isso fecha a falha nº 2
da issue-mãe — *dois turnos da mesma conversa são claimed por réplicas
diferentes* — e **não** muda a regra de elegibilidade: quem pode ser
reivindicado continua sendo qualquer turno elegível, porque o head-of-line é a
fatia seguinte (#626).

### 10.1 As duas metades, e por que nenhuma sozinha basta

A invariante desejada é temporal ("um turno com lease VIVA por stream") e o
PostgreSQL não a expressa numa constraint — uma constraint não depende de
`now()`, e uma lease vence sem que nenhuma escrita aconteça. Então ela é feita
de duas peças:

| Metade | Onde | O que quebra sem ela |
|---|---|---|
| **estrutural** | índice único parcial `agent_turns_stream_active_uq` (migration `124`) sobre `(tenant_id, agent_id, stream_key)` `WHERE stream_key IS NOT NULL AND status IN ('claimed','running')` | duas réplicas claimam turnos distintos da mesma conversa e executam em paralelo |
| **temporal** | recuperação de claims EXPIRADOS **dentro da transação** de `agentTurnsRepo.tryClaimTurn` ([`src/db/repositories/turn-repos.ts`](../../src/db/repositories/turn-repos.ts)) | o primeiro crash de worker deixa uma linha `claimed` com lease vencida ocupando a chave e a **stream fica bloqueada para sempre** |

A recuperação devolve o turno morto a `retryable` com `next_attempt_at = now()`,
**preservando** `claim_token`/`claimed_by` (forense: "quem tinha este turno
quando o pod morreu?") e **sem** gastar tentativa (o crash de um worker não pode
mandar um turno inocente para a DLQ). O varredor de recovery já procura
exatamente por esse estado.

`outbound_pending` **não** ocupa a stream, de propósito: a resposta já está
comprometida no outbox e quem finaliza é o delivery worker (#506). Prender a
conversa ali faria uma indisponibilidade do provedor de saída parar a stream
inteira.

### 10.2 Ordem obrigatória do deploy (e a pré-checagem que não é opcional)

1. **pause os consumidores** do turno. A issue-mãe exige isto antes de alterar
   índices/constraints, e o motivo é o passo 2;
2. procure duplicatas **antes** de aplicar — elas reprovam a migration e deixam
   índice inválido para trás:

```sql
SELECT tenant_id, agent_id, stream_key, count(*) AS ativos,
       array_agg(id) AS turnos
  FROM agent_turns
 WHERE stream_key IS NOT NULL
   AND status IN ('claimed', 'running')
 GROUP BY tenant_id, agent_id, stream_key
HAVING count(*) > 1;
```

   Zero linhas é o esperado. Cada linha devolvida é uma conversa que **já** tem
   dois turnos ativos: escolha um (o de menor `first_ingress_seq`) e mova os
   demais para `retryable` pelo caminho normal, **nunca** com `DELETE`;
3. `npm run db:migrate` (aplica a `124`);
4. suba o código;
5. religue os consumidores.

Subir o código antes da migration é **seguro** nesta fatia (ao contrário da
`120`): sem o índice, o claim simplesmente não tem o que recusar e volta ao
comportamento de #504. O inverso — índice sem código — também é seguro: o
`23505` viraria erro de claim, o turno continuaria elegível e o próximo tick
tentaria de novo. A pausa dos consumidores é pela janela de construção do
índice, não por incompatibilidade.

### 10.3 O que olhar

| Sinal | Onde | Leitura |
|---|---|---|
| `maia_turn_claim_total{result="stream_busy"}` | `/metrics` | Alguns pontos são NORMAIS (duas réplicas acordando com a mesma conversa). Uma taxa alta e sustentada numa janela curta é **serialização**: uma conversa quente consumindo tentativas de claim. Correlacione com `maia_turn_claim_latency_ms{result="stream_busy"}`. |
| `maia_turn_stream_claim_recovered_total{from}` | `/metrics` | Deve ser **zero** em operação saudável. Cada ponto é um worker que morreu segurando uma conversa. Um pico junto de um deploy é esperado e passa; um pico contínuo é worker instável ou `TURN_LEASE_TTL_MS` curto demais para o trabalho real. |
| `turn_stream_busy` | `audit_log` | A evidência durável de que a exclusão AGIU. Sem ela, "esta conversa parou porque o índice barrou" e "porque ninguém a reivindicou" são indistinguíveis — e têm remediações opostas. **Volume:** uma row por claim recusado, proporcional ao backlog de conversas quentes (não ao tráfego). Se a tabela crescer, a causa é serialização — trate a serialização, não o log. |
| `turn_stream_claim_recovered` | `audit_log` | `metadata.recovered` traz os turnos devolvidos à fila. É o que distingue "o sweeper achou" de "o claim da stream destravou": os dois produzem o mesmo estado final. |
| `turn.stream_claims_recovered` | log estruturado | `ops_alert: true`. Carrega `recovered_turn_ids` e o turno que estava reivindicando. |

Turnos ativos por stream, agora:

```sql
SELECT stream_key, count(*) AS ativos
  FROM agent_turns
 WHERE tenant_id = $1 AND agent_id = $2
   AND stream_key IS NOT NULL AND status IN ('claimed', 'running')
 GROUP BY stream_key
 ORDER BY ativos DESC;
```

Nenhuma linha pode ter `ativos > 1`. Se alguma tiver, o índice **não está
válido** — vá para §10.4.

### 10.4 Índice inválido (o modo de falha da migration)

`CREATE UNIQUE INDEX CONCURRENTLY` que falha — inclusive por duplicata
pré-existente — **não some sozinho**: deixa um índice `indisvalid = false`, que
continua custando escrita e não serve a nenhuma leitura. O mesmo vale para um
`DROP INDEX CONCURRENTLY` cancelado no meio.

**A armadilha, verificada contra o PostgreSQL 16 e não deduzida:** reaplicar a
migration depois disso **DEVOLVE SUCESSO**. O `IF NOT EXISTS` encontra o índice
inválido, emite `NOTICE: relation "agent_turns_stream_active_uq" already exists,
skipping`, responde `CREATE INDEX`, e o `psql` sai 0 — com o índice ainda
inválido e **a exclusão inexistente**.

**Desde a [#658](https://github.com/diogenesmendes01/Maia-v2/issues/658) isto
não depende mais de disciplina humana.** O runner de migrations recusa o run
inteiro ANTES de qualquer DDL quando o escopo carrega um índice inválido
(blocker `invalid_index`), recusa marcar como aplicada uma migration que
terminou com um índice inválido no catálogo, e o boot da aplicação morre com
**exit 98**. A recusa sobrevive inclusive a um `repair --as pending`, porque
limpar a linha do ledger não conserta o catálogo.

O que continua valendo aqui é o diagnóstico do incidente: se a consulta de
§10.3 devolver alguma stream com `ativos > 1`, confirme o estado do índice —

```sql
SELECT indexrelid::regclass AS indice, indisvalid, indisready
  FROM pg_index
 WHERE indexrelid::regclass::text = 'agent_turns_stream_active_uq';
```

— e siga o remédio completo em
[`docs/runbooks/migrations.md` §Índice inválido deixado por DDL `CONCURRENTLY`](migrations.md),
que é a fonte única desse procedimento. Enquanto o índice estiver inválido a
exclusão **não existe**: trate como incidente aberto, não como pendência de
limpeza.

### 10.5 Stream travada

Sintoma: uma conversa parou de avançar e `turn_stream_busy` aparece repetidas
vezes para os turnos dela.

```sql
SELECT id, status, attempt_count, claimed_by, claim_token,
       lease_expires_at, heartbeat_at, next_attempt_at,
       first_ingress_seq, last_ingress_seq
  FROM agent_turns
 WHERE tenant_id = $1 AND agent_id = $2 AND stream_key = $3
   AND status NOT IN ('completed', 'ignored', 'superseded', 'dead_letter')
 ORDER BY first_ingress_seq;
```

| O que a leitura mostra | Causa | Remediação |
|---|---|---|
| um turno `claimed`/`running` com `lease_expires_at` no FUTURO e `heartbeat_at` recente | worker saudável, trabalho longo | **nada**. É a exclusão funcionando. |
| `lease_expires_at` no futuro e `heartbeat_at` antigo | worker agonizante (renovou uma vez e parou) | espere o vencimento; o próximo claim recupera sozinho |
| `lease_expires_at` no PASSADO e nada acontecendo | ninguém está tentando reivindicar a stream — o job sumiu da fila | rearme pelo recovery (§3); a recuperação acontece no claim, não por varredura |
| um turno em `outbound_pending` há muito tempo | outbox travado (#506), **não** exclusão de stream | runbook do outbox — a stream não está bloqueada por ele |

**Nunca** conserte com `UPDATE agent_turns SET status = ...` à mão para
"destravar": isso pula o `state_version`, o fence e a trilha, e o worker antigo
— se estiver vivo — volta a escrever. O caminho é rearmar pela fila.

### 10.6 Rollback

**É derrubar um índice, e só.** Esta fatia foi separada exatamente para que o
rollback não toque no escalonador:

```sql
DROP INDEX CONCURRENTLY IF EXISTS agent_turns_stream_active_uq;
```

(ou `migrations/124_agent_turns_stream_exclusion_down.sql`, que é esse mesmo
statement.) Efeito imediato: o claim volta ao comportamento de #504 (exclusão
por TURNO) na primeira tentativa após o DROP. Nenhuma linha muda de estado,
nenhum turno é perdido, nenhuma coluna é apagada.

A metade temporal continua rodando após o DROP, e continua correta: ela apenas
devolve à fila turnos cuja lease venceu — o que o recovery já fazia. Não há
"meio rollback" a considerar.

**Interação com `FEATURE_TURN_CLAIM=false`** (o kill switch de #504, §9): com a
flag desligada, quem escreve `claimed` é o `markClaimed` legado, que passa pelo
CAS genérico e não pelo claim atômico. O índice continua valendo para ele — a
transição é recusada com o conflito tipado `stream_busy` em vez de virar um
`23505` cru, então nada explode e o turno continua elegível. Ainda assim, se
você desligar a flag por incidente, **derrube o índice junto**: o regime legado
não tem a metade temporal (não recupera claim expirado), e uma lease vencida
passaria a prender a stream até o recovery rearmar o MESMO turno.

O `_down` da `124` **não** tem envelope `BEGIN`/`COMMIT`, pela mesma razão do
`_down` da `122`: `DROP INDEX CONCURRENTLY` é recusado dentro de transação, e
trocar por `DROP INDEX` simples para poder envelopar tomaria `ACCESS EXCLUSIVE`
sobre `agent_turns` — bloqueio de runtime durante um rollback. O arquivo tem um
único statement idempotente, então não existe estado intermediário.

Ordem no rollback COMPLETO do protocolo de stream: `124` → `122` → `120`. A
`124` sozinha é independente e pode ser derrubada e reaplicada sem tocar nas
outras duas — é isso que a torna o kill switch da fatia.

---

## 11. Head-of-line como condição do claim (#626, fatia C da #505)

Fase 6 do rollout da #505, e a primeira que muda **quem** pode ser
reivindicado. Depois desta fatia, um turno só é claimável quando **não existe
turno anterior não terminal na mesma stream** — "anterior" medido por
`first_ingress_seq`, a fronteira que a fatia A (#624) passou a persistir.

Isso fecha as falhas nº 1 e nº 3 da issue-mãe (*M1 e M2 chegam nessa ordem, mas
M2 termina antes de M1*; *um retry antigo reaparece depois de um turno mais
novo*). O que ela **não** faz: promover o sucessor quando o head termina — isso
é a #627, documentada na **§12**, e a janela de latência que ela fecha está
descrita na §11.5.

### 11.1 As duas condições, e onde cada uma mora

A issue-mãe pede duas coisas ao mesmo tempo, e elas moram em lugares diferentes
de propósito:

| Condição | Onde | Recusa |
|---|---|---|
| não existe turno **anterior não terminal** na stream | `NOT EXISTS` no `WHERE` do claim — [`src/db/repositories/stream-head-sql.ts`](../../src/db/repositories/stream-head-sql.ts) | `not_head` / `stream_blocked` |
| não existe outro turno **ativo com lease válida** na stream | índice `agent_turns_stream_active_uq` (#625, migration 124) | `stream_busy` |

A **ordem em que falham é observável**: o `WHERE` roda antes do índice, então um
turno posterior numa conversa ocupada devolve `not_head` — não `stream_busy`.
O `stream_busy` continua existindo para o que a ordem não consegue decidir:
turnos com `stream_key` e **sem** `first_ingress_seq` (backfill, replay), e
sequências empatadas dentro da mesma stream. Se `stream_busy` subir depois desta
fatia, procure por esses dois — não por conversas quentes.

### 11.2 `not_head` e `stream_blocked` não são sinônimos

As duas param o claim. A leitura operacional é oposta, e é por isso que são
códigos diferentes:

| Código | Estado do bloqueador | O que fazer |
|---|---|---|
| `not_head` | `received`, `queued`, `claimed`, `running`, `retryable` | **nada.** A conversa tem fila e ela anda sozinha. |
| `stream_blocked` | `outbound_pending` | **runbook do outbox (#506).** Nenhum claim tira um turno de `outbound_pending`; quem o move é o delivery worker. Esperar não resolve. |

**A decisão de projeto que merece ser contestada:** `outbound_pending` bloqueia a
ordem, e a fatia B decidiu que ele **não** ocupa a stream (§10.1). As duas coisas
são verdadeiras porque respondem a perguntas diferentes — "quantos podem estar
ativos?" e "quem é o próximo?" —, mas o efeito prático é que uma
indisponibilidade do provedor de saída **para a conversa** (não o tenant, não a
fila). É o preço de FIFO: responder M2 antes de a resposta de M1 ter saído é
exatamente a inversão que a #505 existe para impedir. Se esse preço não for
aceitável para uma coorte, o kill switch é `FEATURE_TURN_HEAD_OF_LINE=false`
(§11.6), não mexer no predicado.

### 11.3 O que olhar

| Sinal | Onde | Leitura |
|---|---|---|
| `maia_stream_fifo_violation_total{stage}` | `/metrics` | **Sempre zero.** A issue-mãe lista `fifo_violation_total > 0` entre os critérios de ABORTAR o rollout, ao lado de violação de isolamento. `stage="claim"` é o canário da pós-condição do claim; `stage="recovery"` é o do varredor. A série é publicada em ZERO no boot — se ela sumir de `/metrics`, o problema é o processo, não a métrica. |
| `maia_stream_blocked_total{reason}` | `/metrics` | `not_head` é ROTINA: cada mensagem que chega enquanto a anterior roda conta um ponto. O que se vigia é a FORMA — `not_head` crescendo sem `maia_turn_claim_total{result="acquired"}` correspondente é uma conversa que parou. `stream_blocked` sustentado é o outbox. |
| `maia_turn_claim_total{result}` | `/metrics` | ganhou `not_head` e `stream_blocked`. `stream_busy` deve CAIR quase a zero depois desta fatia (§11.1). |
| `turn_stream_blocked` | `audit_log` | `metadata.reason` + `metadata.blocked_by_turn_id`: é o que permite reconstruir a fila sem recorrer à `stream_key`. |
| `turn_stream_fifo_violation` | `audit_log` | Nunca deveria existir. `metadata.stage` e `metadata.earlier_live` dizem onde e quantos. |
| `turn.stream_head_blocked` / `turn.stream_fifo_violation` | log estruturado | o segundo com `ops_alert: true`. |

A fila de uma conversa, agora:

```sql
SELECT id, status, first_ingress_seq, last_ingress_seq,
       attempt_count, next_attempt_at, lease_expires_at
  FROM agent_turns
 WHERE tenant_id = $1 AND agent_id = $2 AND stream_key = $3
   AND status NOT IN ('completed', 'ignored', 'superseded', 'dead_letter')
 ORDER BY first_ingress_seq;
```

A primeira linha é o head. Se ela não avança, a conversa inteira não avança —
vá para a §11.5.

### 11.4 O índice, e como confirmar que ele está de pé

A regra é um `NOT EXISTS`, então ela é **correta sem índice nenhum** — só fica
cara. A migration `126` cria `agent_turns_stream_head_live_idx`:

```
(tenant_id, agent_id, stream_key, first_ingress_seq)
WHERE stream_key IS NOT NULL
  AND status NOT IN ('completed','ignored','superseded','dead_letter')
```

Por que ele e não o `agent_turns_stream_head_idx` da `122`: naquele, `status` vem
**depois** de `first_ingress_seq`, então a desigualdade `NOT IN` é FILTRO, não
busca — o `NOT EXISTS` percorre todas as entradas anteriores da stream. Medido
contra PostgreSQL 16, numa conversa com 5.000 turnos (4.997 já concluídos):

| | plano | buffers | tempo |
|---|---|---|---|
| com a `126` | `Index Only Scan using agent_turns_stream_head_live_idx`, `Rows Removed by Filter: 0` | 2 | 0,097 ms |
| sem a `126` | `Index Only Scan using agent_turns_stream_head_idx`, **`Rows Removed by Filter: 4997`** | 97 | 2,362 ms |

O custo sem o índice cresce com o HISTÓRICO da conversa, que nunca encolhe —
turno terminal não sai da tabela. Com ele, cresce com o BACKLOG, que é 0–2 na
operação normal.

**Confirme `indisvalid` à mão depois de aplicar.** Um `CREATE INDEX
CONCURRENTLY` que falha deixa o índice inválido, e reaplicar a migration
**devolve sucesso** (o `IF NOT EXISTS` encontra o índice inválido e responde
`CREATE INDEX`) — o runner marca a migration como aplicada sem o índice, e nada
distingue isso de um deploy bem-sucedido:

```sql
SELECT indexrelid::regclass AS indice, indisvalid, indisready
  FROM pg_index
 WHERE indexrelid::regclass::text = 'agent_turns_stream_head_live_idx';
```

`indisvalid = false` ⇒ `DROP INDEX CONCURRENTLY IF EXISTS
agent_turns_stream_head_live_idx;` e reaplique a `126`. Ao contrário da `124`,
aqui um índice inválido **não** quebra a invariante — quebra o desempenho. Trate
como degradação, não como incidente de correção.

### 11.5 Stream parada, e o que mudou em relação à §10.5

O sintoma novo: `turn_stream_blocked` repetido para os turnos de uma conversa e
o head sem avançar. Rode a consulta da §11.3 e leia a PRIMEIRA linha:

| Head | Causa | Remediação |
|---|---|---|
| `claimed`/`running`, lease no FUTURO, heartbeat recente | worker saudável, trabalho longo | **nada**. É o FIFO funcionando. |
| `claimed`/`running`, lease no PASSADO | dono morto | o próximo claim **do head** recupera sozinho (§10.1). Se ninguém tenta, rearme pelo recovery (§3). |
| `retryable` com `next_attempt_at` no futuro | backoff em aberto | **nada**. A issue-mãe é explícita: "backoff não autoriza ultrapassagem silenciosa por mensagens posteriores". |
| `outbound_pending` | outbox travado | runbook do outbox (#506). O código de recusa é `stream_blocked`, não `not_head`. |
| `received`/`queued` há muito tempo | o job do head sumiu da fila | recovery (§3) — e ele já elege o head, pela mesma função do claim. |

**A janela de latência que esta fatia introduziu — FECHADA pela #627.** Antes da
fatia C, um head que morria com a lease vencida era destravado pelo SUCESSOR: ele
reivindicava, a transação recuperava o morto e a conversa andava na hora — fora
de ordem. Com o head-of-line, a recuperação continua acontecendo (é o que devolve
o head a `retryable`), mas o sucessor é recusado como `not_head`. Quem avança é o
head, na vez dele — e, **até a #627**, ele só voltava à fila quando o varredor de
recovery o rearmasse, o que levava até `STUCK_AFTER_MS` (2 min).

Desde a fatia D (§12) essa espera não existe mais, nos dois caminhos:

| Evento | Antes (#626) | Agora (#627) |
|---|---|---|
| head chega a estado TERMINAL | o sucessor esperava o varredor: **até 120000ms** | promovido e acordado na transação da conclusão: **8ms medidos** |
| claim expirado do head recuperado na transação do claim | o head voltava a `retryable` sem wake-up e esperava o varredor: **até 120000ms** | re-armado no mesmo instante: **13ms medidos** |

Os números são de `tests/integration/turn-stream-promotion-real-db.spec.ts`,
contra PostgreSQL real, e a spec os imprime a cada rodada. O varredor continua
existindo e continua sendo a rede: ele é quem reconcilia o caso em que o processo
morre entre o commit da promoção e o `enqueueAgent` (§12.3).

**Nunca** conserte com `UPDATE agent_turns SET status = ...` à mão: isso pula o
`state_version`, o fence e a trilha. Um turno que "não devia estar na frente"
tem de sair pelo caminho normal (conclusão, `ignored` por política, ou DLQ
auditada — que é a #629).

### 11.6 Rollout e rollback

Ordem obrigatória do deploy:

1. `npm run db:migrate` (aplica a `126`) e **confirme `indisvalid` (§11.4)**;
2. suba o código com `FEATURE_TURN_HEAD_OF_LINE=true` (o default).

Subir o código antes da migration é **seguro em correção e caro em desempenho**:
a regra funciona sem o índice e passa a varrer o histórico de cada conversa a
cada claim. Não faça isso de propósito.

O kill switch é a flag, não a migration:

```
FEATURE_TURN_HEAD_OF_LINE=false   # + restart
```

Com ela OFF o claim volta ao comportamento de #625 (qualquer turno elegível,
com no máximo um ativo por stream) e a plataforma volta a poder responder M2
antes de M1. Nenhum turno já gravado é perdido, e **religar não reordena nada**:
a ordem vem de `first_ingress_seq`, que continua sendo gravado nas duas
posições. A flag exige `FEATURE_TURN_STREAM_KEY` ligada — a combinação
`HEAD_OF_LINE=true` + `STREAM_KEY=false` é recusada no boot pela regra
`turn-head-of-line/requires-stream-key`, porque seria inerte (sem `stream_key`
gravada, todo turno passa no predicado) e o operador acreditaria ter ligado o
FIFO.

O `_down` da `126` derruba **o índice, não a regra**. Num rollback de verdade a
ordem é: desligue a flag primeiro, confirme que as réplicas recarregaram, e só
então derrube o índice — na ordem inversa você deixa a regra ligada sem índice,
que é exatamente a degradação que a fatia existe para evitar, aplicada de
propósito durante um incidente.

Ordem no rollback COMPLETO do protocolo de stream: `126` → `124` → `122` →
`120`.

## 12. Promoção do sucessor (#627, fatia D da #505)

Fase 6 do rollout da #505, e a fatia que devolve a latência que a §11 comprou. A
regra em uma frase: **quando um turno chega a estado terminal, a MESMA transação
elege o próximo turno elegível da conversa, persiste a decisão e — só depois do
commit — sinaliza a fila.**

### 12.1 Por que a promoção mora dentro da transação da conclusão

Não é elegância, é a única posição em que as três exigências da issue são
estruturais em vez de convencionais:

| Exigência | Como a posição a garante |
|---|---|
| "validar o `claim_token` do turno que está terminando" | quem chega à promoção já passou pelo `WHERE` do CAS terminal, que carrega `claim_token = <o meu>` **e** `lease_expires_at > now()`. Um zumbi não chega: o CAS dele devolve zero linhas |
| "persistir a decisão ANTES de sinalizar a BullMQ" | o objeto da promoção só existe no retorno da transação. Não há caminho de código em que o sinal preceda o commit |
| "promover de forma idempotente" | a eleição é `ORDER BY first_ingress_seq LIMIT 1 FOR UPDATE`: duas conclusões simultâneas da mesma stream serializam no lock de linha, e a segunda re-avalia o `WHERE` contra a linha nova e não casa |

E a razão que não está na issue e é a mais prática: uma promoção em transação
SEPARADA teria um estado intermediário — conclusão comitada, promoção não — cuja
única saída seria o varredor. Isto é, a janela de 2 minutos que a fatia existe
para fechar.

### 12.2 O que é promovido, e o que não é

O sucessor eleito é o **menor `first_ingress_seq` não terminal da stream** (o
novo head), e ele só é promovido se estiver reivindicável AGORA:

| Estado do sucessor | Promovido? | Por quê |
|---|---|---|
| `received` | sim (vira `queued`) | nunca teve wake-up |
| `queued` | **sim**, re-armado | é o caso NORMAL: o job dele já acordou, foi recusado com `not_head` e terminou. O wake-up foi CONSUMIDO |
| `retryable` com backoff vencido | sim (vira `queued`) | trabalho legítimo |
| `retryable` com backoff em ABERTO | não | *"backoff não autoriza ultrapassagem silenciosa"* — a conversa espera o varredor |
| `claimed` / `running` | não | já tem dono vivo |
| `outbound_pending` | não | nenhum claim o move; quem o move é o delivery worker (#506) |
| stream sem sucessor | não | `result="no_successor"`, o caso majoritário |

`queued_at` **não** é reescrito pela promoção: ele mede quando a espera começou.
Reescrevê-lo faria uma conversa presa há uma hora parecer recém-chegada para
`maia_stream_head_age_seconds`.

### 12.3 "Commit feito, enqueue não feito"

A fila é **wake-up, não fonte de verdade**. Se o processo morre entre o commit e
o `enqueueAgent`, o turno promovido existe no banco e não existe na fila.

Quem fecha o buraco é o varredor de recovery, e o que ele lê é `promoted_at`:

```sql
SELECT id, status, promoted_at, promoted_by_turn_id, queued_at
  FROM agent_turns
 WHERE tenant_id = $1 AND agent_id = $2
   AND promoted_at IS NOT NULL
 ORDER BY promoted_at;
```

`promoted_at IS NOT NULL` significa *"este turno foi eleito para avançar e ainda
ninguém o acordou"* — **o claim zera a coluna quando a dívida é paga**. Uma linha
com `promoted_at` antigo é um wake-up que se perdeu; várias, com `promoted_at`
crescendo, é o varredor parado.

### 12.4 O que olhar

| Sinal | Onde | Leitura |
|---|---|---|
| `maia_stream_promotion_total{result="promoted"}` | `/metrics` | rotina. A razão `promoted/(promoted+no_successor)` é a fração de conclusões que destravaram fila; ela cai a zero quando alguém desliga a flag sem querer |
| `{result="no_successor"}` | `/metrics` | rotina, e é o DENOMINADOR — sem ele `promoted` sozinho não distingue "as conversas acabaram" de "a promoção parou" |
| `{result="fence_rejected"}` | `/metrics` | um worker ZUMBI tentou concluir (e liberar o sucessor) e foi barrado. Não deveria ser rotina: sustentado, procure lease curta demais ou GC longo — ver §6.1 |
| `{result="enqueue_failed"}` | `/metrics` | a decisão comitou e o Redis falhou. **Só é problema sem `recovered` acompanhando** |
| `{result="recovered"}` | `/metrics` | o varredor reconciliou. Ver §12.3 |
| `turn_promoted` | `audit_log` | `metadata.source` distingue `terminal` (rotina), `stream_claim_recovery` (um worker morreu) e `recovery_reconciliation` (um sinal se perdeu). `metadata.promoted_by_turn_id` reconstrói a fila sem recorrer à `stream_key` |
| `turn_promotion_rejected` | `audit_log` | a falha nº 9 da issue-mãe registrada no momento em que ela NÃO acontece |
| `stream.turn_promoted` / `stream.turn_promotion_enqueue_failed` | log estruturado | o segundo é `warn`, não `error`: o varredor conserta sozinho, e alerta que se resolve sozinho é como se ensina o plantão a ignorar alerta |

### 12.5 Conversa que não anda depois de uma conclusão

Rode a consulta da §11.3 e leia a PRIMEIRA linha:

| Head | Causa | Remediação |
|---|---|---|
| `queued` com `promoted_at` preenchido e antigo | o wake-up se perdeu e o varredor não passou | §12.3. Cheque se o worker de recovery está vivo; `maia_stream_promotion_total{result="enqueue_failed"}` sem `recovered` confirma |
| `retryable` com `next_attempt_at` no futuro | backoff em aberto | **nada.** É a §11.5, e é deliberado |
| `outbound_pending` | outbox travado | runbook do outbox (#506). A promoção não o move |
| terminal, e o sucessor sem `promoted_at` | a promoção não rodou | confirme `FEATURE_TURN_STREAM_PROMOTION` e `FEATURE_TURN_HEAD_OF_LINE` (a primeira é inerte sem a segunda) e a migration `127` |

**Nunca** conserte com `UPDATE agent_turns SET status = ...` à mão — vale aqui o
mesmo da §11.5: isso pula o `state_version`, o fence e a trilha.

### 12.6 Rollout e rollback

Ordem obrigatória do deploy:

1. `npm run db:migrate` (aplica a `127` — `ADD COLUMN` nullable, metadata-only,
   sem `CONCURRENTLY` e portanto sem a armadilha de índice inválido da §10.4);
2. suba o código com `FEATURE_TURN_STREAM_PROMOTION=true` (o default).

Subir o código antes da migration **não** é seguro nesta fatia (ao contrário da
`126`): a promoção escreve `promoted_at`/`promoted_by_turn_id`, e sem as colunas
toda transição terminal falha.

O kill switch é a flag:

```
FEATURE_TURN_STREAM_PROMOTION=false   # + restart
```

Com ela OFF a **ordem continua correta** — o head-of-line não depende da promoção
— e a conversa volta a andar na cadência do varredor: latência, não inversão. É
por isso que o rollback desta fatia é barato e o da #626 não é.

O `_down` da `127` derruba as COLUNAS, e por isso a ordem num rollback de verdade
é: desligue a flag primeiro, confirme que as réplicas recarregaram, e só então
rode o `_down`. Na ordem inversa a aplicação escreve numa coluna que não existe.

Ordem no rollback COMPLETO do protocolo de stream: `127` → `126` → `124` →
`122` → `120`.

## 13. Debounce transacional (#628, fatia E da #505)

Fase 7 do rollout da #505. A regra em uma frase: **a janela do debounce é uma
linha do PostgreSQL — aberta na mesma transação que persiste o ingresso,
estendida na mesma transação do ingresso seguinte, e fechada por um
compare-and-swap sob o mutex da stream. Nenhum timer em memória é fonte de
verdade.**

### 13.1 O que mudou, e o que quebrava antes

Antes desta fatia a janela vivia em dois lugares que não são o banco: um job
ATRASADO da BullMQ (`debounce:<tenant>:<agent>:<phone>`, com o prazo no `delay`)
e uma chave no Redis com o `first_enqueued_at`. Dois defeitos, os dois nomeados
pela issue:

| Defeito | Como aparecia em produção |
|---|---|
| duas réplicas fechando batches **sobrepostos** | duas respostas para a mesma rajada, ou uma resposta que ignora metade das mensagens. Nenhuma linha do banco fica inconsistente — só a conversa |
| **reinício perde a janela inteira** | um deploy entre o `agentQueue.add` e o disparo deixava a rajada sem ninguém para fechá-la. As mensagens não se perdiam (o recovery por estado as rearmava depois de `STUCK_AFTER_MS`), mas saíam como N turnos separados, até 2 min depois |

Depois: `agent_turns.debounce_window_opened_at` / `debounce_deadline_at` /
`debounce_closed_at` / `debounce_batch_size` (migration `130`). O caminho de
ingresso do debounce **não toca o Redis** — é a metade da issue que nenhum teste
de concorrência prova sozinho: um reinício não pode perder um `add` que não
existe.

### 13.2 A BORDA — a pergunta que a issue-mãe chamava de risco

O risco declarado era *"debounce distribuído é suscetível a bordas temporais mal
definidas"*. A borda escolhida está escrita em
`src/db/repositories/stream-debounce-sql.ts`, e ela é de **serialização**, não de
relógio:

1. **O mutex da stream é a linha de `agent_stream_sequences`** — a MESMA que
   `allocateIngressSeq` tranca para alocar `ingress_seq`, e que o PostgreSQL
   segura até o COMMIT do ingresso. Enquanto qualquer ingresso da stream estiver
   em voo, o fechamento **não começa**;
2. **Um ingresso que COMITA antes de o fechador pegar o mutex entra no batch
   atual; um que comita depois entra no PRÓXIMO.** Não depende de skew entre
   réplicas nem da ordem em que os `Date.now()` foram lidos;
3. **O batch é um PREFIXO CONTÍGUO**, nunca um conjunto esparso.

Consequência de (1): não existe instante em que o fechador enxergue a sequência
7 sem enxergar a 6. A lacuna que a issue proíbe absorver silenciosamente é
**impossível**, não apenas improvável.

Consequência de (3), e é a que aparece na operação: **mídia no meio da rajada
FECHA o batch antes dela.** "M1 texto, M2 áudio, M3 texto" produz o batch `{M1}`;
o áudio segue pelo caminho direto e M3 espera a próxima janela. Absorver M3 por
cima do áudio responderia a terceira mensagem antes da segunda.

### 13.3 O ciclo de vida da janela

```
ingresso de texto (mesma transação que grava a mensagem e o turno)
   ├─ carimba debounce_window_opened_at neste turno
   └─ recalcula debounce_deadline_at de TODOS os membros vivos da janela:
        LEAST(now() + MESSAGE_DEBOUNCE_MS, MIN(opened_at) + MESSAGE_DEBOUNCE_MAX_MS)

stream_debounce_closer (cron 1/min, drena ~50s sondando a cada 500ms)
   ├─ listDueDebounceStreams()  → cross-tenant, WHERE deadline <= now()
   └─ por stream, em UMA transação:
        1. mutex (FOR UPDATE SKIP LOCKED)      → sem linha ⇒ stream_locked
        2. GC das janelas de turnos terminais
        3. prefixo contíguo de membros          → vazio ⇒ no_window
        4. deadline <= now() avaliado NO BANCO  → não ⇒ not_due
        5. head: status=queued, debounce_closed_at, debounce_batch_size,
           promoted_at, fronteira last_ingress_seq estendida  → 0 linhas ⇒ lost_race
        6. irmãos: superseded/merged_into_turn + inputs REANCORADOS no head
   └─ depois do COMMIT: audit stream_batch_closed, métrica, enqueueAgent(head)
```

O prazo mora em **todos** os membros, não só no head. Se o head morrer por outro
caminho (um operador o ignora, uma absorção o supersede), o relógio da janela
sobrevive nos irmãos — sem isso, a rajada só sairia quando chegasse uma mensagem
nova.

### 13.4 Por que o turno fica em `received` até o fechamento

`queued` significa *"existe wake-up para este turno"*, e antes do fechamento não
existe. Carimbá-lo no ingresso faria o varredor de recovery enxergar um turno
enfileirado sem job e rearmá-lo por conta própria — furando a janela que acabou
de ser aberta.

Consequência operacional: durante a janela (5 s típicos, teto de 30 s) uma
rajada aparece como N turnos `received`. Isso é normal. O que **não** é normal é
`received` acumulando junto com `agent_turns_debounce_due_idx` cheio — ver §13.7.

### 13.5 O batch é um FATO do banco, não uma redescoberta em memória

O fechamento **repõe** `agent_turn_inputs.turn_id` dos irmãos para o head. É por
isso que `agentTurnsRepo.listClosedDebounceBatch(turn_id)` devolve a rajada
inteira em ordem de `mensagens.ingress_seq`, e é dela que `src/agent/core.ts` lê
quando a flag está ligada — em vez de redescobrir os irmãos por telefone +
`processada_em` + `created_at`, que é uma SEGUNDA definição de batch e diverge da
primeira no dia em que uma mensagem chega entre o fechamento e a execução.

Dois efeitos que valem saber:

* `processada_em` do irmão passa a ser carimbado quando o **head** chega a
  terminal, e não quando o irmão é absorvido. É mais honesto (a mensagem só foi
  respondida quando a resposta da rajada saiu) e evita que o probe de divergência
  de #503 acuse todo irmão absorvido;
* `absorbDebounceInputs` (o caminho de #503) **não** roda para um batch já
  fechado: a absorção já aconteceu, e reexecutá-la só conseguiria conflitar.

### 13.6 "Fechamento comitado, wake-up não enviado"

Fechar o batch **é** eleger quem avança, então o head fechado carimba
`promoted_at` — a MESMA coluna da fatia D. Um processo que morra entre o commit e
o `enqueueAgent` cai exatamente no caso que a §12.3 já cobre: o varredor de
`message-recovery` reencontra o turno promovido sem job, o rearma e conta
`maia_stream_promotion_total{result="recovered"}`.

Não existe uma segunda reconciliação para esta fatia, de propósito. Duas
reconciliações com o mesmo modo de falha é como uma delas fica sem manutenção.

### 13.7 O que vigiar

| Sinal | Leitura |
|---|---|
| `maia_stream_debounce_batch_size` (`_sum/_count`) | tamanho médio do batch. **1 constante** significa que o debounce não está agrupando nada — a fatia estaria pagando escrita e varredura por nada. `le="1"` sobre o total é a fração de rodadas sem agrupamento |
| `maia_stream_debounce_close_total{result="closed"}` | parou de crescer com janelas abertas acumulando ⇒ **varredor morto** |
| `..._total{result="stream_locked"}` | dominando ⇒ contenção de ingresso: transações de ingresso longas segurando o mutex da stream |
| `..._total{result="lost_race"}` | constante para a MESMA stream ⇒ o head da janela saiu de `CLAIMABLE_STATUSES` sem ficar terminal — está `claimed`/`running`. Ver abaixo |
| `..._total{result="not_due"}` | **é o caso saudável**: o prazo esticou depois da enumeração |
| `audit_log` `stream_batch_closed` | a resposta para "por que a Maia respondeu três mensagens minhas de uma vez?" e "por que não agrupou a quarta?". Carrega `batch_size` e `absorbed_turn_ids` |

Consulta de triagem — janelas abertas e vencidas há mais de um minuto (isto é,
que o varredor deveria ter fechado):

```sql
SELECT tenant_id, agent_id, count(*) AS janelas,
       min(debounce_deadline_at) AS mais_antiga
  FROM agent_turns
 WHERE debounce_deadline_at IS NOT NULL
   AND debounce_closed_at IS NULL
   AND debounce_deadline_at < now() - interval '1 minute'
 GROUP BY 1, 2
 ORDER BY mais_antiga;
```

Linhas aqui significam varredor parado, ou uma stream cujo mutex está preso.
Verifique primeiro se `stream_debounce_closer` está registrado e rodando
(`maia_worker_*`), depois procure transação longa em `pg_stat_activity`.

**O caso `lost_race` que se repete, e por que ele NÃO é um bug a consertar.**
Se o varredor ficar parado por mais de `STUCK_AFTER_MS` (2 min), o recovery por
estado alcança o head ainda `received`, o rearma e um worker o executa **sozinho**
— a rajada perde o agrupamento, mas nada se perde. Nessa janela o head está
`claimed`/`running`, que não é terminal (continua sendo membro) e não é
reivindicável (`CLAIMABLE_STATUSES`), então todo tick devolve `lost_race` para
aquela stream. É estado transitório e conservador: quando o head chega a
terminal, o passo de GC fecha a janela dele e o próximo membro vira head. A
alternativa — tirar `claimed`/`running` do conjunto de membros — seria pior: o
`LAG` não veria quebra na primeira linha, e o batch fecharia **por cima** de um
turno em execução.

### 13.7-bis Isolamento entre tenants na MESMA `stream_key`

A `stream_key` embute tenant e agent no material canônico, mas **embutir não é
escopar**. Duas linhas com a mesma chave em tenants diferentes são estado real
(backfill, replay manual, colisão de hash), e a fatia B já trata o caso na
exclusão. No fechamento do debounce, o escopo se divide em dois grupos — e a
distinção importa para quem for refatorar:

| Consulta | Escopo carrega peso? | Por quê |
|---|---|---|
| `openDebounceWindowMembers` (prefixo do fechamento **e** armar da janela) | **SIM** | é a única que seleciona por `stream_key` sem um `id` único. Sem escopo, o batch de um tenant absorve os turnos do outro |
| GC do passo 2 (janelas de turnos mortos por outro caminho) | **SIM** | mesma razão: `stream_key` sem `id`. Sem escopo, fechar um tenant fecha a janela órfã do outro |
| `UPDATE` de fechamento, `listClosedDebounceBatch`, os dois statements de `armDebounceWindowTx` | não — **defesa em profundidade** | todos têm `id = <único>` no `WHERE`, e o id vem de consulta já escopada |

Os dois primeiros estão cobertos por `tests/integration/turn-stream-debounce-real-db.spec.ts`
("a MESMA stream_key em TENANTS diferentes…"), com mensagem própria em cada
asserção para que o vermelho diga qual dos dois quebrou. Os três últimos ficam
sem cobertura **de propósito**: um teste que só pode falhar depois de alguém
trocar a origem do `id` provaria o harness, não o código.

### 13.8 A composição do batch, depois do fato

```sql
-- quem o head absorveu
SELECT id, status, outcome, first_ingress_seq, last_ingress_seq
  FROM agent_turns
 WHERE superseded_by_turn_id = '<head>'
 ORDER BY first_ingress_seq;

-- as mensagens que o head vai responder, na ordem canônica
SELECT i.ingress_seq, m.ingress_seq AS seq_da_stream, m.tipo
  FROM agent_turn_inputs i
  JOIN mensagens m ON m.id = i.mensagem_id
 WHERE i.turn_id = '<head>'
 ORDER BY m.ingress_seq;
```

`agent_turns.debounce_batch_size` guarda o número já consolidado — é a evidência
que sobrevive à retenção levar os turnos `superseded`.

### 13.9 Rollout e rollback

Ordem obrigatória do deploy:

1. `npm run db:migrate` (aplica a `130`). O arquivo **não é atômico**: ele usa
   `CONCURRENTLY` e portanto `maia:no-transaction`, e o runner autocommita por
   statement. Se o índice falhar, as colunas ficam — estado correto, só lento.
   Reaplicar conserta;
2. **confira o índice à mão** (armadilha da §10.4 / issue #658 — um
   `CONCURRENTLY` que falha devolve exit 0 na reaplicação):

   ```sql
   SELECT indexrelid::regclass, indisvalid, indisready
     FROM pg_index
    WHERE indexrelid::regclass::text = 'agent_turns_debounce_due_idx';
   ```

3. suba o código. `FEATURE_TURN_STREAM_DEBOUNCE` vem `true`, e é **inerte**
   enquanto `FEATURE_MESSAGE_DEBOUNCE` estiver `false` (o default do
   repositório): sem debounce não há janela a tornar transacional.

Subir o código antes da migration **não** é seguro: a janela é aberta dentro da
transação do ingresso, e sem as colunas todo ingresso de texto falha.

O kill switch é a flag:

```
FEATURE_TURN_STREAM_DEBOUNCE=false   # + restart
```

Com ela OFF volta o debounce em memória, com as duas falhas conhecidas da §13.1.
**Nenhuma mensagem é perdida em nenhuma das posições.** Janelas já abertas e não
fechadas param de ser fechadas — os turnos ficam `received` e quem os rearma
passa a ser o recovery por estado (até `STUCK_AFTER_MS`), um turno por mensagem,
em ordem. Antes de rodar o `_down`, drene-as:

```sql
SELECT count(*) FROM agent_turns
 WHERE debounce_deadline_at IS NOT NULL AND debounce_closed_at IS NULL;
```

A flag **exige** `FEATURE_TURN_HEAD_OF_LINE`, e a dependência é de SEGURANÇA, não
de inércia: o fechamento marca os irmãos `superseded` sem fence, e só pode fazer
isso porque um turno que não é o head é INCLAIMÁVEL — ninguém o está executando.
Sem head-of-line o fechamento poderia absorver um irmão que um worker está
executando neste instante. Desligar a #626 sem desligar esta fatia é a
combinação a evitar; o boot **não** a recusa (pelo mesmo motivo da §12.6: um
segundo passo obrigatório no meio de um incidente é pior), então a ordem correta
de um rollback da #626 é desligar as duas.

Ordem no rollback COMPLETO do protocolo de stream: `130` → `127` → `126` →
`124` → `122` → `120`.

## 14. Retry, poison/DLQ, fairness e replay (#629, fatia F da #505)

Fase 8 e ÚLTIMA do rollout da #505. Três coisas, e as três fecham cláusulas
literais da issue-mãe:

1. a política de **poison/DLQ** passa a ESCOLHER, por categoria de erro, entre
   liberar a conversa e interditá-la — e a escolha é auditada;
2. o **replay manual** deixa de poder violar a ordem já comprometida sem uma
   declaração explícita;
3. **fairness e starvation** passam a ser MEDIDOS. Até aqui não eram, em fatia
   nenhuma.

### 14.1 A escolha que não existia, e por que a ausência dela era um bug

Até a #627, `dead_letter` liberava a conversa. Não por decisão: por OMISSÃO.
`dead_letter` é terminal (#503), um turno terminal sai do predicado de
head-of-line (#626), logo o sucessor vira reivindicável. Ninguém escolheu isso —
foi efeito colateral da máquina de estados, e a issue-mãe chama exatamente essa
situação de falha nº 5.

As duas saídas são **defensáveis e incompatíveis**:

| Saída | Preserva | Custa |
|---|---|---|
| `release` — `dead_letter` e a conversa anda | disponibilidade | a semântica: a plataforma responde M2 sem nunca ter respondido M1 |
| `block_stream` — `dead_letter` + interdição | a semântica | a conversa: nada anda até um humano olhar |

A decisão é `(código de erro, outcome) -> categoria -> saída`, e a configuração
é **por categoria**:

```
TURN_POISON_BLOCK_CATEGORIES=effect_committed     # default
```

| Categoria | O que é | No default |
|---|---|---|
| `effect_committed` | uma tool IRREVERSÍVEL rodou e o turno falhou depois (`outcome = unsafe_to_retry`, produzido por `decideTurnAction`) | **BLOQUEIA** |
| `model` | o LLM expirou, recusou, ou devolveu algo que não parseia | libera |
| `transport` | a resposta estava pronta e o ENVIO falhou | libera |
| `infrastructure` | banco, Redis, fila, lease | libera |
| `operator` | um humano cancelou | libera |
| `unknown` | não classificado | libera |

O `outcome` DOMINA o código de erro, e a razão decide a fatia: `unsafe_to_retry`
é produzido por `decideTurnAction` (`src/agent/turn-outcome.ts`) exatamente
quando `delivery.sideEffectsCommitted` é verdade — a plataforma SABE, por um
fato durável, que uma tool irreversível rodou. O código que acompanha é o motivo
da SAÍDA do ReAct (`reasoner_failed`, `outbound_failure`), que classificaria como
`model` ou `transport` e apagaria a única informação que importa.

**Por que só `effect_committed` no default, e por que isso merece ser
contestado.** As outras categorias têm causa COMPARTILHADA e transitória: um
incidente de LLM ou de rede que bloqueasse pararia milhares de conversas ao
mesmo tempo, com desbloqueio manual uma a uma — trocar uma degradação por uma
parada, com trabalho de recuperação que cresce com o tráfego. `effect_committed`
é a única em que a conversa já está semanticamente quebrada ANTES de a política
decidir. `unknown` ficou de fora porque é o destino de todo código novo (uma
tool nova, um erro de provedor novo): incluí-la faria a plataforma bloquear
conversas por causa de uma OMISSÃO da tabela de classificação, e o sintoma seria
conversas paradas depois de um deploy que não mexeu na política. Quem prefere o
outro lado escreve `TURN_POISON_BLOCK_CATEGORIES=effect_committed,unknown`.

Uma categoria com erro de digitação **reprova o boot**. É deliberado: silenciada,
ela produziria um dashboard sem bloqueio nenhum porque não HÁ bloqueio nenhum, e
a leitura natural seria "não aconteceu nenhum caso" em vez de "a política está
desligada" — indistinguível de sucesso.

### 14.2 A interdição, e o que ela é no banco

Uma linha ATIVA (`unblocked_at IS NULL`) em `agent_stream_blocks` (migration
`133`). Enquanto ela existir, **todo** claim daquela conversa é recusado com
`stream_poisoned`, o recovery não a enumera e a promoção não elege ninguém nela.

O bloqueio é gravado na **MESMA transação** do CAS terminal, e **antes** da
eleição da promoção. A ordem não é estética: a eleição carrega
`streamNotPoisoned`, então inserir primeiro faz a promoção ver a interdição que a
própria conclusão acabou de criar. Invertê-las produziria o pior estado possível
— conversa bloqueada E sucessor acordado —, e o defeito seria invisível: o job
acordaria, o claim recusaria, e o único sintoma seria um `promoted` que não
corresponde a fila nenhuma.

`agent_stream_blocks_active_uq` `(tenant_id, agent_id, stream_key) WHERE
unblocked_at IS NULL` é o que faz "no máximo UMA interdição por conversa" ser
propriedade do banco: duas conclusões terminais simultâneas produzem uma linha e
um `ON CONFLICT DO NOTHING`.

### 14.3 As conversas interditadas, e como desbloquear

```bash
npm run dlq -- blocks
```

Lista cross-tenant, ordenada pela mais antiga, com o `backlog` de cada uma — que
é o número que decide prioridade: 40 turnos presos é incidente de usuário, zero é
faxina.

```bash
npm run dlq -- unblock-stream <turn_id> --reason "<motivo>" [--actor <quem>]
```

`--reason` é OBRIGATÓRIO: ele vai para a `audit_log` `stream_unblocked` E para o
CHECK da migration 133, que recusa um desbloqueio sem autor e sem justificativa.

O comando faz quatro coisas, nesta ordem: resolve o dono pela fronteira de
confiança (o operador digita um `turn_id`, nunca um tenant), faz o CAS do
desbloqueio, AUDITA, e só então re-arma o head. Dois operadores simultâneos
produzem um desbloqueio e um `not_blocked` — e o segundo **não** audita.

**O turno ENVENENADO continua em `dead_letter`, de propósito.** Desbloquear e
ressuscitar são decisões diferentes com riscos diferentes: liberar a conversa
deixa as mensagens SEGUINTES andarem; replayar o turno morto reexecuta um
trabalho que já pode ter aplicado metade de um efeito irreversível. Quem quer as
duas roda `unblock-stream` e depois `replay-turn`, nessa ordem.

Consulta direta, quando o CLI não estiver à mão:

```sql
SELECT b.id, b.tenant_id, b.agent_id, b.category, b.error_code,
       b.blocked_by_turn_id, b.blocked_at
  FROM agent_stream_blocks b
 WHERE b.unblocked_at IS NULL
 ORDER BY b.blocked_at;
```

**Nunca** desbloqueie com `UPDATE agent_stream_blocks SET unblocked_at = now()` à
mão: isso pula a auditoria e o re-arme do head, e a conversa fica liberada sem
que ninguém a acorde até o varredor passar.

### 14.4 Replay manual: a ordem já comprometida

`replay-turn` agora RECUSA quando existe turno POSTERIOR na mesma stream que já
chegou a estado terminal — isto é, quando a plataforma já respondeu (ou já
descartou) uma mensagem posterior àquela. Devolver o turno morto à fila ali o
executaria depois de algo que o usuário já viu.

```
replay RECUSADO para <id>: a ordem desta conversa já está COMPROMETIDA —
3 turno(s) POSTERIOR(es) da mesma stream já chegaram a estado terminal.
```

A recusa é **permanente** até alguém decidir o contrário; a remediação não é
tentar de novo:

```bash
npm run dlq -- replay-turn <turn_id> --reason "<motivo>" --reconcile
```

`--reconcile` é o "modo de replay/reconciliação explícito" que a issue-mãe exige.
Ele é auditado com row PRÓPRIA (`turn_replay_reconciled`), e não só com um campo
de metadata: é a única evidência de que a plataforma processou algo fora da ordem
que já havia entregue, e uma consulta de rotina sobre `turn_replayed` a filtraria
fora sem querer.

Um posterior ainda VIVO (não terminal) **não** compromete nada e não recusa nada
— ele será recusado com `not_head` assim que o turno replayado voltar a ser o
head, que é o protocolo funcionando.

O guarda mora no `WHERE` do `UPDATE` do replay, não numa consulta anterior: entre
um `SELECT count` e o `UPDATE` um sucessor pode concluir, e o replay atravessaria
a ordem tendo acabado de verificar que não a atravessaria.

### 14.5 Fairness, starvation e o que os números querem dizer

| Sinal | Onde | Leitura |
|---|---|---|
| `maia_stream_head_age_seconds` | `/metrics` | idade do head MAIS VELHO. É o pior caso, e é isso que fairness mede — uma média com 10 mil conversas instantâneas e uma parada há duas horas fica excelente e esconde o usuário abandonado. Sobe e não volta = conversa presa; cruze com `maia_stream_blocked_total{reason}` |
| `maia_stream_head_age_p95_seconds` | `/metrics` | o PAR do anterior. Sem ele, "uma conversa presa" e "a plataforma toda atrasada" produzem o mesmo máximo |
| `maia_stream_turn_wait_seconds` | `/metrics` | histograma da espera de quem JÁ COMEÇOU, medida pelo relógio do BANCO no claim. Baldes em SEGUNDOS, com cortes nos marcos reais (120s = varredor, 300s = starvation, 900s = teto do backoff): um quantil que cruza um corte diz QUAL mecanismo domina a espera |
| `maia_stream_active_total` | `/metrics` | conversas com turno ATIVO agora. Com head-of-line cada stream ocupa no máximo UMA vaga, então este número é literalmente "quantas conversas distintas estão sendo atendidas em paralelo". Preso em 1 com `live_total` alto = serialização |
| `maia_stream_live_total` | `/metrics` | o DENOMINADOR do anterior. Sem ele, `active_total` não distingue "há pouco trabalho" de "o escalonador parou" |
| `maia_stream_backlog_max` | `/metrics` | maior backlog de uma ÚNICA conversa. É o número em que se calibra um limite, se ele um dia for necessário — ver abaixo |
| `maia_stream_starvation_total` | `/metrics` | EPISÓDIOS (não amostras) de head parado além de `TURN_STREAM_STARVATION_AFTER_MS`. Ver a nota do atraso de um scrape |
| `maia_stream_poisoned_streams` | `/metrics` | conversas interditadas AGORA. Cada ponto é uma conversa que NENHUM mecanismo automático destrava; não voltar a zero é trabalho de operador acumulando |
| `maia_stream_poison_total{category,disposition}` | `/metrics` | a DECISÃO da política. `{category="effect_committed",disposition="release"}` crescendo significa que alguém tirou a categoria da lista e a plataforma está seguindo conversas por cima de efeitos irreversíveis pela metade |
| `stream_poisoned` / `stream_unblocked` | `audit_log` | a decisão e o seu desfazimento, com `category`, `actor` e `operator_reason`. Nenhuma carrega `stream_key` |
| `turn_replay_refused` / `turn_replay_reconciled` | `audit_log` | a invariante HONRADA e a invariante ATRAVESSADA. `metadata.committed_after` diz atrás de quantos turnos já concluídos o operador inseriu trabalho |

**Duas propriedades destas séries que não são óbvias e mordem quem não as
souber:**

* **`starvation_total` atrasa um scrape.** `renderPrometheus` emite os
  CONTADORES antes de rodar os providers de GAUGE, e quem detecta starvation é o
  provider. O scrape que DETECTA ainda mostra o valor anterior; quem mostra o
  incremento é o seguinte. Num scrape de 15s isso é irrelevante para alerta e
  fatal para quem confere à mão uma vez só;
* **a deduplicação é em MEMÓRIA e morre com o processo.** Uma conversa ainda
  faminta depois de um restart é contada de novo. É recontagem, não invenção — a
  conversa ESTÁ faminta —, e fechar isso exigiria persistir estado de métrica a
  cada scrape numa tabela quente.

**Limite de backlog por stream: MEDIDO, não APLICADO.** A issue-mãe pede "limites
de backlog por stream e política de pressão". `maia_stream_backlog_max` entrega a
medição; o limite não é aplicado, e a razão é que a única pressão possível no
ingresso seria RECUSAR mensagem de usuário do WhatsApp — perda de dado, para
proteger a plataforma de um backlog que na prática é limitado pelo próprio
usuário (ninguém digita mil mensagens enquanto espera). Se algum dia a série
mostrar backlogs que justifiquem um limite, o número para calibrá-lo já está lá.

**O que a medição mostrou, contra PostgreSQL real** (`tests/integration/turn-stream-fairness-real-db.spec.ts`,
impresso a cada rodada): com 4 vagas, 25 turnos numa conversa quente e 20
conversas de um turno — e os 25 jobs da quente entrando na fila ANTES dos outros,
o pior caso — as conversas pequenas terminam com mediana de posição 11 de 45.
Sem fairness elas sairiam todas depois do turno 25. E, com o head de uma
conversa segurado por um worker vivo durante toda a rodada, as outras 30
terminam INTEIRAS: a conversa lenta não serializa o tenant nem o agente.

### 14.6 Conversa que não anda: a árvore completa

Rode a consulta da §11.3 e, ANTES de ler a primeira linha, pergunte se a conversa
está interditada:

```sql
SELECT id, category, error_code, blocked_by_turn_id, blocked_at
  FROM agent_stream_blocks
 WHERE tenant_id = $1 AND agent_id = $2 AND stream_key = $3
   AND unblocked_at IS NULL;
```

| Sintoma | Causa | Remediação |
|---|---|---|
| linha em `agent_stream_blocks`, claim recusa `stream_poisoned` | política de poison interditou | §14.3 — **nada** acontece sem um humano |
| head `retryable` com `next_attempt_at` no futuro | backoff em aberto | **nada.** "Backoff não autoriza ultrapassagem silenciosa"; a conversa espera |
| head `outbound_pending` | outbox travado | runbook do outbox (#506) |
| head `queued` com `promoted_at` antigo | wake-up perdido | §12.3 |
| head `claimed`/`running`, lease no futuro, heartbeat recente | worker saudável | **nada** |

`stream_poisoned` e `stream_blocked` NÃO são sinônimos, e é a distinção mais
importante das cinco: `stream_blocked` é "espere o outbox"; `stream_poisoned` é
"NADA vai acontecer sem um humano". Nenhum worker, nenhum varredor, nenhuma
promoção e nenhuma quantidade de tempo destravam uma conversa interditada.

### 14.7 Poison message: o roteiro

1. `npm run dlq -- blocks` — quantas conversas, há quanto tempo, com que
   backlog;
2. para cada uma, leia o turno envenenado:

   ```sql
   SELECT status, outcome, attempt_count, last_error_code, last_error_summary,
          first_ingress_seq, dead_lettered_at
     FROM agent_turns WHERE id = $1;
   ```

3. **decida sobre o EFEITO antes de decidir sobre a fila.** `category =
   'effect_committed'` significa que uma tool irreversível rodou e ninguém sabe
   o que ficou aplicado. Concilie no sistema externo primeiro;
4. `npm run dlq -- unblock-stream <turn_id> --reason "<o que você conciliou>"` —
   a conversa volta a andar, o turno continua morto;
5. se — e só se — o trabalho do turno morto ainda precisar acontecer,
   `npm run dlq -- replay-turn <turn_id> --reason "..."`. Ele passa pelo guarda
   de ordem comprometida; se recusar, pare e leia a §14.4 antes de usar
   `--reconcile`.

Nunca pule o passo 3 porque o passo 4 é rápido. A interdição existe exatamente
para comprar esse tempo.

### 14.8 Rollout e rollback

Ordem obrigatória do deploy:

1. `npm run db:migrate` (aplica a `133` — tabela NOVA e vazia, sem
   `CONCURRENTLY`, num envelope `BEGIN`/`COMMIT`, portanto **sem** a armadilha
   de índice inválido da §10.4);
2. suba o código com `TURN_POISON_BLOCK_CATEGORIES=effect_committed` (o
   default).

Subir o código antes da migration **não** é seguro: o INSERT da interdição
referencia a tabela, e sem ela toda conclusão de turno envenenado da categoria
bloqueante falha — e falha DENTRO da transação do CAS terminal, então o turno
nem morre.

O kill switch é a configuração, não a migration:

```
TURN_POISON_BLOCK_CATEGORIES=      # lista VAZIA + restart
```

Com ela vazia nenhum bloqueio NOVO nasce e a conclusão volta ao comportamento da
#627. Ela **não** desfaz interdições existentes — quem as desfaz é
`npm run dlq -- unblock-stream`, que é operação auditada. Isso é deliberado: uma
conversa que um humano interditou não pode voltar a andar porque alguém mexeu
numa variável de ambiente.

**Ordem obrigatória de um rollback de verdade:**

1. `TURN_POISON_BLOCK_CATEGORIES=` (vazio) e restart das réplicas;
2. confirme que não há interdição ATIVA — cada uma é uma conversa parada que o
   `_down` faria voltar a andar SEM ninguém ter decidido isso:

   ```sql
   SELECT count(*) FROM agent_stream_blocks WHERE unblocked_at IS NULL;
   ```

   Zero é o esperado. Cada linha devolvida deve sair pelo caminho normal;
3. só então `migrations/133_agent_stream_blocks_down.sql`.

O `_down` apaga o HISTÓRICO inteiro de envenenamento, inclusive os bloqueios já
resolvidos — que são o que responde "esta conversa já parou por isto antes?".
Não há como preservá-lo derrubando a tabela.

O guarda de ordem do replay e as métricas de fairness **não** têm kill switch, e
não precisam: o primeiro só age numa operação manual (e tem `--reconcile` como
saída explícita), e as segundas são leitura.

Ordem no rollback COMPLETO do protocolo de stream: `133` → `130` → `127` →
`126` → `124` → `122` → `120`.

## 15. Commit transacional da resposta (#631, fatia B da #506)

### 15.1 O que mudou, em uma frase

A resposta do turno é **commitada no outbox durável antes** de qualquer chamada
ao canal, na MESMA transação que move o turno para `outbound_pending`. Se a
transação falhar, **nenhuma mensagem é enviada**.

Isso inverte a política anterior, que estava escrita no código como *"liveness >
strict dedupe"*: um blip do PostgreSQL deixava a mensagem sair assim mesmo. A
partir daqui ele faz a resposta **não sair**, e o turno vira `retryable`.

### 15.2 O sintoma novo, e como distingui-lo

| Sinal | Significado |
|---|---|
| `maia_outbound_commit_rejected_total{reason="db_error"}` subindo | O banco está indisponível/lento no caminho de saída. Usuários não estão recebendo resposta. **É incidente de PostgreSQL, não de WhatsApp** — a fila e a sessão estão bem. |
| `...{reason="stale_claim"}` | Takeover: um worker perdeu a lease e foi recusado ao tentar commitar. Sozinho **não** é incidente — é o fencing funcionando. Crescimento sustentado = takeover falso; veja §6 (TTL × heartbeat). |
| `...{reason="state_mismatch"}` | O turno andou de versão entre a leitura e o commit. Raro; investigue escrita concorrente no mesmo turno. |
| `...{reason="ownership_lost"}` | Recusa em memória, antes de ir ao banco (a lease já era conhecida como morta). Mesma leitura de `stale_claim`. |
| `maia_outbound_committed_total{kind}` | Intenções de resposta comprometidas, por tipo de payload. A **distância** entre esta série e a de recusas é o custo real da troca liveness↔durabilidade. |

Log correlato: `outbound.commit_failed_send_blocked` (com `ops_alert: true`,
`turn_id`, `sequence_in_turn`, `payload_type`) e `outbound.committed` no sucesso.

### 15.3 Rollback de feature

`FEATURE_OUTBOUND_DURABLE_COMMIT=false` devolve o comportamento anterior
(envio sem commit prévio). **Ela é RECUSADA no boot no profile `production`** —
propositalmente: uma garantia de durabilidade que pode ser desligada em produção
é o caminho fail-open com outro nome. Em staging o boot passa com AVISO; em
development é silencioso.

Consequência operacional que precisa estar clara antes de um incidente: **não
existe alavanca de produção para "só desta vez, mande mesmo sem registrar"**. Se
o PostgreSQL está fora, a resposta não sai — e o turno fica recuperável. A
alavanca é consertar o banco.

A flag também exige `FEATURE_TURN_STATE_MACHINE` ligada; a combinação inversa é
recusada no contrato como INERTE (sem `turn_id` não há row de outbox
exprimível — a FK composta da migração 121).

### 15.4 Turno em `outbound_pending` com linha `pending`

É o estado normal entre o commit e a entrega. **Nunca rearme pelo recovery de
turno** (§3): `outbound_pending` está fora de `RECOVERABLE_TURN_STATUSES` de
propósito — a resposta já foi comprometida e uma nova execução do ReAct a
duplicaria.

Enquanto o delivery worker de #632 não existe, quem entrega é o mesmo processo
que commitou, e ele fecha a linha com o desfecho (`delivered`,
`delivery_unknown` ou `retryable`). Uma linha que fica `pending` por muito tempo
significa que o processo morreu entre o commit e o registro do desfecho: ela é
selecionável por

```sql
SELECT id, turn_id, status, attempt, next_attempt_at
  FROM outbound_messages
 WHERE tenant_id = $1 AND agent_id = $2
   AND status IN ('pending', 'retryable')
   AND next_attempt_at <= now()
 ORDER BY next_attempt_at
 LIMIT 50;
```

que é o predicado de `idx_outbound_messages_ready`. **Não reenvie manualmente
uma linha `delivery_unknown`**: ela significa "o transporte lançou depois de
iniciar o envio", e o reenvio cego é o duplo envio. A reconciliação é #633.
