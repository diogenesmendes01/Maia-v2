# lib

**Path:** `src/lib/`

**Purpose** — Thin wrappers around external services and shared utilities. Anthropic (Claude), OpenAI (Whisper, TTS), Vision (Claude Vision), Redis, Pino logger, Prometheus-compatible metrics, alerts (email + Telegram), business-day calendar with Brazilian holidays, decimal precision (`decimal.js`), embeddings, PDF generation, cost ledger, healthcheck. Each wrapper has one job; call sites depend on the wrapper, not the underlying SDK.

## Key files

| File | Role |
|---|---|
| `src/lib/llm/` | **LLM Gateway (issue #508)** — a fronteira ÚNICA de chat/classificação/visão. Ver seção abaixo. |
| `src/lib/claude.ts` | Facade de compatibilidade sobre o gateway — `callLLM()` (deprecated) + re-exports de tipos |
| `src/lib/openrouter-models.ts` | OpenRouter model catalog (alternative LLM source) |
| `src/lib/llm-settings.ts` | Model selection persistida (`global_settings`), lida pelo gateway |
| `src/lib/whisper.ts` | OpenAI Whisper (audio transcription) |
| `src/lib/tts.ts` | OpenAI TTS (outbound voice notes) |
| `src/lib/vision.ts` | Parsing de boleto/comprovante — passa pelo gateway (tier `vision`) |
| `src/lib/embeddings.ts` | Embedding generation for vector memory |
| `src/lib/redis.ts` | ioredis client + helpers. `ensureRedisConnect()` is **fail-closed** since #512: it throws `RedisUnavailableError` instead of logging a warning and letting the boot continue without a mandatory dependency |
| `src/lib/logger.ts` | Pino structured logger |
| `src/lib/metrics.ts` | `incCounter`, `observeHistogram`, `setGauge` + Prometheus registry |
| `src/lib/alerts.ts` | Email + Telegram alert channels |
| `src/lib/healthcheck.ts` | Component probes (`checkDb`/`checkRedis`/`checkWhatsApp`/`checkAll`) + the #297 Redis-memory readiness gate. **Read-only** since #512: `recordHealthSnapshot()` is called by the `health_monitor` cron, never by an endpoint, and `toPublicHealthReport()` strips raw driver text at the HTTP edge. The composite, role-aware `/readyz` lives in `src/runtime/lifecycle/readiness.ts` |
| `src/lib/decimal.ts` | `decimal.js` wrapper — `toDecimal()`, `fmtBRL()` |
| `src/lib/brazilian.ts` | Brazilian formatting (CPF, CNPJ, currency, dates) |
| `src/lib/business-days.ts` | Business-day arithmetic |
| `src/lib/national-holidays.ts` | National holiday list (Brazil) |
| `src/lib/easter.ts` | Easter date computation (used by movable holidays) |
| `src/lib/holidays-cache.ts` | Per-tenant + agent holiday cache |
| `src/lib/cost-ledger.ts` | LLM cost ledger |
| `src/lib/utils.ts` | Misc helpers |
| `src/lib/pdf/extrato.ts` | PDF statement template (pdfmake) |
| `src/lib/pdf/comparativo.ts` | PDF comparative report |
| `src/lib/pdf/_helpers.ts`, `_sweeper.ts` | PDF helpers + temp-file sweeper |

## LLM Gateway (`src/lib/llm/`) — issue #508

**Regra:** nenhum módulo de cognição, agente, skill ou worker importa
`@anthropic-ai/sdk` ou `openai`. Toda chamada de chat, classificação e visão
entra por `executeLLM()`. A regra é enforced por `no-restricted-imports`
(`eslint.config.js`) e pelo grep gate de auditoria
(`tests/integration/p7-audit-coverage.spec.ts`).

| Arquivo | Papel |
|---|---|
| `types.ts` | Contrato provider-neutral: `LLMWorkload`, `LLMTier`, `LLMGatewayRequest`, `LLMExecutionContext` |
| `workloads.ts` | Política por workload: tier default, nº de tentativas, fallback permitido |
| `model-resolver.ts` | `workload+tier` → provider+slug; leitura conjunta de main/fast, cache por tenant+agent com TTL curto |
| `providers/anthropic.ts`, `providers/openrouter.ts` | Os DOIS únicos arquivos autorizados a importar SDK |
| `gateway.ts` | Deadline, cancelamento, retry único, fallback, orquestração |
| `errors.ts` | Taxonomia de erro por `kind` + `Retry-After` + redaction |
| `budget.ts` | Quota diária por tenant+agent (`LLM_DAILY_BUDGET_USD`) |
| `circuit-breaker.ts` | Disjuntor por `(provider, workload)` — issue #534. Ver seção abaixo |
| `circuit-mode.ts` | Postura do disjuntor (`off`/`shadow`/`enforce`), default `shadow`, + kill switch com TTL e auditoria |
| `circuit-audit.ts` | Trilha DURÁVEL do disjuntor: transições `open`/`closed` e desfechos de override viram linha em `audit_log`, no contexto `system`. Ver seção abaixo |
| `telemetry.ts` | Métrica, custo e evento de uso — em TODO desfecho |
| `cache-invalidation.ts` | Redis pub/sub: troca de modelo no Admin **e** postura do disjuntor valem em todas as réplicas |

**O caller declara intenção, não implementação.** Ele passa `workload`; o
backend decide provider, modelo, tier, deadline, retry e fallback. Não existe
parâmetro de slug de modelo na API pública — é o que impede um módulo de
"pedir Sonnet" e escapar da configuração do operador.

**Política de retry e fallback** (`workloads.ts`):

| Grupo | Tentativas | Fallback p/ fast |
|---|---|---|
| Workloads de turno (`reasoner`, `skill`, `reflection`, `summarizer`, classificadores herdados de `callLLM`) | `CLAUDE_MAX_RETRIES` | sim |
| Workloads single-shot (`risk_classifier`, `role_selector`, `step_evaluator`, `calendar_detector`, `capability_proposer`, `drift_detector`, `vision`) | 1 | não |

Só erro TRANSITÓRIO retenta (`rate_limit`, `provider_5xx`, `network`).
`authentication`, `permission`, `invalid_request`, `aborted`, `timeout`,
`response_invalid`, `budget_exhausted`, `circuit_open` e
`missing_tenant_context` são terminais de primeira. `Retry-After` do provider vence o backoff local. Cancelamento nunca
é tratado como erro retryable. Quando o fallback falha, é o erro DELE que sobe —
mascarar um 401 do fallback atrás do 5xx do primário esconde a causa e induz
retry externo.

**Invariantes que o gateway impõe** (todas com teste dedicado):

| Invariante | Onde |
|---|---|
| Chamada sem `tenant_id + agent_id` no ALS é rejeitada (`missing_tenant_context`). Trabalho global usa `runWithSystemContext()`. | `gateway.ts` |
| Quota é RESERVA atômica antes do I/O, liquidada com o custo real depois — não check-then-act | `budget.ts` |
| Deadline absoluto é DERIVADO (`LLM_TURN_DEADLINE_MS`) quando o caller não declara; nunca reinicia a cada retry | `gateway.ts` |
| Erro nunca carrega corpo/mensagem do provider — só `kind`, `status`, `request_id` | `errors.ts` |
| 200 sem conteúdo utilizável é `response_invalid`, não sucesso | `providers/**` |
| `workload` é obrigatório; não existe default | `types.ts` + gate em `tests/unit/lib/llm-workload-declaration.spec.ts` |
| Provider fora do ar deixa de receber carga: disjuntor por `(provider, workload)` recusa antes de resolver modelo e reservar cota | `circuit-breaker.ts` |

### Disjuntor por `(provider, workload)` (issue #534)

Antes dele, uma queda do provider era AMPLIFICADA pelo gateway: cada request
gastava todas as tentativas do workload mais o fallback contra um provider já
fora do ar. Medido com `scripts/llm-benchmark.ts` (200 requests, queda total):
**800 requisições ao provider sem disjuntor, 10 com** — e o erro que o caller vê
deixa de custar 123ms de p50 para custar ~0.

| Aspecto | Decisão | Por quê |
|---|---|---|
| Chave | `(provider, workload)` — **sem tenant** | O estado mede a saúde de uma dependência EXTERNA e compartilhada, não dados de tenant. Escopar por tenant destruiria a amostra (tenant pequeno nunca abriria), faria cada tenant redescobrir a queda queimando as próprias tentativas, e criaria cardinalidade sem teto. A DECISÃO continua atribuível: toda recusa sai em `maia_llm_requests_total{status="circuit_open"}` com `tenant_id + agent_id`. Estado global, evidência escopada |
| Onde mora | Memória do processo, por réplica | Um disjuntor em Redis colocaria round-trip em toda chamada de LLM e faria o caminho de LLM depender do Redis — a falha correlacionada que o disjuntor existe para sobreviver. Custo: N réplicas sondam N vezes. Reinício zera o disjuntor |
| O que conta como falha | Só `provider_5xx`, `network`, `timeout` do SDK | Erro de caller (`invalid_request`), de config (`authentication`) ou decisão nossa (`budget_exhausted`) não são evidência sobre o provider — e deixar um caller abrir o disjuntor seria negação de serviço entre tenants. `timeout` por deadline do TURNO é descartado na origem (`link.deadlineFired()`); `rate_limit` fica de fora porque o 429 já traz `Retry-After` |
| Classe da falha | `fault` (percorre o orçamento) × `terminal_fault` (mata a chamada na tentativa) — derivada de `isRetryableKind` | Hoje: `provider_5xx`/`network` são `fault`; o `timeout` do SDK é `terminal_fault`, porque o gateway faz `throw` na primeira tentativa (sem retry, sem fallback). Derivar da mesma função que o gateway usa em `err.retryable` impede as duas de divergirem |
| Limiar de abertura | Taxa estimada de perda de **chamadas** ≥ 50%: `terminais/total + (retentáveis/total) ^ tentativas` | 50% fixo por tentativa está errado quando há retry: com `reasoner` (3 tentativas + fallback), 70% de erro por tentativa ainda entrega ~76% das chamadas. O harness mediu o estrago do limiar fixo — disponibilidade de 161/200 para 9/200. **Mas** essa derivação só vale para falha que de fato gasta as tentativas: aplicá-la ao `timeout` terminal fazia uma tempestade a 70% (70% das chamadas perdidas, cada uma pagando o timeout inteiro) NÃO abrir o disjuntor, porque 70% < ~84%. Cada classe entra com o expoente do orçamento que ela realmente gasta; os casos puros reduzem a `0.5^(1/tentativas)` e a 50% respectivamente. Quem trata brownout é o retry; quem trata queda é o disjuntor |
| Amostra mínima | 10 tentativas em janela de 30s | Sem piso, duas falhas de madrugada abrem com "100% de erro" sobre amostra 2 |
| Half-open | Até **3** sondas por janela, fecha na primeira que passar | Uma sonda só deixava preso em aberto um provider parcialmente saudável. Numa queda real o custo é 3 requisições por janela |
| Cooldown | 5s, dobrando a cada janela de sondas que falha inteira, teto de 60s | O cooldown é o tempo em que ainda recusamos DEPOIS de o provider voltar: medido em 10s, custava ~63 requests a mais numa corrida de 200; com 5s caiu para ~52 e a queda longa continua protegida pelo backoff |
| Limiares sem env var | Constantes versionadas | Mesma postura de `allow_fast_fallback`: AJUSTAR a política de degradação não deve ser toggle de runtime. DESLIGAR o controle, sim — ver a seção de postura abaixo |

Métricas: `maia_llm_circuit_state{provider,workload,state}` (gauge — **uma série
por estado**, exatamente uma valendo `1`; é a série que o runbook §8 documentava
e que **nada emitia** até esta issue), `maia_llm_circuit_transitions_total{provider,workload,state,reason}`
e `maia_llm_circuit_short_circuited_total{provider,workload,state}`. Toda
transição também sai no log como `llm_gateway.circuit_transition` com o motivo.

Duas escolhas de formato, ambas herdadas de precedente do repo e não desta
issue:

- **Par de séries, não codificação numérica.** Mesmo formato de
  `maia_lifecycle_state{role,state}` (`src/runtime/lifecycle/controller.ts:197`)
  e `maia_whatsapp_sessions{state}`. Um gauge único valendo `0/1/2` não se lê em
  PromQL sem legenda e torna "par nunca exercitado" indistinguível de "closed" —
  e é justamente o par sem série que diz que aquele workload nunca rodou.
- **Emissão por `@/observability/metrics.js`, nunca por `@/lib/metrics.js`.** É
  na camada de observabilidade que moram a allowlist de label, a deny list e o
  orçamento de cardinalidade da #514. Emitir direto na camada de baixo fura o
  gate. Consequência prática: `from`/`to` não estão na allowlist e seriam
  descartados em silêncio, então o contador carrega `state` (o estado entrado) e
  `reason`; a transição completa fica no log, que não tem cardinalidade.

O gauge **não** carrega `tenant_id`/`agent_id` — `gauge()` já força
`attribute: false`. O estado mede a saúde de uma dependência externa
compartilhada, não dado de tenant. A atribuição de cada recusa vive em
`maia_llm_requests_total{status="circuit_open"}`, essa sim com escopo de tenant.

Recusa é o kind `circuit_open`: não retentável (retentar é o que o disjuntor
impede), com `retry_after_ms` = cooldown restante, e emitida ANTES de resolver
modelo ou reservar cota — uma chamada que não vai acontecer não carimba
orçamento.

#### Trilha durável (`circuit-audit.ts`)

Métrica e log respondem enquanto Prometheus e coletor guardarem. Mudança de
estado do disjuntor e virada do kill switch são **decisões de governança**, e o
invariante 4 do `AGENTS.md` manda persistir em `audit_log`. Toda transição para
`open`/`closed` escreve `llm_circuit_opened` / `llm_circuit_closed`; todo
desfecho de override escreve `llm_circuit_mode_override_{applied,cleared,expired,rejected}`.

| Decisão | Por quê |
|---|---|
| Escrita sob `runWithSystemContext` EXPLÍCITO | A transição acontece dentro da chamada de algum tenant. Sem o wrapper, a linha herdaria o `tenant_id` que por acaso estava em voo — atribuição errada é pior que atribuição nenhuma. `ADR 0002`: saúde de dependência externa compartilhada é estado `system`, e as quatro condições cumulativas dela valem aqui (a atribuição de cada RECUSA continua em `maia_llm_requests_total{status="circuit_open"}`) |
| Alvo em `entidade_alvo` (`'llm_circuit'`) + `metadata`, **nunca** em `alvo_id` | `audit_log.alvo_id` é UUID (`migrations/001_initial.sql`) e o alvo é o par `(provider, workload)` — TEXT. Texto num uuid faz o INSERT estourar, e `audit()` engole a falha: a linha sumiria em silêncio, com um produtor que *parece* existir |
| Import dinâmico de `@/governance/audit.js` | Ele puxa `@/db/client.js`, que abre um pool de Postgres na importação. O disjuntor é hot path e é importado por specs sem banco; transição é evento raro |
| Fire-and-forget, drenável por `drainCircuitAudits()` | Bloquear a transição num INSERT põe a latência do Postgres na frente do provider — a falha correlacionada que o disjuntor existe para sobreviver. O dreno é o que permite ao teste provar que a LINHA chegou, e ao shutdown não perder o evento |
| `half_open` NÃO audita | É etapa interna da recuperação, não mudança de postura. Auditá-la quebraria o casamento `open`→`closed` que a regra de "stuck" do watcher faz |
| `adopted` audita como `applied` com `metadata.source` | Adotar a chave durável no boot é o mesmo desfecho de governança (a postura mudou), com procedência diferente. Ação separada obrigaria toda consulta da trilha a somar as duas |

O consumidor é a regra `llm_circuit_long_open` de
[`src/workers/audit-watcher.ts`](../../../src/workers/audit-watcher.ts) —
"aberto há mais de 5 min sem `closed`". Ela existia desde antes da #534 e
estava **morta**: até a revisão da PR #541, `grep -rn "audit(" src/lib/llm/`
devolvia zero resultados.

### Postura: `off | shadow | enforce` (`circuit-mode.ts`)

Decisão do owner na revisão da #534. **Canário por tenant/agente foi rejeitado
explicitamente** — o disjuntor protege uma dependência global e compartilhada, e
fragmentar a decisão por tenant destruiria a amostra que dá sentido ao controle
(o argumento está na tabela acima, linha "Chave"). Mas rollout global sem
alavanca também foi rejeitado. A alavanca não é por tenant: é por postura.

| Postura | O que a máquina de estados faz | O que o caller vê |
|---|---|---|
| `off` | nada; nenhum estado é guardado e a série `maia_llm_circuit_state` vira `NaN` | nada muda |
| `shadow` (**default**) | roda INTEIRA e idêntica ao `enforce` | nada muda — nenhuma recusa, nunca |
| `enforce` | roda | recusa com `circuit_open` |

**O que faz o shadow ser uma simulação e não outro experimento.** Quando a
sombra deixa passar uma chamada que o `enforce` teria recusado, o DESFECHO dessa
chamada é descartado: não entra na janela de observação. Um disjuntor que
estivesse recusando nunca teria tido aquela amostra, e alimentá-la faria a
trajetória simulada divergir justamente daquilo que ela existe para prever — as
falhas que continuam chegando durante o `open` manteriam a janela cheia, ou os
sucessos "curariam" um disjuntor que na vida real estaria cego. A sonda de
half-open é o caso oposto e por isso NÃO é descartada: ela é concedida nas duas
posturas, e é o desfecho dela que decide fechar ou reabrir.
`tests/unit/lib/llm-circuit-mode.spec.ts` compara as duas trajetórias de estado
sob a mesma sequência de falhas e exige igualdade, inclusive de `cooldown_ms` e
`failed_windows`.

**Por que a sombra não consegue derrubar uma chamada boa.** Existe UM ponto no
`circuit-breaker.ts` capaz de devolver `allowed: false` — a função `refuse()` —
e com `shadow` ela devolve `allowed: true` em todos os caminhos. Não é uma
promessa espalhada por condicionais: é uma função com uma saída só. As provas
são três e independentes: exaustiva por estado alcançável, por propriedade
(20.000 sequências pseudoaleatórias, zero recusas) e ponta a ponta pelo gateway
real comparando com `off` chamada por chamada.

**Custo no hot path.** Medido por `npm run llm:bench` (200k iterações do par
`acquireCircuit`/`releaseCircuit`, menor de 5 rodadas): `off` ~100ns, `shadow`
~770ns, `enforce` ~760ns por tentativa. A comparação que importa é
`shadow ≈ enforce` — a sombra não custa mais que o controle que ela simula, e
os ~700ns ficam três ordens de grandeza abaixo dos ~25ms da chamada sintética
mais barata (e cinco abaixo de uma chamada real de LLM).

Métricas de sombra: `maia_llm_circuit_would_open_total{provider,workload,reason}`
e `maia_llm_circuit_would_reject_total{provider,workload,state}`. A segunda é
emitida pelo GATEWAY, uma vez por CHAMADA e dentro do escopo do caller — casa
1:1 com `maia_llm_requests_total{status="circuit_open"}` e carrega a mesma
atribuição de `tenant_id + agent_id`. Contá-la dentro do disjuntor inflaria a
sombra em ~4× num workload com retry e destruiria a comparação, que é a única
razão de a métrica existir.

### Kill switch (`LLM_CIRCUIT_MODE` + override por Redis)

São **duas alavancas com custos diferentes**, e confundi-las é o erro que faz um
operador achar que já desligou o controle enquanto ele continua recusando:

| | `LLM_CIRCUIT_MODE` | override por Redis |
|---|---|---|
| O que é | postura BASE, versionada | alavanca de INCIDENTE |
| Como muda | editar env + **restart** | `SET` + `PUBLISH`, sem restart e sem deploy |
| Quanto dura | até o próximo deploy | TTL explícito, expira sozinha (default 30min, teto 24h) |
| Se o Redis cair | funciona | não propaga — cai na alavanca da esquerda |

A variável é declarada `restartRequired: true` no contrato porque é a verdade:
`config` é congelado no boot. O override anda pelo canal
`maia:llm:circuit:override` **no mesmo subscriber ioredis** do cache de settings
(`cache-invalidation.ts`) — reusar a conexão evita mexer em `src/index.ts` e na
sequência de drain, e um socket ioredis esquecido aberto é o bug que travou a
#512. A postura também mora numa chave durável com TTL, então uma réplica que
sobe no meio do incidente adota o resto do arrendamento em vez de voltar sozinha
para a postura do contrato.

O hot path continua **sem tocar em Redis**: o que anda por pub/sub é
notificação, não consulta. É a mesma razão pela qual o estado do disjuntor não
mora em Redis.

#### Propriedades distribuídas que a chave durável precisa ter (revisão da #541, gate 4 da #534)

Um kill switch com chave durável tem modos de falhar que não aparecem em teste
com Redis mockado — um mock não tem TTL de servidor, nem ordem de comandos, nem
socket que morre. Estão travados por
`tests/integration/llm-circuit-kill-switch-redis.spec.ts` e
`tests/integration/llm-circuit-reconnect-resync.spec.ts`, contra Redis real.

**1. A validade é normalizada para ABSOLUTA antes de gravar, e a chave SEMPRE
leva `PX`.** `publishCircuitOverride` (`src/lib/llm/cache-invalidation.ts:128`)
resolve `ttl_ms`/`expires_at`/default por
`resolveOverrideExpiry` (`src/lib/llm/circuit-mode.ts:178`), valida os limites
**antes** de tocar no Redis, descarta `ttl_ms` do payload persistido e publica o
mesmo payload normalizado que gravou. Sem isso, uma validade relativa na chave
durável seria reinterpretada contra o relógio de cada boot: a chave viveria para
sempre e toda réplica que reiniciasse ressuscitaria o override, atravessando
deploys sem ninguém ter decidido isso. Defesa em profundidade do lado de quem lê:
`applyCircuitOverride` com `source: 'adopted'` **recusa** payload sem
`expires_at` absoluto — pelo canal, onde a validade relativa não sobrevive a
nada, `ttl_ms` continua aceito.

*Relógio*: `expires_at` é resolvido no relógio de quem publica e comparado no de
quem recebe. Assume-se skew NTP de ordem de segundos — a mesma premissa de `exp`
de JWT e de comparações com `now()` do Postgres neste repo — contra um
arrendamento mínimo de 30min. O dano é limitado nas duas direções: réplica
adiantada volta cedo para a postura **versionada** (direção segura); réplica
atrasada estica o arrendamento pelo skew e só nela, porque o `PX` é uma duração
imposta pelo próprio Redis e nenhuma réplica nova adota depois disso. Skew
grosseiro não é adivinhado — vira `rejected` por "já vencido na chegada" ou pelo
teto de 24h, contado e logado.

**2. A adoção da chave só corre depois do `SUBSCRIBE` CONFIRMADO.**
`subscribe()` é assíncrono; disparar e seguir para o `GET` na mesma volta do
event loop põe o `GET` **antes** da inscrição existir. A réplica leria a chave
antes do `SET`, perderia o `PUBLISH`, e ficaria na postura do contrato o
incidente inteiro. Encadeando o `GET` no ack (`src/lib/llm/cache-invalidation.ts:278`),
o Redis single-threaded fecha o argumento: ou ele processa o `SET` antes do
`GET` (a chave é encontrada), ou processa o `GET` primeiro e então o `PUBLISH`
— que vem depois do `SET`, sempre — é entregue à inscrição já ativa. Não há
terceiro caso, por isso basta um `GET`. Continua best-effort: se o `SUBSCRIBE`
falhar a adoção ainda roda, sem ordenação garantida.
`llmSettingsSubscriberReady()` é o ponto em que a convergência pode ser afirmada
em vez de presumida.

**3. Quem RECONECTA relê o estado autoritativo (gate 4 da #534).** Pub/sub é
at-most-once e não tem replay: o ioredis restaura as inscrições sozinho, mas a
mensagem publicada durante a queda do socket está perdida — um operador virava o
kill switch às 3h e a réplica desconectada naquele instante seguia na postura
antiga até o TTL do arrendamento. `resyncAuthoritativeState`
(`src/lib/llm/cache-invalidation.ts`) é encadeada no `ready` do ioredis a partir
da SEGUNDA vez (a primeira é o boot, que já tem a adoção): re-inscreve e espera o
ack — recuperando o mesmo argumento de ordenação acima —, solta o cache de
settings (esse canal não tem chave; o autoritativo é o Postgres, então soltar o
cache local É a releitura dele) e relê a chave do override. Chave presente ⇒
adota o arrendamento **restante**; chave ausente ⇒ **limpa** o override local, que
é o caso do `clear` perdido durante a queda. É a releitura que fecha a lacuna: o
`subscribe` sozinho só garante o futuro.

*Ordem e idempotência*: o `GET` viaja na conexão compartilhada e as mensagens na
do subscriber, então a resposta do `GET` pode chegar ao processo depois de uma
mensagem mais nova. `overrideGeneration()` (`src/lib/llm/circuit-mode.ts`) é
capturada antes do `GET` e a releitura CEDE se ela mudou — o estado final é o do
Redis, não o da corrida.

*Fail-closed*: leitura que falha, chave ilegível, chave **recusada** pela
governança (sem `expires_at` absoluto, sem ator, vencida, acima do teto) e
re-inscrição **sem ack** — nenhuma delas vira "não há override". Em todas o
estado local é preservado e sai
`maia_llm_circuit_mode_overrides_total{reason="resync_failed"}` + log de ERRO
`llm_gateway.circuit_override_resync_failed`, com a causa no campo `outcome` e,
quando houve recusa, a ação `_rejected` com `source='resynced'` na trilha
durável (revisão do dono da #552). O ponto é que a série de CONVERGÊNCIA não
pode dizer "consistente com o Redis" quando a réplica recusou o estado
autoritativo ou leu sem inscrição ativa — seria evidência verde falsa
justamente no gate que libera o `enforce`. Sem ack, aliás, nem se lê: tratar
ausência de chave como autoritativa nesse estado limparia um override vivo com
base numa leitura indefensável.

O caso bom sai como `{reason="resynced"}`, um evento por releitura inclusive no
no-op — sem isso, "esta réplica ressincronizou?" só teria o silêncio como
resposta. `superseded` fica nesse balde de propósito: a releitura perdeu para
uma mensagem do canal, que é sempre pelo menos tão nova, e o estado final é o do
Redis.
`llmSettingsSubscriberResyncCount()` é o mesmo dado para diagnóstico e teste.
Provas em `tests/integration/llm-circuit-reconnect-resync.spec.ts` (socket morto
de verdade) e `tests/unit/lib/llm-circuit-resync.spec.ts`.

**A tensão com a #534, registrada e não escondida.** A #534 argumentou por
escrito que política de degradação é código versionado, não toggle que alguém
vira às 3h sem deixar rastro. O owner passou por cima disso, e com razão: o
argumento vale para AJUSTAR a política e não vale para DESLIGAR um controle que
está causando o incidente em vez de conter. A parte certa da objeção — "sem
deixar rastro" — foi resolvida, não ignorada:

1. **Override anônimo é RECUSADO.** `actor` e `reason` são obrigatórios e
   não-vazios. Não existe caminho para virar a chave sem se identificar.
2. **Todo uso vira contador e log**: `maia_llm_circuit_mode_overrides_total{state,reason}`
   (`reason` ∈ `applied|expired|cleared|rejected|adopted|resynced|resync_failed`) e
   `llm_gateway.circuit_mode_override` com ator, motivo e validade. Ator e
   motivo são texto livre: vivem no log, nunca em label.
3. **A postura efetiva é uma série**: `maia_llm_circuit_mode{state}`, par de
   séries com exatamente uma valendo 1. Não dá para o controle ficar desligado
   em silêncio.
4. **Expira sozinho**, e o retorno para a postura versionada também é contado.

Procedimento de operação, promoção e rollback: `docs/runbooks/operational.md`
§3.1.

### Benchmark (`scripts/llm-benchmark.ts`, issue #534)

`npm run llm:bench` roda carga contra um provider SINTÉTICO injetado por
`_injectProviderForTests()`, exercitando o gateway inteiro (deadline, retry,
fallback, disjuntor, telemetria) sem rede e sem custo. Cenários: `healthy`,
`outage`, `brownout`, `recovery`. Por default roda os TRÊS braços de postura
(`--mode all`); `--breaker both` continua valendo como alias legado.

O que ele mede de verdade: amplificação (requisições ao provider por request de
entrada), desfechos, latência vista pelo caller, tokens e custo pela mesma
tabela de preços do ledger. O que ele **não** mede: latência do provider real —
`--latency-ms` é parâmetro, não observação. Números de p50/p95/p99 contra
Anthropic/OpenRouter exigem chave, rede e dinheiro, e não saem daqui.

**Veredictos, não só tabela.** O harness sai com código 1 quando a sombra deixa
de ser sombra. Medido em `outage`, 200 requests, concorrência 10, workload
`reasoner`:

| | `off` | `shadow` | `enforce` |
|---|---|---|---|
| requisições ao provider | 800 | **800** | **10** |
| sucesso / erro | 0 / 200 | 0 / 200 | 0 / 0 |
| recusado | 0 | **0** | 200 |
| `would_reject` | 0 | **200** | 0 |
| `would_open` | 0 | 1 | 0 |
| estado final | closed | open | open |

Lê-se: a sombra chegou ao MESMO estado final do `enforce` e contou exatamente as
mesmas 200 recusas que o `enforce` executou, **sem recusar nenhuma** e sem mudar
uma única requisição ao provider em relação ao `off`. A carga que o `enforce`
cortaria é 790 requisições (−98,8%).

Só `healthy` e `outage` admitem igualdade byte a byte entre braços: em
`brownout` a sorte depende de qual requisição pegou qual índice e em `recovery`
de que lado da fronteira temporal ela caiu — sob concorrência real (e com o
`Math.random()` do backoff do gateway) isso não se repete. Nesses dois o
veredicto usa folga de 5% e diz isso na saída. Ver `DETERMINISTIC_SCENARIOS`.

### Decisão fechada: `tier` NÃO é obrigatório no call site (issue #534)

A #508 pedia que todo caller declarasse `workload` **e** `tier`. A #531 tornou
`workload` obrigatório e deixou a divergência registrada como pendente; a #534
fechou por decisão do owner: **o call site declara workload; o backend resolve
tier, provider, modelo e fallback centralmente, e exceções são políticas
governadas em `workloads.ts`, não overrides livres do caller.**

Obrigar `tier` no call site contraria o objetivo da própria issue ("apenas o
backend seleciona provider, modelo, tier e política de fallback") e devolve a
escolha de classe de modelo a quem não tem contexto para fazê-la — foi como 13
módulos acabaram com slug fixo no código. O tier continua declarado, uma vez por
workload, versionado e impossível de divergir entre dois call sites. O parâmetro
segue opcional como escape hatch (hoje só a visão usa). O argumento longo está
em `src/lib/llm/types.ts`, no campo `tier` de `LLMGatewayRequest`.

**Como fixar provider/modelo ou desligar fallback num incidente:** troque o
modelo pelo Admin (`/dashboard/llm-settings`) — a mudança propaga para todas as
réplicas; para desligar o fallback de um workload, mude `allow_fast_fallback`
na política dele em `workloads.ts` (é código, versionado e revisável de
propósito — degradação silenciosa de qualidade não deve ser toggle de runtime).

## Patterns it follows

- One wrapper per external service; call sites depend on the wrapper, not the SDK
- Metrics emitted via `metrics.ts` always carry `tenant_id + agent_id` labels
- Caches (e.g., `holidays-cache.ts`) include tenant prefix — see [tenant-isolation](../concerns/tenant-isolation.md)

## How to extend

| Need | Where |
|---|---|
| Add a new LLM provider | Novo adapter em `src/lib/llm/providers/<provider>.ts` implementando `LLMProvider`; registre em `providers/index.ts`. É o único lugar onde importar SDK de provider é permitido (lint gate). |
| Chamar um LLM de um módulo novo | `executeLLM({ workload, ... })` de `@/lib/llm/index.js`. Declare o **workload**, nunca o modelo. Se o workload é novo, adicione-o em `src/lib/llm/workloads.ts` com tier, tentativas e política de fallback. |
| Add a new external API | New file in `src/lib/`; document rate limits, retry policy, cost in the file header |
| Add a new metric | Use `incCounter()` / `observeHistogram()` / `setGauge()` with `tenant_id + agent_id` labels |
| Medir o efeito de uma mudança no gateway | `npm run llm:bench -- --scenario outage --breaker both`. Rode ANTES e DEPOIS no mesmo processo; a tabela sai em markdown pronta para colar na PR |
| Add a new currency format | Extend `brazilian.ts` (or new locale file); `decimal.js` for math |

## Public surface

| Consumed by | What |
|---|---|
| `src/agent/`, `src/tools/`, `src/skills/` | LLM, vision, audio wrappers |
| All modules | Logger, metrics, decimal |
| `src/scheduling/` | Business-days, holidays |
| `src/governance/audit.ts` | Logger, metrics |

## Tests

| Test path | What it covers |
|---|---|
| `tests/unit/lib/decimal.spec.ts` | Decimal precision contract |
| `tests/unit/lib/brazilian.spec.ts` | BR formatting |
| `tests/unit/lib/business-days.spec.ts` | Business-day arithmetic |
| `tests/unit/lib/holidays-cache.spec.ts` | Per-tenant cache keys |
| `tests/unit/lib/llm-gateway.spec.ts` | Contrato do gateway: tier, retry, deadline, fallback, telemetria, redaction |
| `tests/unit/lib/llm-circuit-breaker.spec.ts` | Máquina de estados do disjuntor em `enforce` + teste de carga que mede a queda de requisições durante indisponibilidade + **tempestade de timeout do SDK** no `reasoner` através do gateway real (abertura, carga cortada, tempo poupado, ausência de retry) |
| `tests/unit/lib/llm-circuit-mode.spec.ts` | Posturas `off`/`shadow`/`enforce`, fidelidade da simulação em sombra, e o kill switch (auditoria, TTL, recusa de override anônimo) |
| `tests/unit/lib/llm-circuit-override-channel.spec.ts` | Transporte do kill switch: roteamento por canal, ordem `SET` antes de `PUBLISH`, normalização de `ttl_ms` para `expires_at` absoluto + `PX` obrigatório, recusa de adoção com validade relativa, e falha de Redis propagada |
| `tests/integration/llm-circuit-kill-switch-redis.spec.ts` | **Redis real** — o que um mock não sabe provar: a chave carrega `PTTL` de verdade e morre sozinha (nenhum restart ressuscita override vencido), e o `GET` da adoção chega ao servidor depois do `SUBSCRIBE` (ordem lida do `MONITOR`), com a corrida réplica-subindo-durante-a-virada convergindo para o override |
| `tests/integration/llm-circuit-audit-real-db.spec.ts` | **Postgres real** — o que um `audit()` mockado não sabe provar: a LINHA chega em `audit_log` (o `alvo_id` uuid não engoliu a escrita), está no contexto `system`, e o watcher encontra o par `open`/`closed` e detecta o caso "stuck" |

## In-flight changes

At last verification (2026-05-28):

- Holidays-cache include agent_id in cache key v2 (#263 → #272 — open)
- LLM AbortSignal plumbed for prompt_only/evaluator (#221 — merged, exercises `claude.ts`)

Verify: `gh pr list --state open --search "holidays OR cache OR llm OR claude"`.

---

| | |
|---|---|
| Last verified | 2026-05-28 |
| Against `main` HEAD | `c49c3855` |
