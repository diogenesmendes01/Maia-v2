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

Hoje nem todas as chaves Redis carregam TTL (BullMQ guarda jobs sem TTL, e
algumas estruturas de working memory também). Em `volatile-lru` sob pressão,
o Redis evicta só o subset com TTL e ainda falha o write quando esgota esse
subset — o pior dos dois mundos para o caller, sem o sinal claro de OOM.
`noeviction` falha cedo e ruidosamente, deixando o operador decidir entre
aumentar `maxmemory`, baixar TTL, ou shardar Redis por tenant.

`volatile-lru` é aceitável **se** auditar que todas as chaves com vida útil
> 1h carregam TTL apropriado — manter a documentação aqui se mudar.

---

## 2. Config no `docker-compose.yml`

```yaml
redis:
  image: redis:7-alpine
  command:
    - "redis-server"
    - "--appendonly"
    - "yes"
    - "--maxmemory"
    - "2gb"
    - "--maxmemory-policy"
    - "noeviction"
```

Para deploys gerenciados (Coolify, AWS ElastiCache, Upstash, etc.):
configurar o equivalente no painel/Terraform. **Não** aceitar default do
provider se ele for `allkeys-lru` (Upstash, por exemplo, default é
`allkeys-lru` no plano free — confirmar antes de produção).

Verificar a config rodando:

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
  uso de RAM; em pressão alta isso aproxima o limite. Por isso §4.1 monitora
  `used_memory_peak`.

**Fora de escopo desta PR:** tuning explícito de `--save` (latency-spike
policy do RDB fork) e/ou `appendfsync always` são uma decisão de persistência
separada — abrir PR dedicada se o perfil de durabilidade/latência exigir. Esta
PR só fixa a política de eviction; não altera a política de persistência.

---

## 4. Sinais de pressão — o que monitorar

