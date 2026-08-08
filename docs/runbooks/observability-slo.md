# Runbook — Observabilidade, SLIs, SLOs e error budget (issues #514 · #535)

> Complementa `docs/runbooks/operational.md` (debug do dia-a-dia) e
> `docs/runbooks/p10b-runtime-trace.md` (trace durável). Este runbook responde
> **"o alerta disparou, e agora?"**.
>
> Regras carregáveis: [`monitoring/alerts/slo.rules.yml`](../../monitoring/alerts/slo.rules.yml).
> Aquele arquivo é a fonte de verdade dos limiares; esta página narra a reação.

## 1. Modelo mental

Quatro camadas, propósitos distintos — não as confunda:

| Camada | Onde | Para quê | Amostragem |
|---|---|---|---|
| **Métrica** | `/metrics` (Prometheus) | agregado, alerta, SLO | sempre 100%, mas **sem** identificadores |
| **Log** | pino, stdout | reconstrução de um caso | 100% |
| **Trace durável** | `runtime_trace_envelopes` / `_bodies` | evidência governada, HMAC | 100% em side effect |
| **Trace operacional** (#535) | collector OTLP | waterfall de latência | `MAIA_OTLP_SAMPLE_RATIO`, default 5% |

O trace durável é o sistema de registro; o operacional é diagnóstico e pode ser
amostrado. Confundir os dois leva a "vou desligar o trace para economizar" e a
perda é de evidência governada, não de gráfico. Ver §9.

A regra que amarra as quatro: **`trace_id`**. Ele nasce no ingress
(`src/observability/correlation.ts`), é derivado deterministicamente do
`mensagens.id`, viaja no payload BullMQ, é restaurado no worker e aparece em
log e trace. **Nunca aparece como label de métrica** — ver §5.

## 2. Vocabulário (fonte única)

`src/observability/taxonomy.ts` declara todo span, toda métrica e toda label
permitida. Antes de instrumentar qualquer coisa nova, adicione lá primeiro. Um
nome que não está na taxonomia não deveria existir.

Desde a #535 a taxonomia também declara, por span, se ele é **emitido** ou
apenas **declarado** (`SPAN_EMISSION`), com teste que falha se a marca divergir
do código. Leia essa tabela antes de procurar um span no collector: se estiver
`declared`, ele não existe, e a ausência não é um bug do collector.

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

### 4.9.1 `MaiaLlmCircuitOpenEnforcing` / `MaiaLlmCircuitModeOverridden` / `MaiaLlmCircuitDisabledTooLong`

Disjuntor de LLM. O procedimento completo (kill switch, promoção e rollback)
vive em [`operational.md` §3.1](operational.md) — aqui fica só a leitura do
alerta.

| Alerta | O que aconteceu | Primeira coisa a checar |
|---|---|---|
| `MaiaLlmCircuitOpenEnforcing` | disjuntor `open` **e** postura `enforce`: chamadas estão sendo recusadas de verdade | é o provider ou é o disjuntor? `maia_llm_calls_total{status="error"}` do mesmo par no mesmo instante |
| `MaiaLlmCircuitModeOverridden` | alguém acionou o kill switch (inclusive `reason="rejected"`, i.e. tentou e não conseguiu) | ator e motivo no log `llm_gateway.circuit_mode_override` |
| `MaiaLlmCircuitDisabledTooLong` | postura `off` há mais de 1h | o incidente ainda está aberto, ou a alavanca virou configuração escondida? |

**Por que o primeiro qualifica a postura.** `maia_llm_circuit_state{state="open"}`
marca `open` também em `shadow`, onde o disjuntor mede e **não recusa nada** —
`shadow` é o default em produção. Alertar em `state="open"` sem o
`and on() maia_llm_circuit_mode{state="enforce"} == 1` acordaria plantão por um
incidente que não existe.

Em `shadow`, os números que interessam são
`maia_llm_circuit_would_reject_total` (carga que SERIA recusada, com
`tenant_id`/`agent_id`) e `maia_llm_circuit_would_open_total` (abertura
simulada). Eles não têm alerta de propósito: em sombra são medição para a
decisão de promover, não sintoma de incidente.

### 4.10 `MaiaWhatsAppDisconnected` / `MaiaDbDisconnected`

Ver `docs/runbooks/operational.md` e `docs/runbooks/whatsapp-migration.md`.

### 4.11 `MaiaDbPoolSaturated` / `MaiaDbPoolMetricsAbsent`

`maia_db_pool{state}` expõe quatro séries do MESMO pool — `total`, `idle`,
`waiting`, `max`. O diagnóstico é a relação entre elas, não uma isolada:

| Sintoma | Leitura |
|---|---|
| `waiting > 0`, `idle == 0`, `total == max` | **exaustão**: a concorrência excede o pool. Ou aumente `max`, ou ache a query que segura conexão. |
| `waiting > 0`, `total < max` | o pool ainda está CRESCENDO. A espera é custo de abertura de conexão, não falta de conexão. Latência de rede/TLS até o Postgres. |
| `idle == total`, `waiting == 0` | pool ocioso. Se a latência está alta, o gargalo não é banco. |

O par com `maia:queue_oldest_job_age_ms:max` fecha o diagnóstico de §4.5: fila
crescendo COM pool saturado é capacidade de banco, não de worker.

`MaiaDbPoolMetricsAbsent` é a mesma regra de §4.7 aplicada ao pool: as gauges
devolvem `NaN` quando não conseguem ler o pool. **Não leia como pool vazio.**

### 4.12 `MaiaSchedulerLagWarning` / `MaiaSchedulerLagCritical` / `MaiaSchedulerMetricsAbsent`

`maia_scheduler_lag_ms{queue}` mede **atraso**, não profundidade: quanto tempo
faz que a linha mais antiga JÁ VENCIDA está esperando. Um scheduler com 10 000
itens vencendo daqui a uma hora está saudável; um com um único item três
minutos atrasado não está.

1. `maia:scheduler_backlog:max` junto: backlog ~1 com lag alto ⇒ **uma linha
   travada** (provavelmente lease expirado — veja `reclaimExpiredLeases`).
   Backlog crescendo com lag crescendo ⇒ **o tick parou** ou não vaza.
2. Quebre por `queue`: `occurrences` é o motor de agendamento
   (`src/scheduling/engine.ts`), `outbox` é a entrega
   (`src/scheduling/outbox-drain.ts`). Só `outbox` atrasado com `occurrences`
   limpo aponta para backpressure do WhatsApp (`src/scheduling/backpressure.ts`),
   não para o scheduler.
3. `MaiaSchedulerMetricsAbsent` = o coletor não conseguiu ler o Postgres. A
   gauge devolve `NaN` de propósito, **nunca 0** — sem isso, um scheduler cego
   seria indistinguível de um scheduler ocioso.

### 4.13 `MaiaWhatsAppSessionFlapping`

`maia_whatsapp_sessions{state}` é um PAR (`connected` / `disconnected`) e não
uma gauge 0/1: com uma série só, "0" e "o scrape falhou" renderizam igual — a
mesma ambiguidade que §4.7 proíbe.

O flapping não aparece nessa gauge: a sessão pode estar `connected` em todo
scrape e mesmo assim ter caído dez vezes entre eles. O sinal é
`maia_whatsapp_session_age_seconds`, que **cresce** enquanto a sessão vive e
**reseta** a cada queda; `resets()` sobre a janela conta as quedas.

Antes da primeira queda não existe instante de referência e a série é `NaN` —
não 0, que se leria como "acabou de cair".

Reconexão repetida costuma ser sessão pareada em outro dispositivo, relógio
fora de sincronia, ou banimento em curso. Ver `docs/runbooks/operational.md`.

### 4.14 `MaiaToolErrorRateHigh`

Quebre por `result`:

| `result` | Significado |
|---|---|
| `ok` | sucesso |
| `blocked` | governança NEGOU (grant, permissão, aprovação pendente, escopo, flag desligada, dependência ausente). **Não é erro** — é a plataforma funcionando. Tem SLI próprio (`maia:tool_blocked_ratio:rate5m`). |
| `invalid` | a CHAMADA veio malformada: argumentos que o Zod rejeitou, ou um nome de tool que não existe. Sobe junto com troca de modelo/prompt. |
| `error` | a tool quebrou. Este é o numerador do alerta. |

`blocked` subindo sozinho é quase sempre grant mal configurado, não incidente —
por isso está fora do numerador. Confirme em `maia:tool_duration_ms:p95` por
`tool` se a lentidão acompanha, e cruze com §4.5.

#### De onde vem cada `result` (vocabulário fechado)

O dispatcher e a ponte MCP sinalizam veredito **retornando** `{ error: <code> }`,
nunca lançando. Os códigos são um conjunto **fechado**, declarado por quem os
produz em [`src/tools/_dispatch-error-codes.ts`](../../src/tools/_dispatch-error-codes.ts)
e re-exportado por `src/tools/_dispatcher.ts` e `src/tools/mcp-bridge.ts` — a
observabilidade importa a lista em vez de manter cópia (cópia diverge).

| `result` | Códigos |
|---|---|
| `blocked` | `forbidden` · `tool_not_granted` · `tool_disabled` · `feature_disabled` · `no_entity_in_scope` · `redis_unavailable_blocked` · `approval_pending` · `requires_confirmation` · `requires_dual_approval` · `mcp_tool_not_executable` |
| `invalid` | `invalid_args` · `unknown_tool` |
| `error` | `execution_failed` · `mcp_call_failed` · `idempotency_payload_hash_collision` · `idempotency_prior_failed` · `idempotency_owner_failed` · `idempotency_wait_timeout` · `idempotency_completion_fenced` |

Até a revisão da #541 o classificador conhecia cinco códigos escritos à mão e
jogava o resto no `error` default. Ou seja: `feature_disabled`,
`redis_unavailable_blocked`, `approval_pending`, `requires_confirmation`,
`requires_dual_approval` e `mcp_tool_not_executable` — **recusas fail-closed,
governança funcionando como projetada** — entravam no numerador deste alerta.
Um SLI que conta governança como falha é pior que nenhum: ensina o time a
ignorar o alerta. `tests/unit/observability/tool-error-codes.spec.ts` varre os
dois arquivos-fonte e falha se um código retornado não estiver classificado —
exaustividade, não amostragem.

**Resíduo conhecido.** O default continua `error`, de propósito: uma tool
HANDLER também pode devolver `{ error: … }` com string livre (ex.
`cancel-transaction` → `not_found`, `generate-report` →
`pdf_generation_failed`), fora do vocabulário do dispatcher. Contar falha
desconhecida como falha é a direção fail-safe. Se um desses volumes crescer a
ponto de distorcer o SLI, classifique-o explicitamente — não mexa no default.

### 4.15 `MaiaOtlpExportFailing`

Alerta sobre a **observabilidade**, não sobre o produto: nenhum turno depende
do exporter. Por isso é warning e nunca página.

Quebre `maia_otlp_spans_dropped_total` por `reason`:

| `reason` | Ação |
|---|---|
| `not_sampled` | **não é perda** — é `MAIA_OTLP_SAMPLE_RATIO`. Fora do numerador do alerta. |
| `queue_full` | o collector não está drenando: os spans se acumulam e a fila (2048) satura. Olhe o collector. |
| `transport` | rede/DNS/TLS até o endpoint, ou timeout de 10s. |
| `http_4xx` | payload nosso rejeitado — bug de encoding, ou credencial inválida em `MAIA_OTLP_TRACES_HEADERS`. |
| `http_5xx` | collector com problema próprio. |
| `shutdown` | spans emitidos depois do `stopOtlpExporter()` durante um deploy. Esperado em volume pequeno. |

Desligar: apague `MAIA_OTLP_TRACES_ENDPOINT` **+ restart**. Com o endpoint
ausente o caminho de span curto-circuita antes de qualquer alocação.

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
| spans OTLP | apague `MAIA_OTLP_TRACES_ENDPOINT` **+ restart** | métricas, audit, trace durável |
| volume de spans (sem desligar) | reduza `MAIA_OTLP_SAMPLE_RATIO` **+ restart** | — |

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

## 9. Trace operacional (OTLP) — issue #535

### 9.1 Ligar

```bash
MAIA_OTLP_TRACES_ENDPOINT=http://otel-collector:4318/v1/traces
MAIA_OTLP_SAMPLE_RATIO=0.05          # 5% dos turnos
MAIA_OTLP_SERVICE_NAME=maia-runtime
MAIA_OTLP_TRACES_HEADERS=            # k=v,k=v — auth do collector, se houver
```

As quatro são `restartRequired` (contrato #515). **Sem o endpoint o caminho de
span curto-circuita antes de qualquer alocação** — é assim que ligar isto em
produção é seguro por construção, e é o estado default.

### 9.2 O `trace_id` é o mesmo em todas as superfícies

O trace id W3C exportado é o `mensagens.id` sem os hífens. O mesmo valor
aparece em `runtime_trace_envelopes.trace_id`, no campo `trace_id` do log pino
e no Trace Explorer do Admin. Um id, quatro superfícies — cole o mesmo valor
nas quatro.

### 9.3 Amostragem é DERIVADA, não sorteada

`MAIA_OTLP_SAMPLE_RATIO` é aplicado a um hash do trace id, não a um sorteio por
processo. Consequência prática: ingress e worker chegam ao **mesmo** veredito
sem propagar bit de amostragem, então um turno amostrado é amostrado
**inteiro**. Meio trace é pior que nenhum — a metade ausente se lê como "aquela
etapa não rodou".

Isso também significa que o CONJUNTO de turnos amostrados é estável: reprocessar
o mesmo `mensagem_id` amostra de novo.

### 9.4 O que é emitido hoje

`SPAN_EMISSION` em `src/observability/taxonomy.ts` é a fonte de verdade e é
verificada por teste — a taxonomia não consegue mais superestimar a cobertura.
Emitidos hoje: `turn`, `queue.wait`, `tool.dispatch`. Todo o resto está
**declarado, não emitido**; o span não vai aparecer no waterfall.

### 9.5 Privacidade

Atributo de span passa por `src/observability/span-attributes.ts`, que é o
portão equivalente ao de labels (§5) com uma única diferença deliberada: span
PODE carregar os ids de correlação enumerados (`trace_id`, `turn_id`,
`attempt_id`, `conversa_id`, `root_trace_id`), porque atributo de span não cria
série temporal. Conteúdo de mensagem, telefone, JID, e-mail, nome, URL e string
crua de erro continuam proibidos — e o collector é de terceiro, então aqui o
portão importa mais, não menos. A sanitização roda no FIM do span, antes de
entrar na fila do exporter: span não sanitizado não chega a existir em memória.

### 9.6 Atribuição de span (`tenant_id` / `agent_id`)

Todo span exportado carrega `tenant_id` + `agent_id`, e a tupla é a que o turno
**resolveu** — não a que o ALS por acaso continha no fechamento do span.

Isso importa na investigação: o span-raiz `turn` abre ANTES do tenant ser
conhecido (`src/gateway/queue.ts` embrulha o processor no contexto `system`
sancionado) e `src/agent/core.ts` abre o `runWithTenantContext` real ANINHADO lá
dentro. Até a #541 os atributos eram lidos no fechamento, quando esse escopo já
tinha desmontado — todo root saía `tenant_id=system` enquanto o `tool.dispatch`
saía com a tupla certa. Se você abrir um waterfall antigo no collector, é isso
que vai ver; não conclua que o turno rodou como `system`.

Hoje a tupla é CAPTURADA: entrar num escopo de tenant notifica um observer
consultivo e fail-soft (`setTenantScopeObserver`, registrado por
`src/observability/tracer.ts`) que publica a tupla em todo span aberto naquele
contexto assíncrono. Duas regras, ambas cobertas por teste:

- `system` nunca publica — o contexto externo do worker não rebaixa um span já
  resolvido, em nenhuma ordem de aninhamento;
- a tupla de um span é **escrita uma vez** — um SEGUNDO tenant real sob o mesmo
  span é anomalia, não atualização. Re-carimbar poria a tupla de um tenant no
  span de outro, então o evento é contado em
  `maia_span_attribute_rejected_total{reason="attribution_conflict"}` e
  descartado. **Se essa série subir, investigue: é sinal de um turno tocando
  dois tenants, não de bug de instrumentação.**

`queue.wait` é o único span que não consegue aprender o próprio tenant — ele
reconstrói uma janela que fechou antes do worker existir. Por isso é emitido
DEPOIS do root fechar, carimbado com a tupla que o root resolveu (inclusive
quando o turno falha). Consequência operacional: se o processo morrer no meio do
turno, você perde o `queue.wait` do waterfall — mas perderia o `turn` junto, então
o trace estaria vazio de qualquer forma.

O histograma `maia_queue_wait_ms` NÃO mudou: continua sendo registrado na
entrada, antes da resolução, e portanto continua rotulado `system`. É
deliberado — a SLI de espera na fila precisa sobreviver a um turno que nunca
termina. Para quebrar espera de fila por tenant, use o span, não a métrica.

## 10. Dashboards

`monitoring/dashboards/` — JSON versionado do Grafana, um arquivo por público.
Ver `monitoring/dashboards/README.md` para importar. Toda expressão dos painéis
usa as recording rules deste arquivo, então painel e alerta nunca discordam.

## 11. Lacunas conhecidas (issue #535 ainda aberta)

Não presuma cobertura que não existe:

- **spans operacionais parciais** — só `turn`, `queue.wait` e `tool.dispatch`
  têm emissor. As outras 20 entradas da taxonomia estão marcadas `declared`;
- **`context.load` não é emitido no hot path.** O wrapper existe
  (`instrumentContextLoad`) e é testado, mas a montagem de contexto do turno
  vive em `src/agent/prompt-builder.ts`, fora do escopo desta entrega. A
  família `maia_context_load_ms` só produz série quando aquele call site for
  instrumentado;
- **benchmark de overhead é micro, não sob carga** —
  `tests/unit/observability/overhead-benchmark.spec.ts` mede o custo por
  emissão e o teto TEÓRICO de séries a partir dos orçamentos de cardinalidade.
  Cardinalidade REAL sob tráfego continua sem medição;
- **fault injection e teste de carga** (issue #510) não entraram.

---

| | |
|---|---|
| Last verified | 2026-08-04 |
| Issue | #514 → #535 |
| Re-verify when | `src/observability/taxonomy.ts` mudar; ou um limiar de `monitoring/alerts/slo.rules.yml` mudar; ou um span sair de `declared` para `emitted`. |
