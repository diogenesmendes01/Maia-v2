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
`response_invalid` e `budget_exhausted` são terminais de primeira. `Retry-After`
do provider vence o backoff local. Cancelamento nunca é tratado como erro
retryable.

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
