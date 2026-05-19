# P8a Context Packet — Runbook

## Overview

P8a entrega a infraestrutura de **Context Packet**: o objeto central que flui
pelo Hot Path (entry → BaseContextPacket → DecisionPacket → ExecutionContextPacket
→ prompt-builder). Sete slice builders, cache Redis com TTL + invalidação por
evento, dual-path no prompt-builder com feature flag e kill switch.

**Zero migrações de banco** — apenas código.

## Arquivos relevantes

- `src/runtime/context-packet/types.ts` — tipos canônicos
- `src/runtime/context-packet/base-context-builder.ts` — Camada 1
- `src/runtime/context-packet/decision-packet-stub.ts` — stub do Decision Engine (substituído em P9b)
- `src/runtime/context-packet/build-context-packet.ts` — orquestrador
- `src/runtime/context-packet/cache/` — slice-cache, invalidation-bus, ttl-policy
- `src/runtime/context-assembly/slice-builders/` — sete builders + interface
- `src/runtime/feature-flags/context-packet-flag.ts` — flag + kill switch
- `src/runtime/prompt/build-prompt-from-packet.ts` — render packet → prompt

## Feature flag

```bash
export FEATURE_CONTEXT_PACKET_V1=true                # liga path novo
export FEATURE_CONTEXT_PACKET_V1_KILL_SWITCH=true    # desliga path novo
```

Precedência: kill switch > tenant override (P8d) > env > default OFF.

## Health checks

**Redis cache:**
```bash
redis-cli KEYS "maia:context:*" | wc -l   # quantidade de slices em cache
redis-cli INFO stats | grep keyspace_hits  # taxa de acerto
```

**Métricas:**
- `context_assembly.duration_ms` (p95 < 600ms)
- `context_packet.fallback_applied{slice}` (alarma se subir muito)
- `cache_hit{slice}` (esperado warm-up nas primeiras horas após deploy)

## Troubleshooting

### "P8a stub: conservative defaults" no DecisionPacket
Esperado em qualquer ambiente onde P9b não tenha aterrissado. O orquestrador
usa o stub via `createDecisionPacketStub()` — substituir quando P9b chegar.

### Cache miss em todas as requisições
1. Verificar conexão Redis (`redis-cli PING`).
2. Confirmar que o cache não está sendo invalidado em loop por um emissor
   excessivo de eventos (`policy_rule_activated` em rajada, etc).
3. Verificar TTL com jitter: `getTTLForSlice('identity')` deve retornar ~300s.

### p95 acima de 600ms
1. Conferir métrica `context_packet.fallback_applied` — slices em fallback
   sugerem timeout de builder específico.
2. `cache_hits` baixo indica DB pressure — checar pool size (≥ 5×N_slices).
3. Se `policy` é o builder lento: alarma, pois é o único sem fallback de
   degradação. Reduzir `max_rules` em PolicyDescriptorResolver é mitigação.

### Kill switch ativado em incidente
1. `export FEATURE_CONTEXT_PACKET_V1_KILL_SWITCH=true`.
2. Restart das instâncias (env é lido na inicialização do flag source).
3. Tráfego volta para o caminho legado de prompt-builder em <1s por turno.
4. Investigar o incidente; remover kill switch quando seguro.

## Eventos de invalidação suportados

11 eventos no `InvalidationBus`. Cada um invalida sua slice no tenant:

| Evento | Slice invalidada |
|---|---|
| `identity_profile_activated` | identity |
| `identity_profile_rolled_back` | identity |
| `user_memory_upserted` | user |
| `user_memory_invalidated` | user |
| `user_behavioral_hint_added` | user |
| `knowledge_lifecycle_transitioned` | knowledge |
| `soul_bias_activated` | soul |
| `policy_rule_activated` | policy |
| `policy_rule_deactivated` | policy |
| `skill_activated` | skill |
| `tool_registry_updated` | tool |

Os emissores reais virão em P9/P10. P8a só entrega o bus + handlers default.

## TTL por slice

| Slice | TTL base | Comentário |
|---|---:|---|
| identity | 300s | Rebuilt quando profile rev muda |
| soul | 600s | Drift lento, invalidação por evento |
| policy | 600s | Estável, invalidação por evento |
| skill | 300s | Relativamente estável |
| tool | 900s | Registry quase imutável |
| user | 60s | Memórias mudam por turno |
| knowledge | 120s | Lifecycle transitions invalidam |
| history | 5s | Per-turn, raramente cacheável |

Jitter de ±10% aplicado a cada `set` para evitar thundering herd.

## Próximas integrações (não-P8a)

- P8b — Soul layer real (substitui `stubSoulPort`)
- P8c — User-layer namespace (substitui memorias via repo direto)
- P8d — Identity completion + tenant overrides do flag
- P8e — PolicyDescriptorResolver real (substitui `stubPolicyDescriptorResolver`)
- P9b — Decision Engine real (substitui `createDecisionPacketStub`)
- P10 — Trace envelope/body lendo `assembly_meta` + cache hits

## Acceptance gates

```bash
bash scripts/p8a-acceptance-gates.sh
```

9 gates: slice builders, cache layer, packet types, flag + kill switch,
no migrations, vitest pass, orchestrator, knowledge lifecycle invariant,
policy hard_limit preservation.
