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
| `telemetry.ts` | Métrica, custo e evento de uso — em TODO desfecho |
| `cache-invalidation.ts` | Redis pub/sub: troca de modelo no Admin vale em todas as réplicas |

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
| Limiar de abertura | Derivado do orçamento de tentativas: `0.5 ^ (1/tentativas)` | 50% fixo por tentativa está errado quando há retry: com `reasoner` (3 tentativas + fallback), 70% de erro por tentativa ainda entrega ~76% das chamadas. O harness mediu o estrago do limiar fixo — disponibilidade de 161/200 para 9/200. Quem trata brownout é o retry; quem trata queda é o disjuntor |
| Amostra mínima | 10 tentativas em janela de 30s | Sem piso, duas falhas de madrugada abrem com "100% de erro" sobre amostra 2 |
| Half-open | Até **3** sondas por janela, fecha na primeira que passar | Uma sonda só deixava preso em aberto um provider parcialmente saudável. Numa queda real o custo é 3 requisições por janela |
| Cooldown | 5s, dobrando a cada janela de sondas que falha inteira, teto de 60s | O cooldown é o tempo em que ainda recusamos DEPOIS de o provider voltar: medido em 10s, custava ~63 requests a mais numa corrida de 200; com 5s caiu para ~52 e a queda longa continua protegida pelo backoff |
| Sem env var | Constantes versionadas | Mesma postura de `allow_fast_fallback`: degradação não deve ser toggle de runtime que alguém vira às 3h sem deixar rastro |

Métricas: `maia_llm_circuit_state{provider,workload}` (gauge — `0` closed, `1`
half_open, `2` open; é a série que o runbook §8 documentava e que **nada
emitia** até esta issue), `maia_llm_circuit_transitions_total{from,to}` e
`maia_llm_circuit_short_circuited_total`. Toda transição também sai no log como
`llm_gateway.circuit_transition` com o motivo.

Recusa é o kind `circuit_open`: não retentável (retentar é o que o disjuntor
impede), com `retry_after_ms` = cooldown restante, e emitida ANTES de resolver
modelo ou reservar cota — uma chamada que não vai acontecer não carimba
orçamento.

### Benchmark (`scripts/llm-benchmark.ts`, issue #534)

`npm run llm:bench` roda carga contra um provider SINTÉTICO injetado por
`_injectProviderForTests()`, exercitando o gateway inteiro (deadline, retry,
fallback, disjuntor, telemetria) sem rede e sem custo. Cenários: `healthy`,
`outage`, `brownout`, `recovery`; `--breaker both` produz a tabela antes/depois.

O que ele mede de verdade: amplificação (requisições ao provider por request de
entrada), desfechos, latência vista pelo caller, tokens e custo pela mesma
tabela de preços do ledger. O que ele **não** mede: latência do provider real —
`--latency-ms` é parâmetro, não observação. Números de p50/p95/p99 contra
Anthropic/OpenRouter exigem chave, rede e dinheiro, e não saem daqui.

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
| `tests/unit/lib/llm-circuit-breaker.spec.ts` | Máquina de estados do disjuntor + teste de carga que mede a queda de requisições durante indisponibilidade |

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
