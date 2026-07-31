# Runbook — Observabilidade, SLIs, SLOs e error budget (issue #514)

> Complementa `docs/runbooks/operational.md` (debug do dia-a-dia) e
> `docs/runbooks/p10b-runtime-trace.md` (trace durável). Este runbook responde
> **"o alerta disparou, e agora?"**.
>
> Regras carregáveis: [`monitoring/alerts/slo.rules.yml`](../../monitoring/alerts/slo.rules.yml).
> Aquele arquivo é a fonte de verdade dos limiares; esta página narra a reação.

## 1. Modelo mental

Três camadas, propósitos distintos — não as confunda:

| Camada | Onde | Para quê | Amostragem |
|---|---|---|---|
| **Métrica** | `/metrics` (Prometheus) | agregado, alerta, SLO | sempre 100%, mas **sem** identificadores |
| **Log** | pino, stdout | reconstrução de um caso | 100% |
| **Trace durável** | `runtime_trace_envelopes` / `_bodies` | evidência governada, HMAC | 100% em side effect |

A regra que amarra as três: **`trace_id`**. Ele nasce no ingress
(`src/observability/correlation.ts`), é derivado deterministicamente do
`mensagens.id`, viaja no payload BullMQ, é restaurado no worker e aparece em
log e trace. **Nunca aparece como label de métrica** — ver §5.

## 2. Vocabulário (fonte única)

`src/observability/taxonomy.ts` declara todo span, toda métrica e toda label
permitida. Antes de instrumentar qualquer coisa nova, adicione lá primeiro. Um
nome que não está na taxonomia não deveria existir.

## 3. SLOs iniciais

> Estes valores são o **ponto de partida** da issue #514 §8. Ajuste **só** após
> uma ou duas semanas de baseline e com ADR explícita em
> `docs/architecture/decisions/`. Afrouxar um limiar para "o alerta parar de
> tocar" é exatamente o anti-padrão que a issue proíbe.

### Correção — alvo zero

| SLI | Alvo | Alerta |
|---|---|---|
| Vazamento cross-tenant | 0 | `MaiaTenantDefaultLiteralObserved` |
| Side effect sem envelope obrigatório | 0 | `MaiaMandatoryTraceEnvelopeFailed` |
| Falha de escrita de audit | 0 | `MaiaAuditWriteFailing` |
| Label de PII emitida | 0 | `MaiaMetricLabelPolicyViolated` |

### Disponibilidade

| SLI | Alvo |
|---|---|
| Inbounds elegíveis que atingem estado terminal durável em ≤ 5 min | 99,9% |
| Outbounds committed que chegam a `sent`/`delivered`/retryable explícito | 99,9% |

### Latência (sem debounce configurado)

| SLI | Alvo |
|---|---|
| p95 inbound → resposta enviada (turno textual, sem tool externa) | ≤ 5 s |
| p99 | ≤ 15 s |

**Com debounce**, subtraia/segmente a janela configurada antes de comparar:
p95 operacional ≤ 10 s, p99 ≤ 20 s. O debounce é espera *deliberada* — contá-la
como latência de sistema torna o SLI mentiroso nos dois sentidos.

### Filas

| SLI | Normal | Warning | Critical |
|---|---|---|---|
| `oldest agent job` | < 2 s | > 10 s por 5 min | > 30 s por 5 min |

### Trace

| SLI | Alvo |
|---|---|
| Side effects com envelope | 100% |
| Bodies persistidos em ≤ 5 min | 99,9% |
| Envelope p99 | < 20 ms (contrato de `p10b-runtime-trace.md`) |

### Semântica dos relógios (issue §"Invariantes de implementação")

| Métrica | Fonte do t0 | Por quê |
|---|---|---|
| `maia_turn_e2e_latency_ms` | `mensagens.created_at` (persistido, no payload do job) | sobrevive a restart, debounce e recovery — é a latência que o usuário sente |
| `maia_turn_duration_ms` | `Date.now()` no início do handler | tempo de processo; útil para separar fila de trabalho |
| `maia_queue_wait_ms` | `enqueued_at_ms` (persistido no payload) | mede espera real, não relógio local do worker |

Os três relógios são do **mesmo processo** que os lê, exceto `received_at_ms` /
`enqueued_at_ms`, que atravessam processos. Divergência de relógio entre nodes
é risco residual conhecido: sincronize NTP.

## 4. Reação por alerta

### 4.1 `MaiaMandatoryTraceEnvelopeFailed` / `MaiaTraceEnvelopeWriteFailing`

