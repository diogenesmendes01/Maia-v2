# lib

**Path:** `src/lib/`

**Purpose** — Thin wrappers around external services and shared utilities. Anthropic (Claude), OpenAI (Whisper, TTS), Vision (Claude Vision), Redis, Pino logger, Prometheus-compatible metrics, alerts (email + Telegram), business-day calendar with Brazilian holidays, decimal precision (`decimal.js`), embeddings, PDF generation, cost ledger, healthcheck. Each wrapper has one job; call sites depend on the wrapper, not the underlying SDK.

## Key files

| File | Role |
|---|---|
| `src/lib/claude.ts` | Anthropic SDK wrapper — `callLLM()`, streaming, tool use, cost tracking |
| `src/lib/openrouter-models.ts` | OpenRouter model catalog (alternative LLM source) |
| `src/lib/llm-settings.ts` | Per-tenant LLM configuration |
| `src/lib/whisper.ts` | OpenAI Whisper (audio transcription) |
| `src/lib/tts.ts` | OpenAI TTS (outbound voice notes) |
| `src/lib/vision.ts` | Claude Vision (boleto / receipt parsing) |
| `src/lib/embeddings.ts` | Embedding generation for vector memory |
| `src/lib/redis.ts` | ioredis client + helpers |
| `src/lib/logger.ts` | Pino structured logger |
| `src/lib/metrics.ts` | `incCounter`, `observeHistogram`, `setGauge` + Prometheus registry |
| `src/lib/alerts.ts` | Email + Telegram alert channels |
| `src/lib/healthcheck.ts` | Liveness/readiness probes |
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

## Patterns it follows

- One wrapper per external service; call sites depend on the wrapper, not the SDK
- Metrics emitted via `metrics.ts` always carry `tenant_id + agent_id` labels
- Caches (e.g., `holidays-cache.ts`) include tenant prefix — see [tenant-isolation](../concerns/tenant-isolation.md)

## How to extend

| Need | Where |
|---|---|
| Add a new LLM provider | New wrapper in `src/lib/<provider>.ts`; expose same `callLLM()` shape; route via `llm-settings.ts` |
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
