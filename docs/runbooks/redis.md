# Redis — runbook operacional

Como operar o Redis da Maia em produção: política de memória obrigatória,
sizing, sinais de pressão, e o que NÃO mexer.

> **TL;DR**: `--maxmemory-policy noeviction` (default deste compose) ou
> `volatile-lru`. **Nunca** `allkeys-*`. Veja §1.

> **Nota de merge**: a estrutura completa deste runbook (§1, §2, §3, §5, §6)
> vem da PR #294 (issue #284 — `maxmemory` + `noeviction`). Esta versão
> contém apenas §4 atualizada com as métricas Prometheus reais expostas
> pela issue #297 (`src/observability/redis-memory-collector.ts`). Quando
> as duas PRs convergirem, §4 substitui a versão originalmente proposta em
> #294.

---

## 4. Sinais de pressão — métricas Prometheus + alertas

A Maia expõe gauges de pressão de memória do Redis via `/metrics`
(coletor em `src/observability/redis-memory-collector.ts`, registrado em
`src/server.ts`). O coletor faz `INFO memory` + `INFO stats` a cada 15s
e cacheia os valores; as gauges são pull-based via
`src/lib/metrics.ts:setGaugeProvider` (custo zero entre scrapes).

### Métricas expostas

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
> `redis_maxmemory_bytes 0` direto.

### Regras Prometheus / Alertmanager (config real, versionada)

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

### Sinais correlacionados (não dependem deste coletor)

Já expostas por `src/server.ts`:

- `maia_redis_connected` (gauge 0/1) — coletor degrada para "última leitura
  conhecida" se Redis cair; `maia_redis_connected=0` é o sinal canônico.
- `/health/redis` — health endpoint Fastify (`connected + PING`). Probe de
  componente, não decide rotação de LB.
- **`/readyz`** — **gate de readiness para o load balancer** (issue #297).
  Retorna **`503` (não-pronto)** quando `redis_memory_used_ratio > 0.95`,
  caso contrário `200`. Sob `noeviction` (ver §1) a pressão crítica vira
  write failure; tirar a instância de rotação **antes** disso evita que o
  incident cascateie (BullMQ → DLQ, idempotency → outbound abortado).
  Implementação: `checkReadiness()` em `src/lib/healthcheck.ts`, lê o ratio
  do snapshot cacheado do coletor (sem round-trip ao Redis). O threshold
  `0.95` = `CRITICAL_MEMORY_USED_RATIO` (mesma constante do alerta
  `RedisMemoryPressureCritical`).

  ```bash
  # 200 quando saudável, 503 quando ratio > 0.95
  curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/readyz
  ```

### Sondagem manual

```bash
docker exec maia-redis redis-cli INFO memory | \
  grep -E '^(used_memory|used_memory_peak|maxmemory|maxmemory_policy):'

docker exec maia-redis redis-cli INFO stats | \
  grep -E '^(evicted_keys|rejected_connections):'
```

Cross-check contra `/metrics`:

```bash
curl -s http://localhost:3000/metrics | grep -E '^redis_'
```

Valores devem bater (snapshot do coletor é atualizado a cada 15s).

---

## Política de memória — snapshot do `docker-compose.yml` (#294)

Esta é a garantia que torna a observabilidade da #297 obrigatória: sob
`noeviction`, atingir `maxmemory` vira **write failure** (OOM), não eviction
silenciosa. Para que essa garantia seja **verificável junto com as métricas**
(sem precisar abrir outro arquivo), o bloco relevante do compose é snapshotado
aqui literalmente:

```yaml
# docker-compose.yml → services.redis (estado-alvo pós-#294)
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
>
> **Estado atual desta branch.** No `docker-compose.yml` mergeado em `main`
> neste momento, o comando do Redis ainda é
> `["redis-server", "--appendonly", "yes"]` — **sem** `--maxmemory`/
> `--maxmemory-policy`. As flags acima entram com a **PR #294 / issue #284**.
> Enquanto #294 não merga, `redis_maxmemory_bytes` reporta `0` (unbounded),
> `redis_memory_used_ratio` reporta `0` e o gate `/readyz` nunca dispara — o
> que é o comportamento seguro e correto para "sem cap configurado" (ver §4,
> nota sobre `maxmemory=0`). A instrumentação já está pronta para o instante
> em que o cap for aplicado.

Conferir a política ativa em runtime:

```bash
docker exec maia-redis redis-cli CONFIG GET maxmemory
docker exec maia-redis redis-cli CONFIG GET maxmemory-policy
# Esperado pós-#294: maxmemory = 2147483648, maxmemory-policy = noeviction
```

---

## Apêndice — referências cruzadas

- **`src/observability/redis-memory-collector.ts`** — coletor (issue #297).
- **`src/server.ts`** — `startRedisMemoryCollector()` no boot.
- **`src/lib/metrics.ts`** — módulo interno de Prometheus (sem `prom-client`).
- **`docker-compose.yml`** — fonte da config (`services.redis.command`).
- **PR #294 / Issue #284** — `maxmemory 2gb` + `noeviction` (motivo deste
  observability ser obrigatório).
- **Issue #297** — gap original (sem essas métricas, OOM sob `noeviction`
  vira write failure invisível).
