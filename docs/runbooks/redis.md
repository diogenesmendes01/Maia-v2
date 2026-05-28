# Redis — runbook operacional

Como operar o Redis da Maia em produção: política de memória obrigatória,
sizing, sinais de pressão, e o que NÃO mexer.

> **TL;DR**: `--maxmemory-policy noeviction` (default deste compose) ou
> `volatile-lru`. **Nunca** `allkeys-*`. Veja §1.

---

## 1. Por que `noeviction` é obrigatório (isolamento multi-tenant)

A Maia hospeda múltiplos tenants no mesmo Redis. O isolamento entre tenants
é feito **por prefixo de chave** (`tenant_id+agent_id` em working memory,
BullMQ jobs, idempotency ledger, etc. — ver PR #241 e correlatas
#258 / #252 / #253 / #259 / #272 / #273). Isso resolve leitura/escrita
cruzada mas **não** protege contra o evictor do Redis.

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
| Idempotency ledger (1 dia, TTL aplicado) | ~10 KB por 100 outbound msgs |
| Rate-limit buckets | ~100 bytes por (tenant, agent, IP) |

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

---

## 4. Sinais de pressão — o que monitorar

```bash
docker exec maia-redis redis-cli INFO memory | grep -E '^(used_memory|used_memory_peak|maxmemory|maxmemory_policy):'
```

Métricas relevantes:

- `used_memory` — bytes em uso agora.
- `used_memory_peak` — pico desde o último restart. Se peak ≈ maxmemory,
  você passou perto do limite.
- `evicted_keys` (do `INFO stats`) — **DEVE ficar em 0 com `noeviction`**.
  Se subir, alguém mudou a política em runtime (`CONFIG SET`) — investigar
  `audit_log` ou histórico de deploy.

Alerta recomendado (Prometheus / Coolify monitoring):

```
used_memory / maxmemory > 0.80     # warning (degraded headroom)
used_memory / maxmemory > 0.95     # critical (writes podem começar a falhar)
evicted_keys_total > 0             # critical (política foi mudada)
```

Quando o app vê OOM no Redis:

- BullMQ falha enqueue → job vira erro determinístico → vai pra DLQ
  (ver `docs/runbooks/operational.md` §5).
- Idempotency ledger falha → outbound write é abortado (correto — não
  enviar mensagem é melhor que enviar duplicada).
- Working memory write falha → próxima leitura tem cache miss e o agente
  reconstrói o estado das mensagens persistidas em Postgres
  (degradação graciosa, mas com latência extra).

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

Hoje, `noeviction` + prefixo de chave + monitoramento de `used_memory` é
suficiente. Reavaliar quando passarmos de ~100 tenants ativos.

---

## Apêndice — referências cruzadas

- **`docker-compose.yml`** — fonte da config (`services.redis.command`).
- **`docs/runbooks/operational.md`** — §5 DLQ, §8 métricas, `/health/redis`.
- **`src/lib/redis.ts`** — cliente compartilhado (`ioredis` com
  `lazyConnect`).
- **PR #241** — tenant scoping de working memory (motivo original deste
  runbook).
- **Issue #284** — gap que originou esta documentação (`maxmemory-policy`
  default + risco de config drift cross-tenant).