**O que significa.** Um efeito de nível `>= medium` não conseguiu gravar
envelope. Por design (invariante 12 do P10b) o turno **abortou** — isso é
correto, não é o incidente. O incidente é o Postgres/HMAC por trás.

1. `maia_runtime_trace_envelope_write_failed_total` por `decision` /
   `side_effect_level` — que classe de efeito.
2. `maia_db_connected` — Postgres está de pé?
3. Se `RUNTIME_TRACE_HMAC_MASTER_SECRET` faltar, `lib/hmac.ts` falha fechado.
   Confira o env do processo.
4. Rollback de emergência: `FEATURE_RUNTIME_TRACE_V1=false` **+ restart do
   processo** desliga o hook do
   hot path (`src/observability/turn-trace.ts`). **Isso não desliga audit.**
   Só faça isso conforme a política de governança — ver
   `docs/runbooks/p10b-runtime-trace.md`.

### 4.2 `MaiaAuditWriteFailing`

Decisão com efeito colateral sem trilha (AGENTS.md §4.4). Trate como incidente
de compliance, não de performance. Verifique Postgres e `audit_logs`.

### 4.3 `MaiaTenantDefaultLiteralObserved`

Um path dinâmico alcançou o literal `'default'`. O contador só existe porque
`MAIA_REJECT_DEFAULT_LITERAL` pode estar em `false`; com a rejeição ligada isso
já teria virado throw. Encontre o call site pela label `field` e pelo log
correspondente. Ver `docs/architecture/concerns/tenant-isolation.md`.

### 4.4 `MaiaTurnFailureRateHigh` / `MaiaTurnFailureRateCritical`

1. Quebre por tenant: `maia:turn_failure_ratio:rate5m:by_tenant`. Um tenant só
   ⇒ dado/config daquele tenant. Todos ⇒ dependência compartilhada.
2. Olhe `maia:turn_retry_ratio:rate5m` ao lado. Retry alto com `failed` baixo
   ⇒ transitório, a plataforma está absorvendo. `failed` subindo ⇒ retries
   esgotados, olhe a DLQ (§4.8).
3. Cruze com §4.9 (LLM) e §4.10 (dependências).

