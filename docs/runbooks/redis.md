# Redis — runbook operacional

Como operar o Redis da Maia em produção: política de memória obrigatória,
sizing, sinais de pressão, e o que NÃO mexer.

> **TL;DR**: `--maxmemory-policy noeviction` (default deste compose) ou
> `volatile-lru`. **Nunca** `allkeys-*`. Veja §1.

---

## 1. Por que `noeviction` é obrigatório (isolamento multi-tenant)

A Maia hospeda múltiplos tenants no mesmo Redis. O isolamento entre tenants
é feito **por prefixo de chave** (`tenant_id+agent_id` em working memory,
rate-limit, dedup de mensagem, debouncer, vision cache, etc.). Esse
scoping já está **merged em `main`** — cada caller crítico deriva o prefixo do
`runWithTenantContext` e falha alto (`MissingTenantContextError`) se o
contexto estiver ausente (PRs #245/#252/#253/#257/#258/#259/#264/#272, todas
mergeadas). Isso resolve leitura/escrita cruzada mas **não** protege contra o
evictor do Redis — daí esta política.

> **Nota — idempotency é Postgres, não Redis.** O *ledger* de idempotência de
> tool/outbound NÃO mora no Redis: a idempotência de tool fica na tabela
> `idempotency_keys` (`idempotencyRepo` em `src/db/repositories.ts`) e o ledger
> de entrega outbound na tabela `outbound_messages` (`outboundMessagesRepo`,
> serializado por `pg_advisory_xact_lock` — issue #227). A única camada de
> "já visto" no Redis é o **dedup de mensagem de gateway**
> (`src/gateway/dedup.ts`, chaves `dedup:msg:…` com TTL de 24h e *fallback*
> para Postgres via `mensagensRepo.findByWhatsappId`). Portanto a pressão de
> memória / OOM do Redis **não** ameaça a idempotência — só o dedup de gateway,
> que degrada para o fallback Postgres.

Sob pressão de memória, a política `maxmemory-policy` decide o que fazer:

| Política | O que faz | Multi-tenant safe? |
|---|---|---|
| `noeviction` | Falha o write com erro `OOM` | **SIM** — falha alta e clara |
| `volatile-lru` / `volatile-lfu` / `volatile-ttl` / `volatile-random` | Só evicta chaves com TTL explícito | **SIM** (com cuidado) — TTLs devem ser por-tenant |
| `allkeys-lru` / `allkeys-lfu` / `allkeys-random` | Evicta qualquer chave, incluindo de outros tenants | **NÃO** — vetor de eviction cross-tenant |

**Cenário ruim** com `allkeys-lru`:

1. Tenant A escreve working memory pesada (1.8 GB).
2. Redis aproxima do `maxmemory` (2 GB).
3. Tenant B escreve uma nova chave.
4. LRU global escolhe a chave mais antiga — que pode ser do tenant A.
5. Working memory do tenant A some sem aviso. Próxima leitura tem cache miss
   e o agente perde estado de conversa que deveria existir.

Mesmo se o prefixo de chave estiver correto, a eviction olha só `idletime`,
não o tenant.

**Por que `noeviction` em vez de `volatile-lru`?**

Hoje nem todas as chaves Redis carregam TTL — o BullMQ guarda jobs sem TTL.
(As chaves de working memory **carregam** TTL: tanto a chave de dados quanto a
de marker expiram em `MESSAGES_TTL_SECONDS`; ver §4.6.) Em `volatile-lru` sob
pressão, o Redis evicta só o subset com TTL e ainda falha o write quando esgota
esse subset — o pior dos dois mundos para o caller, sem o sinal claro de OOM.
`noeviction` falha cedo e ruidosamente, deixando o operador decidir entre
aumentar `maxmemory`, baixar TTL, ou shardar Redis por tenant.

`volatile-lru` é aceitável **se** auditar que todas as chaves com vida útil
> 1h carregam TTL apropriado — manter a documentação aqui se mudar.

---

## 2. Config no `docker-compose.yml`

O bloco relevante do `docker-compose.yml` (`services.redis`) é snapshotado
aqui literalmente, para que a política seja **verificável junto com as
métricas** (§4) sem precisar abrir outro arquivo:

```yaml
# docker-compose.yml → services.redis
redis:
  image: redis:7-alpine
  container_name: maia-redis
  restart: unless-stopped
  command:
    - "redis-server"
    - "--appendonly"
    - "yes"
    - "--maxmemory"
    - "2gb"
    - "--maxmemory-policy"
    - "noeviction"
```

> **⚠️ Sync obrigatório (compose ↔ runbook).** Se `services.redis.command` no
> `docker-compose.yml` mudar (cap diferente, política diferente), **atualize
> este bloco junto** — caso contrário a tabela de alertas (§4) e o gate
> `/readyz` ficam descrevendo uma política que não está mais ativa.

Com o cap ativo (`--maxmemory 2gb` + `--maxmemory-policy noeviction`),
`redis_maxmemory_bytes` reporta `2147483648` e `redis_memory_used_ratio`
passa a ser significativo (0..1), habilitando os alertas de §4 e o gate
`/readyz`. Se o cap for removido (`maxmemory 0`), o ratio reporta `0` e o
gate nunca dispara — comportamento seguro e correto para "sem cap
configurado" (ver §4, nota sobre `maxmemory=0`).

Para deploys gerenciados (Coolify, AWS ElastiCache, Upstash, etc.):
configurar o equivalente no painel/Terraform. **Não** aceitar default do
provider se ele for `allkeys-lru` (Upstash, por exemplo, default é
`allkeys-lru` no plano free — confirmar antes de produção).

Conferir a política ativa em runtime:

```bash
docker exec maia-redis redis-cli CONFIG GET maxmemory
docker exec maia-redis redis-cli CONFIG GET maxmemory-policy
```

Saída esperada:

```
1) "maxmemory"
2) "2147483648"        # 2 GB
1) "maxmemory-policy"
2) "noeviction"
```

---

## 3. Sizing — 2 GB é suficiente?

Estimativa atual (~todas chaves são prefixadas por tenant+agent):

| Coisa | Order of magnitude |
|---|---|
| Working memory por conversa ativa | ~50-200 KB |
| BullMQ jobs (queue + completed/failed buffers) | ~100 KB-1 MB total |
| Dedup de mensagem de gateway (`dedup:msg:…`, TTL 24h) | ~50 bytes por mensagem vista |
| Rate-limit buckets | ~100 bytes por (tenant, agent, IP) |

> O ledger de idempotência de tool/outbound **não** entra nesta conta — ele
> é Postgres (`idempotency_keys` / `outbound_messages`), não Redis.

Cenário ruim para 1 tenant ativo: ~50 conversas concorrentes × 200 KB = 10 MB.

Mesmo com 100 tenants ativos, 2 GB é confortável — o teto real é exposto por
algum bug de leak (e.g. working memory crescendo sem `EXPIRE`), não pelo
volume orgânico. Se `used_memory` passar de 1 GB sustentado, abrir
investigação **antes** de aumentar `maxmemory`.

Para subir o teto:

```yaml
command:
  - "redis-server"
  - "--maxmemory"
  - "4gb"        # ou o valor desejado
  - ...
```

E redeploy. Não há necessidade de drop de dados — `redis-server` aceita o
novo `maxmemory` imediatamente; chaves existentes ficam.

### 3.1 Persistência (AOF) e interação com `maxmemory`

Esta config roda **AOF-only** (`--appendonly yes`) e deixa o RDB snapshotting
(`--save`) no **default do Redis 7** (snapshots periódicos por número de
mudanças). Decisão consciente para esta entrega:

- **AOF** é a garantia primária de durabilidade (perde no máximo ~1s de writes
  em crash, com `appendfsync everysec` default).
- **`maxmemory` conta a memória do dataset**, não o tamanho do arquivo AOF no
  disco. Sob `noeviction`, o gatilho de OOM é o dataset em RAM — rewrite de AOF
  (`BGREWRITEAOF`) usa um fork copy-on-write que pode dobrar transitoriamente o
  uso de RAM; em pressão alta isso aproxima o limite. Por isso §4 monitora
  `used_memory_peak`.

**Fora de escopo desta PR:** tuning explícito de `--save` (latency-spike
policy do RDB fork) e/ou `appendfsync always` são uma decisão de persistência
separada — abrir PR dedicada se o perfil de durabilidade/latência exigir. Esta
PR só fixa a política de eviction; não altera a política de persistência.

---

## 4. Sinais de pressão — métricas Prometheus + alertas

A Maia expõe gauges de pressão de memória do Redis via `/metrics`
(coletor em `src/observability/redis-memory-collector.ts`, registrado em
`src/server.ts`). O coletor faz `INFO memory` + `INFO stats` a cada 15s
e cacheia os valores; as gauges são pull-based via
`src/lib/metrics.ts:setGaugeProvider` (custo zero entre scrapes).

### 4.1 Métricas expostas

| Métrica | Tipo | Origem (Redis INFO) | Significado |
|---|---|---|---|
| `redis_used_memory_bytes` | gauge | `memory.used_memory` | Bytes em uso agora |
| `redis_maxmemory_bytes` | gauge | `memory.maxmemory` | Cap configurado (0 = unbounded) |
| `redis_memory_used_ratio` | gauge | derivado (`used / max`) | Pressão relativa (0..1) |
| `redis_evicted_keys_total` | gauge | `stats.evicted_keys` | Cumulativo de evictions desde restart |
| `redis_rejected_connections_total` | gauge | `stats.rejected_connections` | Cumulativo de rejected connections |

> **Sem labels.** Todas Redis-wide — não há `tenant_id`/`agent_id` aqui.
> Atribuição por-tenant de memória exigiria Redis expor accounting por
> prefixo de chave (ele não expõe). Counters por-tenant vivem nas camadas
> que usam Redis (working memory, cache layer, etc.).

> **Quando `maxmemory=0` (Redis sem cap)** a gauge `redis_memory_used_ratio`
> reporta `0` em vez de `Infinity`/`NaN` — alertas em `> 0.80` / `> 0.95`
> não disparam espúrios. O sinal primário "sem cap configurado" é
> `redis_maxmemory_bytes 0` direto. Com a política de §2 ativa o cap é
> `2147483648` e o ratio passa a ser significativo.

> **`evicted_keys` DEVE ficar em 0 com `noeviction`.** Se `redis_evicted_keys_total`
> subir, alguém mudou a política em runtime (`CONFIG SET`) — investigar
> `audit_log` ou histórico de deploy (o alerta `RedisEvictionDetected` abaixo
> dispara nesse caso).

### 4.2 Regras Prometheus / Alertmanager (config real, versionada)

As regras **não são apenas sugestões textuais** — vivem como config
versionada em **[`monitoring/alerts/redis.rules.yml`](../../monitoring/alerts/redis.rules.yml)**
(carregável diretamente pelo Prometheus). Resumo:

| Alerta | `expr` | `for` | Severidade |
|---|---|---|---|
| `RedisMemoryPressureWarning` | `redis_memory_used_ratio > 0.80` | 5m | warning |
| `RedisMemoryPressureCritical` | `redis_memory_used_ratio > 0.95` | 1m | critical |
| `RedisEvictionDetected` | `redis_evicted_keys_total > 0` | 1m | critical |
| `RedisEvictionRising` | `increase(redis_evicted_keys_total[5m]) > 0` | 1m | critical |
| `RedisRejectedConnectionsRising` | `increase(redis_rejected_connections_total[5m]) > 0` | 5m | warning |

> **Sync obrigatório.** Os thresholds `0.80`/`0.95` aparecem em 3 lugares e
> precisam mudar juntos: este arquivo de regras, `CRITICAL_MEMORY_USED_RATIO`
> em `src/observability/redis-memory-collector.ts` (usado pelo gate `/readyz`)
> e esta tabela. Se editar um, edite os três.

#### Como ativar estas regras

O Prometheus carrega regras via `rule_files`. Monte o arquivo read-only no
container do Prometheus e referencie-o:

```yaml
# prometheus.yml (no deploy do Prometheus)
rule_files:
  - /etc/prometheus/rules/redis.rules.yml

scrape_configs:
  - job_name: maia
    metrics_path: /metrics
    static_configs:
      - targets: ['app:3000']   # serviço `app` do docker-compose.yml
```

```yaml
# serviço prometheus no compose de observabilidade (exemplo)
prometheus:
  image: prom/prometheus
  volumes:
    - ./prometheus.yml:/etc/prometheus/prometheus.yml:ro
    - ./monitoring/alerts/redis.rules.yml:/etc/prometheus/rules/redis.rules.yml:ro
```

> **Nota de deploy.** Este repositório expõe `/metrics` (in-house, sem
> `prom-client`) mas **não embarca** um container Prometheus no
> `docker-compose.yml` principal — o scrape/alerting roda na stack de
> observabilidade do ambiente (Coolify/k8s/Prometheus gerenciado). O arquivo
> de regras é o artefato versionado que essa stack consome; as instruções
> acima são o contrato de wiring.

### 4.3 Sinais correlacionados (não dependem deste coletor)

Já expostas por `src/server.ts`:

- `maia_redis_connected` (gauge 0/1) — coletor degrada para "última leitura
  conhecida" se Redis cair; `maia_redis_connected=0` é o sinal canônico.
- `/health/redis` — health endpoint Fastify (`connected + PING`). Probe de
  componente, não decide rotação de LB.
- **`/readyz`** — **gate de readiness para o load balancer** (issue #297).
  Retorna **`503` (não-pronto)** quando `redis_memory_used_ratio > 0.95`,
  caso contrário `200`. Sob `noeviction` (ver §1) a pressão crítica vira
  write failure; tirar a instância de rotação **antes** disso evita que o
  incident cascateie (BullMQ → DLQ, working memory → cache miss). Implementação:
  `checkReadiness()` em `src/lib/healthcheck.ts`, lê o ratio do snapshot
  cacheado do coletor (sem round-trip ao Redis). O threshold `0.95` =
  `CRITICAL_MEMORY_USED_RATIO` (mesma constante do alerta
  `RedisMemoryPressureCritical`).

  ```bash
  # 200 quando saudável, 503 quando ratio > 0.95
  curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/readyz
  ```

### 4.4 Sondagem manual

```bash
docker exec maia-redis redis-cli INFO memory | \
  grep -E '^(used_memory|used_memory_peak|maxmemory|maxmemory_policy):'

docker exec maia-redis redis-cli INFO stats | \
  grep -E '^(evicted_keys|rejected_connections):'
```

Métricas relevantes:

- `used_memory` — bytes em uso agora.
- `used_memory_peak` — pico desde o último restart. Se peak ≈ maxmemory,
  você passou perto do limite.
- `evicted_keys` (do `INFO stats`) — **DEVE ficar em 0 com `noeviction`**.

Cross-check contra `/metrics`:

```bash
curl -s http://localhost:3000/metrics | grep -E '^redis_'
```

Valores devem bater (snapshot do coletor é atualizado a cada 15s).

### 4.5 Quando o app vê OOM no Redis

Sob `noeviction` (§1) um write em pressão de memória volta como
`ReplyError: OOM command not allowed when used memory > 'maxmemory'`. **#309
(MERGED)** trata esse erro de forma homogênea em cada caller crítico, em vez de
propagar um `ReplyError` cru que derrubaria um job/HTTP. O detector único é
`isRedisOomError(err)` em `src/lib/redis.ts` (casa o prefixo `OOM` da reply,
NÃO de qualquer mensagem que contenha "oom"); cada degradação incrementa o
counter `redis_oom_degraded_total{operation}` (low-cardinality, SEM tenant_id;
atribuição por-tenant vai no log estruturado `redis.oom_degraded`) via
`recordRedisOomDegraded(caller, …)`.

Política por caller (escolhida pelo papel do caller — fail-open só onde
Postgres é a fonte de verdade e não há risco de isolamento/dupla-execução):

| Caller | Comportamento no OOM | Por quê |
|---|---|---|
| **Rate-limit** (`src/gateway/rate-limit.ts`) | **fail-closed → `silence`** (não-owner) / `allow` (owner). **Não alterado por #309** — já era OOM-safe via #245/#258. | Os dois try/catch já absorviam qualquer `ReplyError`; é o padrão de referência. |
| **Working memory** (`src/memory/working.ts`, `pushMessage`) | **fail-open: pula o write**, conta a métrica, segue. Não grava `recordWrite` (evita falso TTL-miss). | É cache; Postgres é a fonte (`mensagens`). A leitura cai no Postgres no cache miss. Chave já é tenant+agent-scoped → dropar o write não viola isolamento. |
| **Vision cache** (`src/tools/_vision-cache.ts`, `setCachedVision`) | **fail-open: pula o write**, conta a métrica. | Best-effort; a próxima chamada idêntica refaz a Vision API. Sem risco de isolamento (chave tenant+agent-scoped). |
| **Dedup de gateway** (`src/gateway/dedup.ts`, `markSeen` + backfill) | **degrada para o fallback Postgres**: engole o OOM, conta a métrica; o próximo `isDuplicate` confirma a duplicata via `mensagensRepo.findByWhatsappId` (tenant+agent-scoped). | Fail-SAFE, não fail-open: o Postgres é autoritativo, então não há risco de dupla-processamento. (Idempotência de tool/outbound é Postgres — fora do alcance do OOM; ver §1.) |
| **Bot-detection** (`src/gateway/bot-detection.ts`) | **fail-open: não bloqueia** (retorna `false`), conta a métrica. | Heurística best-effort sem fonte em Postgres; falhar o contador nunca deve bloquear um usuário legítimo. |
| **Debouncer** (`src/gateway/debouncer.ts`) | **fail-CLOSED**: converte o OOM em `DebouncerRedisUnavailableError` (`oom=true`), conta a métrica; o caller (`baileys.ts`) para e a mensagem fica persistida no Postgres, varrida por `aggregateUnprocessedTexts` no próximo ciclo. | "Pular o debounce e seguir" silenciosamente poderia perder a mensagem ou armar um job BullMQ sem o estado Redis companheiro. Fail-closed preserva a mensagem sem `ReplyError` cru. |
| **Backpressure de outbox** (`src/scheduling/backpressure.ts`, `tryAcquireSendSlot`) | **fail-CLOSED**: nega com `reason: 'redis_oom'`; a linha do outbox fica `pending` e o próximo tick re-tenta (backoff). | Igual ao contrato `redis_down`: recusar enviar é melhor que arriscar burst-ban/duplo-envio no WhatsApp. |
| **BullMQ enqueue — debounced** (`src/gateway/debouncer.ts`) | **fail-CLOSED**: um OOM no `agentQueue.add` vira o mesmo `DebouncerRedisUnavailableError` (`oom=true`) acima. | O DLQ só existe para jobs que JÁ existem; uma falha no `.add` ocorre antes do job, então não há job para DLQ. |
| **BullMQ enqueue — não-debounced + recovery** (`enqueueAgent`, `src/gateway/queue.ts`) | **fail-CLOSED** (PR #324 B1): OOM no `agentQueue.add` vira `QueueRedisUnavailableError` (`oom=true`), conta `redis_oom_degraded_total{operation="enqueue_agent"}`. O caller deixa a linha do inbound `processada_em IS NULL` e `runMessageRecovery` re-enfileira no próximo sweep; o recovery worker faz `break` no primeiro OOM (não martela um Redis no teto). | Mesma razão do debounced: sem job criado, não há DLQ. Inbound já persistido (`createInbound`) → nunca perde a mensagem, nunca marca processada, nunca arma meio-estado. |

**Não-OOM nunca é invisível (PR #324 B2).** O comportamento de erro não-OOM
NÃO é uniforme entre os callers — depende do papel de cada um. O invariante é:
*nenhum erro Redis real é silenciosamente engolido, e a postura fail-closed
intencional é preservada.* Por site:

| Site | Não-OOM faz | Visibilidade |
|---|---|---|
| **Working memory — data writes** (`rpush`/`ltrim`/`expire`) | **re-lança** o erro (propaga ao caller) | a própria exceção é o sinal |
| **Working memory — marker SET** + **reads** (`set`/`lrange`/`get`) | **engole** (best-effort), segue | `recordRedisError(op)` → `working_memory_redis_error_total{op}` + log `working_memory.redis_error` |
| **Vision cache** (`setCachedVision`) | **engole** (fail-open), segue | `recordRedisError('vision_cache.set')` → `redis_error_total` + log `vision_cache.write_failed` |
| **Bot-detection** (`checkBotAndMaybeBlock`) | **engole** (fail-open, retorna `false`) | `recordRedisError('bot_detection.incr')` → `redis_error_total` + log `bot_detection.redis_failed` |
| **Rate-limit** (`checkRateLimit`, ambos os blocos) | **engole** (fail-CLOSED → `silence`/`allow`) — postura de segurança intencional, NÃO re-lança | `recordRedisError('rate_limit.zset'\|'rate_limit.overage')` → `redis_error_total` + log `rate_limit.{zset,overage}_failed` |
| **Debouncer** (`scheduleDebouncedAgent`) | **re-lança** o erro cru não-OOM (só o OOM vira `DebouncerRedisUnavailableError`) | a exceção sobe; o caller `baileys.ts` loga `baileys.debounce_failed_fail_closed` |
| **enqueueAgent** (não-debounced + recovery) | **re-lança** o erro cru não-OOM (só o OOM vira `QueueRedisUnavailableError`) | a exceção sobe; recovery loga `message_recovery.enqueue_failed` por mensagem |
| **Dedup** (`markSeen`/backfill) | **re-lança** o erro cru não-OOM (só o OOM degrada para o fallback Postgres) — `throw err` em `dedup.ts:251` (backfill) e `:303` (`markSeen`) | a exceção sobe ao caller; o dispatcher `baileys.ts` captura via `baileys.handle_failed` |
| **Backpressure — caminho principal** (`tryAcquireSendSlot`) | **re-lança** o erro cru não-OOM (só o OOM vira `reason: 'redis_oom'`) | a exceção sobe ao tick do sweeper |
| **Backpressure — limpeza do pace key** (`cleanupPaceKey`, após deny de rate-bucket) | **engole** (best-effort; a decisão do slot já foi tomada, o pace key tem TTL de 2s) — NÃO re-lança | `recordRedisError('backpressure.cleanup')` → `redis_error_total` + log `backpressure.cleanup_pace_failed` |

Resumindo: os sites **catch-all** (working-memory marker/reads, vision cache,
bot-detection, rate-limit, e a limpeza best-effort do backpressure —
`backpressure.cleanup`) agora SEMPRE emitem métrica + log no não-OOM
(`redis_error_total{operation}` ou `working_memory_redis_error_total{op}`); os
sites que **re-lançam** (working-memory data writes, debouncer, enqueueAgent,
dedup, e o caminho principal do backpressure `tryAcquireSendSlot`) deixam o
`ReplyError` cru subir para o tratamento de erro do caller. Em nenhum caso um
`WRONGTYPE`/`READONLY`/conn-reset some sem deixar rastro.

Mesmo com a degradação, um OOM é um **incidente de capacidade**: o alerta
`RedisMemoryPressureWarning`/`Critical` (§4.2) e o counter
`redis_oom_degraded_total` devem disparar a investigação — aumente `maxmemory`
(§3) e investigue o crescimento.

### 4.6 TTL de working memory e o sinal de TTL-miss

Toda escrita de working memory (`pushMessage` em `src/memory/working.ts`) grava
**duas** chaves, **ambas com o mesmo TTL** `MESSAGES_TTL_SECONDS` (24h):

| Chave | Prefixo | Onde o TTL é setado |
|---|---|---|
| Dados (buffer da conversa) | `working:${tenant}:${agent}:conv:…:messages` | `expire(key, MESSAGES_TTL_SECONDS)` após `rpush`/`ltrim` |
| Marker (TTL/colisão) | `nx_ttl:${tenant}:${agent}:conv:…:messages` | `set(markerKey, …, 'EX', MESSAGES_TTL_SECONDS)` |

Os TTLs são **alinhados de propósito** (#330): cada `pushMessage` reescreve o
marker (não-`NX`), então o marker rastreia o TTL dos dados exatamente — um
marker vivo sempre implica que os dados **deveriam** existir. É isso que torna
"leitura vazia com marker vivo" um sinal de perda precoce, não de expiração
natural.

> **Janela curta entre as duas escritas.** Os dois writes são round trips Redis
> separados, **não** uma transação — há uma janela entre o `rpush`/`expire` dos
> dados e o `set` do marker. A não-atomicidade é **aceita e documentada** no
> bloco de comentário sobre `redis.set(markerKey, …)` em `src/memory/working.ts`
> ("Marker/data NON-ATOMICITY — ACCEPTED observability window"): se o `set` do
> marker falhar **após** o write de dados, a chave fica com **dados sem
> marker** — um TTL-miss real vira **falso-negativo** (não contado) até o TTL
> de 24h dos próprios dados expirar. Sem perda de dados nem risco de
> isolamento; um `pushMessage` posterior no mesmo `conversa_id` cura a janela.

**Sinal de TTL-miss:** o alerta **`WorkingMemoryTtlMissRising`** em
[`monitoring/alerts/working-memory.rules.yml`](../../monitoring/alerts/working-memory.rules.yml)
(`rate(working_memory_ttl_miss_total[5m]) > 1` por 10m) dispara quando uma
leitura encontra o marker ainda vivo porém o buffer voltou vazio — entrada
sumiu antes da hora (eviction, crash entre `rpush` e `expire`). É por-LEITURA
(o marker não é consumido no miss), então alertamos sobre a TAXA sustentada,
não uma contagem bruta. Quase sempre correlaciona com eviction: cross-check
`RedisEvictionRising` / `RedisMemoryPressureWarning`/`Critical` (§4.2).

**O que o TTL-miss NÃO cobre** (não conte com este alerta para estes casos):

- **`FLUSHDB` total** — dados **e** marker são apagados juntos, então a leitura
  vê `marker === null` e trata como leitura fria / expiração natural. Nenhum
  `working_memory_ttl_miss_total` é incrementado (e `RedisEvictionDetected`
  também não dispara — `FLUSHDB` não é eviction). Detecte um flush por outros
  sinais: queda abrupta de `used_memory`, perda generalizada de cache, e o
  histórico de deploy / `audit_log`.
- **Dados sem TTL por falha entre `rpush` e `expire`** — se o processo morrer
  depois do `rpush` mas antes do `expire`, o buffer fica **sem TTL** (vaza até
  intervenção). Isso é uma lacuna distinta, **rastreada separadamente na issue
  #333** — não é o que `WorkingMemoryTtlMissRising` mede.

---

## 5. Não-fazer (anti-padrões)

- **Não** rodar `CONFIG SET maxmemory-policy allkeys-lru` em runtime mesmo
  "temporariamente" para mascarar OOM. Causa eviction cross-tenant
  silenciosa — ver §1.
- **Não** subir `maxmemory` sem investigar a causa do crescimento primeiro.
  Pode estar mascarando leak de TTL ausente.
- **Não** usar Redis como banco persistente para dados sensíveis. AOF
  (`appendonly yes`) protege contra perda de dados recentes em crash, mas a
  fonte de verdade continua sendo Postgres. Working memory é cache derivado
  de mensagens persistidas.
- **Não** compartilhar uma instância Redis entre Maia e outros sistemas em
  produção. O sizing acima assume todas as chaves vêm da Maia.

---

## 6. Roadmap futuro — isolamento mais forte

Quando o volume justificar (>500 tenants ativos ou tenant enterprise que
exige isolamento físico), considerar:

1. **Redis namespaces dedicados** — Redis databases (`SELECT N`) por tenant.
   Limita a 16 DBs por default, então só serve para tenants premium poucos.
2. **Redis cluster com shards por tenant** — cada slot range mapeia para um
   tenant. Mais operacional, requer reshard quando tenants crescem.
3. **Redis Enterprise multi-tenant** — managed, com isolamento de namespace
   nativo. Custo significativamente maior.
4. **Instâncias dedicadas por tenant** — última escolha (custo linear no
   número de tenants). Justificável para clientes regulados (compliance).

Hoje, `noeviction` + prefixo de chave (merged) + as métricas/alertas de §4
cobrem o caso. O OOM handling aplicativo homogêneo (#309) fecha o ciclo.
Reavaliar isolamento físico quando passarmos de ~100 tenants ativos.

---

## Apêndice — referências cruzadas

- **`docker-compose.yml`** — fonte da config (`services.redis.command`).
- **`docs/runbooks/operational.md`** — §5 DLQ, §8 métricas, `/health/redis`.
- **`src/lib/redis.ts`** — cliente compartilhado (`ioredis` com
  `lazyConnect`).
- **`src/observability/redis-memory-collector.ts`** — coletor de `INFO
  memory/stats` + gauges Prometheus (issue #297).
- **`src/server.ts`** — `startRedisMemoryCollector()` no boot + endpoints
  `/metrics`, `/health/redis`, `/readyz`.
- **`src/lib/healthcheck.ts`** — `checkReadiness()` (gate `/readyz`).
- **`src/lib/metrics.ts`** — módulo interno de Prometheus (sem `prom-client`).
- **`monitoring/alerts/redis.rules.yml`** — regras Prometheus versionadas (§4.2).
- **`monitoring/alerts/working-memory.rules.yml`** — regras de working memory
  (`WorkingMemoryTtlMissRising` etc., §4.6).
- **`src/memory/working.ts`** — working memory; TTL alinhado dados/marker e a
  janela de não-atomicidade documentada (§4.6, PR #330).
- **PRs #245/#252/#253/#257/#258/#259/#264/#272** — tenant scoping dos callers
  Redis críticos (working memory, rate-limit, dedup, debouncer, vision cache,
  pubsub, holidays cache). Todas **merged** — base do pressuposto "keys
  tenant-prefixed" deste runbook.
- **PR #294 / Issue #284** — `maxmemory 2gb` + `noeviction` no compose (gap que
  originou esta documentação: `maxmemory-policy` default + risco de config
  drift cross-tenant).
- **Issue #297** — coletor de memória + gauges Prometheus + gate `/readyz`
  (sem essas métricas, OOM sob `noeviction` vira write failure invisível).
- **#309** — OOM handling aplicativo (fail-closed / degradação em vez de
  propagar `ReplyError`) nos callers críticos (§4.5). **MERGED**: detector
  `isRedisOomError` + counter `redis_oom_degraded_total` em `src/lib/redis.ts`;
  wrappers em working memory, vision cache, dedup, bot-detection, debouncer e
  backpressure de outbox. Rate-limit já era OOM-safe e ficou intacto.