> **Estado da entrega (importante):** sob `noeviction`, o **primeiro sinal de
> pressão é um write falhando** — não há, nesta PR, coletor que dispare alerta
> *antes* do limite. Esta PR entrega a **camada de infraestrutura** (a política
> no compose). A observabilidade automatizada e a degradação aplicativa do OOM
> são camadas companheiras, rastreadas e ainda **não mergeadas**:
>
> | Camada | O que entrega | Status |
> |---|---|---|
> | Esta PR (#294) | `maxmemory` + `noeviction` no compose | ✅ esta entrega |
> | Coletor de memória + gauges Prometheus (#300, tracker #297) | emite `redis_used_memory_bytes`, `redis_maxmemory_bytes`, `redis_memory_used_ratio`, `redis_evicted_keys_total` e dispara os alertas abaixo | 🚧 pré-requisito (PR aberta) |
> | OOM handling aplicativo (#309) | fail-closed / degradação em vez de propagar `ReplyError` no overage path, dedup, debouncer, working memory, BullMQ | 🚧 pré-requisito (issue aberta) |
>
> Até #300 mergear, o monitoramento é **manual** (comandos abaixo). Os
> thresholds desta seção são a especificação que #300 implementa — eles não
> disparam sozinhos ainda.

### 4.1 Inspeção manual (disponível hoje)

```bash
docker exec maia-redis redis-cli INFO memory | grep -E '^(used_memory|used_memory_peak|maxmemory|maxmemory_policy):'
docker exec maia-redis redis-cli INFO stats  | grep -E '^evicted_keys:'
```

Métricas relevantes:

- `used_memory` — bytes em uso agora.
- `used_memory_peak` — pico desde o último restart. Se peak ≈ maxmemory,
  você passou perto do limite.
- `evicted_keys` (do `INFO stats`) — **DEVE ficar em 0 com `noeviction`**.
  Se subir, alguém mudou a política em runtime (`CONFIG SET`) — investigar
  `audit_log` ou histórico de deploy.

### 4.2 Alertas automatizados — especificação (implementa #300/#297)

Quando o coletor (#300) estiver merged, ele exporá os gauges acima em
`/metrics` e estas regras Prometheus passam a valer:

```
redis_memory_used_ratio > 0.80     # warning (degraded headroom)
redis_memory_used_ratio > 0.95     # critical (writes podem começar a falhar)
redis_evicted_keys_total > 0       # critical (política foi mudada em runtime)
```

Hoje, `GET /metrics` (`src/server.ts`) expõe apenas conectividade
(`maia_redis_connected`) — **não** há gauge de memória até #300. Por isso o
monitoramento atual é a inspeção manual de §4.1.

### 4.3 Quando o app vê OOM no Redis

**Estado atual (sem #309):** um `OOM` do Redis vira um `ReplyError` que a
camada chamadora propaga. Caminhos já endurecidos em `main` degradam de forma
controlada; o restante ainda propaga o erro até #309:

- **Rate-limit** (`src/gateway/rate-limit.ts`) — overage path já está em
  try/catch com **fail-closed para `silence`** em não-owner (mergeado via
  #245/#258). OOM aqui silencia o usuário em vez de derrubar o job. ✅
- **BullMQ enqueue** — falha vira erro determinístico → DLQ
  (ver `docs/runbooks/operational.md` §5). Sem retry-once dedicado até #309.
- **Dedup de mensagem de gateway** (`src/gateway/dedup.ts`) — a marcação
  "já visto" no Redis falha, mas o dedup degrada para o *fallback* Postgres
  (`mensagensRepo.findByWhatsappId`, tenant+agent-scoped): a duplicata ainda é
  detectada, só sem a fast-path do cache. (A idempotência de tool/outbound NÃO
  aparece aqui — é Postgres, fora do alcance do OOM do Redis; ver §1.)
- **Working memory** — write falha; próxima leitura tem cache miss e o agente
  reconstrói o estado das mensagens persistidas em Postgres (degradação
  graciosa, com latência extra).

#309 unifica o tratamento (fail-closed/degradação homogênea) nos callers que
ainda propagam. Até lá, trate um OOM como **incidente de capacidade**: aumente
`maxmemory` (§3) e investigue o crescimento.

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

Hoje, `noeviction` + prefixo de chave (merged) + inspeção manual de
`used_memory` (§4.1) cobre o caso. A observabilidade automatizada (#300) e o
OOM handling homogêneo (#309) fecham o ciclo. Reavaliar isolamento físico
quando passarmos de ~100 tenants ativos.

---

## Apêndice — referências cruzadas

- **`docker-compose.yml`** — fonte da config (`services.redis.command`).
- **`docs/runbooks/operational.md`** — §5 DLQ, §8 métricas, `/health/redis`.
- **`src/lib/redis.ts`** — cliente compartilhado (`ioredis` com
  `lazyConnect`).
- **PRs #245/#252/#253/#257/#258/#259/#264/#272** — tenant scoping dos callers
  Redis críticos (working memory, rate-limit, dedup, debouncer, vision cache,
  pubsub, holidays cache). Todas **merged** — base do pressuposto "keys
  tenant-prefixed" deste runbook.
- **Issue #284** — gap que originou esta documentação (`maxmemory-policy`
  default + risco de config drift cross-tenant).

### Camadas companheiras (pré-requisitos declarados)

Esta PR é a camada de infraestrutura de uma entrega faseada. As camadas que
tornam a pressão de memória *observável* e *graciosamente degradável* são
rastreadas separadamente:

- **#297 / #300** — `obs(redis)`: coletor de `INFO memory/stats` + gauges
  Prometheus (`redis_used_memory_bytes`, `redis_maxmemory_bytes`,
  `redis_memory_used_ratio`, `redis_evicted_keys_total`) + alertas (§4.2).
  Sem isso, o primeiro sinal de pressão é um write falhando.
- **#309** — `redis`: OOM handling aplicativo (fail-closed / degradação em vez
  de propagar `ReplyError`) nos callers que ainda propagam (§4.3).

Ordem de mérito: cada camada melhora estritamente o estado anterior. Reverter
esta PR enquanto se espera #300/#309 deixa o pior caso pior (eviction
cross-tenant silenciosa é pior que write failure ruidoso e não-cross-tenant).