> **Como o SLI conta (issue #514).** `maia_turn_completed_total` é emitido uma
> vez por TENTATIVA, com três outcomes: `completed`, `failed` e `retryable`.
> Os SLIs e o error budget contam **só os terminais** (`completed|failed`),
> porque `retryable` não é um desfecho — aquele mesmo turno vai ser retentado e
> depois emite um terminal. Contar tentativa faria um turno com duas retentativas
> e sucesso final aparecer como 3 observações e 33% de sucesso. O filtro garante
> exatamente **uma observação terminal por turno**: o worker sempre emite
> `failed` quando esgota as tentativas (`recordTurnOutcome` em
> `src/gateway/queue.ts`). Retries não somem — viram
> `maia:turn_retry_ratio:rate5m`, um sinal próprio.
>
> A latência (`maia:turn_e2e_latency_ms:p95/p99`) conta só `completed`: turno
> que falhou nunca respondeu, e tentativa `retryable` é tentativa PARCIAL.

### 4.5 `MaiaTurnLatencyP95High` / `MaiaTurnLatencyP99High`

O diagnóstico é uma subtração:

- `maia:queue_oldest_job_age_ms:max` alto ⇒ **capacidade**. Não é o LLM; é
  worker insuficiente ou concorrência 1. Ver `src/gateway/queue.ts`.
- fila baixa e `maia_llm_latency_ms` p95 alto ⇒ **provider**.
- fila baixa, LLM normal ⇒ contexto/DB. Ver `maia_context_load_ms` e o pool.
- Debounce ligado? Subtraia a janela antes de concluir qualquer coisa.

### 4.6 `MaiaQueueOldestJobAgeWarning` / `MaiaQueueOldestJobAgeCritical`

1. `maia:queue_depth:max{state="waiting"}` cresce junto? ⇒ chegada > vazão.
2. `state="active"` preso em 1 com waiting crescendo ⇒ um job travado.
   Concorrência do agent worker é 1 por design.
3. `state="failed"` crescendo ⇒ veja §4.8.

### 4.7 `MaiaQueueMetricsAbsent`

Gauge em `NaN` ou série ausente. **Não interprete como fila vazia.** Significa
que o coletor não conseguiu falar com o Redis (ou o scrape parou). Verifique
`maia_redis_connected` e o alvo do Prometheus. Este alerta existe justamente
porque a issue proíbe ler "métrica ausente" como "zero saudável".

### 4.8 `MaiaDlqGrowing`

`npm run dlq` para inspecionar. A row de inbound continua `processada_em IS
NULL` (fail-closed), então `runMessageRecovery` re-enfileira — e o
`trace_id` **é o mesmo**, então o trace do turno recuperado continua o
original, com `attempt` incrementado.

### 4.9 `MaiaLlmErrorRateHigh` / `MaiaLlmRateLimited`

Quebre por `reason`:

| `reason` | Ação |
|---|---|
| `rate_limit` | reduzir concorrência / negociar quota |
| `overloaded` | provider instável; fallback já está atuando (`status="fallback"`) |
| `auth` | chave expirada/revogada — não é transitório, não adianta esperar |
| `timeout` | rede ou modelo lento; cheque `maia_llm_latency_ms` |
| `bad_request` | bug de payload nosso, não do provider |

### 4.10 `MaiaWhatsAppDisconnected` / `MaiaDbDisconnected`

Ver `docs/runbooks/operational.md` e `docs/runbooks/whatsapp-migration.md`.

## 5. Privacidade das métricas (não negociável)

`src/observability/labels.ts` é um portão, não uma convenção:

- key fora da allowlist ⇒ **descartada**;
- key na denylist (ou contendo `phone`/`jid`/`email`/`message`/`trace_id`/… )
  ⇒ **descartada**, mesmo que alguém a adicione na allowlist;
- valor com forma de telefone, JID, e-mail, URL ou texto livre ⇒
  `__sanitized__`;
- valor além do orçamento de cardinalidade ⇒ `__overflow__`.

`MaiaMetricLabelPolicyViolated` dispara quando o portão **bloqueou** algo. Nada
vazou — mas há um call site errado para corrigir. Rode o suite com
`MAIA_STRICT_METRIC_LABELS=true` para transformar a violação em falha de teste.

**Se a cardinalidade explodir:** remova a label problemática do call site e
mantenha a correlação em log/trace. Nunca resolva isso relaxando o sanitizer.

## 6. Error budget e burn rate

SLO de disponibilidade 99,9% ⇒ orçamento de erro de 0,1%.

| Alerta | Janela | Multiplicador | Orçamento acaba em |
|---|---|---|---|
| `MaiaErrorBudgetFastBurn` | 1 h | 14,4× | ~2 dias |
| `MaiaErrorBudgetSlowBurn` | 6 h | 6× | ~5 dias |

Fast burn é página; slow burn é ticket. Enquanto o orçamento estiver estourado,
mudança de comportamento do agente entra em congelamento até o erro voltar ao
alvo — o orçamento é o mecanismo, não uma métrica decorativa.

## 7. Rollback

| Quero desligar | Como | O que NÃO desliga |
|---|---|---|
| runtime trace no hot path | `FEATURE_RUNTIME_TRACE_V1=false` **+ restart** | audit, métricas |
| correlação de trace | nada a desligar — é aditivo e inerte | — |
| labels problemáticas | remova do call site | o sanitizer continua ativo |

Redaction **nunca** é desligada. Envelopes obrigatórios só saem conforme a
política de governança.

> **Toda variável desta tabela é `restartRequired` (contrato #515).** Elas são
> validadas no boot e lidas pelo loader tipado (`src/config/env.ts`), não por
> `process.env` em tempo de chamada — mudar o valor sem reiniciar o processo
> não tem efeito. Confira o estado corrente com `npm run config:check`.

## 8. Ativando as regras no Prometheus

```yaml
rule_files:
  - /etc/prometheus/rules/slo.rules.yml
  - /etc/prometheus/rules/redis.rules.yml
  - /etc/prometheus/rules/working-memory.rules.yml
```

Monte `monitoring/alerts/` read-only no container do Prometheus nesse caminho.

## 9. Lacunas conhecidas (issue #514 ainda aberta)

Estas partes do escopo **não** estão implementadas; não presuma que o alerta
existe:

- exportador OTLP / spans operacionais distribuídos (a taxonomia de spans está
  declarada, a emissão não);
- métricas de pool do Postgres, tool dispatch e sessões WhatsApp por linha;
- dashboards versionados;
- benchmark de overhead e de cardinalidade total.

---

| | |
|---|---|
| Last verified | 2026-07-28 |
| Issue | #514 |
| Re-verify when | `src/observability/taxonomy.ts` mudar; ou um limiar de `monitoring/alerts/slo.rules.yml` mudar; ou o exportador OTLP entrar. |
