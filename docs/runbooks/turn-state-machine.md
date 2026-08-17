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

## 2. Rollout (ordem obrigatória)

1. `npm run db:migrate` — aplica 096 (índices `CONCURRENTLY` em `mensagens`) e
   097 (tabelas). A 096 **não** roda em transação; se ela falhar no meio, o
   índice fica `INVALID` — rode o `_down` da 096 e reaplique.
2. Deploy com `FEATURE_TURN_STATE_MACHINE=true` (padrão) e
   `FEATURE_TURN_STATE_AUTHORITATIVE=false` (padrão). Nesse ponto o turno é
   **shadow**: escreve, mede, não decide. Comportamento observável idêntico ao
   anterior.
3. `npm run backfill:turns` — em lotes, idempotente, resumível.
   `npm run backfill:turns -- --dry-run` mostra o volume antes.
4. Observe `maia_turn_legacy_projection_mismatch_total` por pelo menos um ciclo
   de retenção. Ver §4 para o que fazer com divergência.
5. Só então ligue `FEATURE_TURN_STATE_AUTHORITATIVE=true`. A partir daí o
   recovery elege por estado — e turnos `retryable` (timeout de reasoner, falha
   pre-send) voltam para a fila em vez de morrerem silenciosamente.
6. Mantenha o dual-write por, no mínimo, uma janela de rollback completa.
   `mensagens.processada_em` **não** é removido nesta fase.

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

```ts
import { replayDeadLetteredTurn } from '@/runtime/turns/index.js';
await replayDeadLetteredTurn({ turn_id, actor: 'ops:<seu-usuario>', reason: '<por quê>' });
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
| `maia_turn_effect_blocked_total{boundary}` | A posse acabou NO MEIO da execução e um limite de efeito foi cancelado antes de agir: `tool_dispatch`, `outbound_send` ou `react_iteration`. | Sozinho não é incidente — é o cancelamento local funcionando, e sempre vem depois de um `turn_lease_lost` do mesmo turno. Crescimento sustentado significa takeover falso: veja o TTL. |

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

Ordem obrigatória:

1. `npm run db:migrate` (migration **114**);
2. deploy do código com `FEATURE_TURN_CLAIM=false` — nada muda;
3. confirme `TURN_LEASE_TTL_MS` acima da duração p99 do turno (`maia_turn_duration_ms`);
4. ligue `FEATURE_TURN_CLAIM=true`;
5. observe por uma janela: `maia_turn_lease_lost_total{reason="token_mismatch"}`
   próximo de zero é o sinal de que o TTL está bem dimensionado.

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

## 7. Rollback

**De aplicação** — volte o código; mantenha as tabelas; mantenha o dual-write
enquanto houver versão mista rodando. `processada_em` nunca deixou de ser
escrito, então o caminho legado está íntegro.

**De feature** — `FEATURE_TURN_STATE_AUTHORITATIVE=false` devolve a decisão ao
campo legado imediatamente. `FEATURE_TURN_STATE_MACHINE=false` desliga também a
escrita. Nenhum turno ou outcome já gravado é apagado.

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
