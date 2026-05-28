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

### Regras Prometheus / Alertmanager (sugeridas)

```yaml
groups:
  - name: redis_memory_pressure
    interval: 30s
    rules:
      - alert: RedisMemoryPressureWarning
        expr: redis_memory_used_ratio > 0.80
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Redis a {{ $value | humanizePercentage }} do maxmemory"
          description: |
            Investigar crescimento de cache (working memory leak?
            BullMQ buffer crescente?) antes de aumentar o cap.
            Runbook: docs/runbooks/redis.md §3 (sizing).

      - alert: RedisMemoryPressureCritical
        expr: redis_memory_used_ratio > 0.95
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Redis CRITICAL: writes vão falhar em breve (noeviction ativo)"
          description: |
            Política `noeviction` (ver §1) transforma OOM em write failures.
            BullMQ enqueue → DLQ; idempotency ledger → outbound abortado;
            working memory write → cache miss + reconstrução via Postgres.
            Ação imediata: aumentar `maxmemory` no compose/painel +
            investigar leak. Ver §5 ("Não-fazer").

      - alert: RedisEvictionDetected
        expr: redis_evicted_keys_total > 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Redis evicted_keys > 0 sob noeviction — config drift"
          description: |
            Sob `maxmemory-policy noeviction` evicted_keys DEVE ficar em 0.
            Qualquer valor positivo significa que alguém mudou a política em
            runtime (`CONFIG SET maxmemory-policy ...`) — risco de eviction
            cross-tenant (ver §1). Auditar `audit_log` e histórico de deploy
            imediatamente.

      - alert: RedisRejectedConnectionsRising
        expr: increase(redis_rejected_connections_total[5m]) > 0
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Redis rejeitou conexões nos últimos 5min"
          description: |
            Pode indicar pressure no `maxclients` ou OOM (Redis rejeita
            novas conexões quando memory > maxmemory). Cross-check com
            `redis_memory_used_ratio` — se ambos subindo, é OOM iminente.
```

### Sinais correlacionados (não dependem deste coletor)

Já expostas por `src/server.ts`:

- `maia_redis_connected` (gauge 0/1) — coletor degrada para "última leitura
  conhecida" se Redis cair; `maia_redis_connected=0` é o sinal canônico.
- `/health/redis` — health endpoint Fastify. Pode ser estendido em PR
  futura para incluir threshold de `memory_used_ratio` (issue #297
  sugeriu, fora de escopo desta entrega).

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

## Apêndice — referências cruzadas

- **`src/observability/redis-memory-collector.ts`** — coletor (issue #297).
- **`src/server.ts`** — `startRedisMemoryCollector()` no boot.
- **`src/lib/metrics.ts`** — módulo interno de Prometheus (sem `prom-client`).
- **`docker-compose.yml`** — fonte da config (`services.redis.command`).
- **PR #294 / Issue #284** — `maxmemory 2gb` + `noeviction` (motivo deste
  observability ser obrigatório).
- **Issue #297** — gap original (sem essas métricas, OOM sob `noeviction`
  vira write failure invisível).
