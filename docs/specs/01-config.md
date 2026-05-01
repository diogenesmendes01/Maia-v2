# Spec 01 — Configuration & Secrets

**Status:** Foundation • **Phase:** 1 • **Depends on:** 00

---

## 1. Purpose

Define how Maia loads, validates, and exposes runtime configuration. All configuration enters the application through a single typed surface (`src/config/env.ts`) so that no module reads `process.env` directly.

## 2. Goals

- Fail fast on invalid or missing configuration — never start a misconfigured Maia.
- Single, typed `Config` object exported to the rest of the app.
- Multi-provider abstraction for LLM and embeddings (selected at runtime via env).
- Explicit feature flags for behaviors that change between phases.
- Hygiene rules for secrets (never logged, never in errors).

## 3. Non-goals

- Hot-reloading configuration. Changes require process restart.
- Remote/centralized config (Consul, AWS SSM). Single VPS, `.env` is enough.
- LGPD/GDPR compliance frameworks. Personal use, out of scope.

## 4. Architecture

### 4.1 Loading sequence

```
1. dotenv loads .env into process.env
2. envSchema (Zod) parses process.env
3. On parse failure: log structured error, process.exit(1)
4. On success: export typed Config { ... }
5. All modules import { config } from 'src/config/env'
```

There is exactly **one** import of `process.env` in the codebase, inside `env.ts`. Lint enforces this.

### 4.2 Provider abstraction

Two providers are pluggable: **LLM** and **Embedding**. Both follow the same pattern:

```typescript
// LLM provider
type LLMProvider = 'anthropic' | 'openrouter';

// Embedding provider
type EmbeddingProvider = 'voyage' | 'openai' | 'cohere';
```

The provider name selects an implementation that conforms to a stable interface (defined in specs 06 and 08 respectively). Switching providers is an env change + restart, but **changing embedding dimensions requires a migration** (see spec 08).

## 5. Schema

### 5.1 Zod schema (canonical)

```typescript
import { z } from 'zod';

const envSchema = z.object({
  // Runtime
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  TZ: z.string().default('America/Sao_Paulo'),
  APP_PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Database
  DATABASE_URL: z.string().url(),
  POSTGRES_USER: z.string().min(1),
  POSTGRES_PASSWORD: z.string().min(8),
  POSTGRES_DB: z.string().min(1),
  POSTGRES_PORT: z.coerce.number().int().positive().default(5432),

  // Redis
  REDIS_URL: z.string().url(),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),

  // LLM (primary). Operators wanting GPT / Llama / Gemini / DeepSeek route
  // through OpenRouter — runtime model picked via /dashboard/llm-settings.
  LLM_PROVIDER: z.enum(['anthropic', 'openrouter']).default('anthropic'),
  ANTHROPIC_API_KEY: z.string().startsWith('sk-ant-').optional(),
  CLAUDE_MODEL_MAIN: z.string().default('claude-sonnet-4-6'),
  CLAUDE_MODEL_FAST: z.string().default('claude-haiku-4-5-20251001'),
  OPENROUTER_API_KEY: z.string().startsWith('sk-or-').optional(),
  OPENROUTER_MODEL_MAIN: z.string().default('anthropic/claude-sonnet-4.6'),
  OPENROUTER_MODEL_FAST: z.string().default('anthropic/claude-haiku-4.5'),
  OPENAI_API_KEY: z.string().startsWith('sk-').optional(), // used by Whisper, not LLM

  // Whisper (audio)
  WHISPER_PROVIDER: z.enum(['openai']).default('openai'),
  WHISPER_MODEL: z.string().default('whisper-1'),

  // Embeddings
  EMBEDDING_PROVIDER: z.enum(['voyage', 'openai', 'cohere']).default('voyage'),
  EMBEDDING_MODEL: z.string().default('voyage-3'),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1024),
  VOYAGE_API_KEY: z.string().optional(),

  // WhatsApp / Baileys
  BAILEYS_AUTH_DIR: z.string().default('./.baileys-auth'),
  WHATSAPP_NUMBER_MAIA: z.string().regex(/^\+\d{10,15}$/),
  MAIA_DISPLAY_NAME: z.string().default('Maia'),

  // Owner
  OWNER_TELEFONE_WHATSAPP: z.string().regex(/^\+\d{10,15}$/),
  OWNER_NOME: z.string().min(1),

  // Governance limits (defaults; can be overridden per-pessoa via permissoes.limites)
  VALOR_LIMITE_SEM_CONFIRMACAO: z.coerce.number().nonnegative().default(1000),
  VALOR_DUAL_APPROVAL: z.coerce.number().nonnegative().default(20000),
  VALOR_LIMITE_DURO: z.coerce.number().positive().default(50000),
  DUAL_APPROVAL_TIMEOUT_HOURS: z.coerce.number().int().positive().default(6),
  AUDIT_MODE_TTL_HOURS: z.coerce.number().int().positive().default(24),
  PENDING_QUESTION_TTL_MINUTES: z.coerce.number().int().positive().default(120),
  PENDING_ACTION_TTL_HOURS: z.coerce.number().int().positive().default(6),
  RATE_LIMIT_MSGS_PER_HOUR: z.coerce.number().int().positive().default(30),

  // Resilience
  CLAUDE_MAX_RETRIES: z.coerce.number().int().nonnegative().default(3),
  CLAUDE_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  WHATSAPP_RECONNECT_ALERT_MIN: z.coerce.number().int().positive().default(5),

  // Alerts
  ALERT_CHANNELS: z.string().default('email').transform(s => s.split(',')),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  ALERT_EMAIL_TO: z.string().email().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),

  // Backup
  BACKUP_DIR: z.string().default('./backups'),
  BACKUP_RETENTION_LOCAL_DAYS: z.coerce.number().int().positive().default(7),
  BACKUP_RETENTION_CLOUD_DAYS: z.coerce.number().int().positive().default(30),
  BACKUP_S3_BUCKET: z.string().optional(),

  // Feature flags
  FEATURE_PROACTIVE_MESSAGES: z.coerce.boolean().default(false),
  FEATURE_OFX_IMPORT: z.coerce.boolean().default(false),
  FEATURE_DASHBOARD: z.coerce.boolean().default(false),
});

export type Config = z.infer<typeof envSchema>;
export const config = envSchema.parse(process.env);
```

### 5.2 Validation matrix (cross-field)

After Zod parsing, additional refinements:

```typescript
envSchema.superRefine((cfg, ctx) => {
  if (cfg.LLM_PROVIDER === 'anthropic' && !cfg.ANTHROPIC_API_KEY) {
    ctx.addIssue({ code: 'custom', message: 'ANTHROPIC_API_KEY required when LLM_PROVIDER=anthropic' });
  }
  if (cfg.LLM_PROVIDER === 'openrouter' && !cfg.OPENROUTER_API_KEY) {
    ctx.addIssue({ code: 'custom', message: 'OPENROUTER_API_KEY required when LLM_PROVIDER=openrouter' });
  }
  if (cfg.EMBEDDING_PROVIDER === 'voyage' && !cfg.VOYAGE_API_KEY) {
    ctx.addIssue({ code: 'custom', message: 'VOYAGE_API_KEY required when EMBEDDING_PROVIDER=voyage' });
  }
  if (cfg.ALERT_CHANNELS.includes('telegram') && (!cfg.TELEGRAM_BOT_TOKEN || !cfg.TELEGRAM_CHAT_ID)) {
    ctx.addIssue({ code: 'custom', message: 'Telegram alerts require TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID' });
  }
  if (cfg.ALERT_CHANNELS.includes('email') && !cfg.ALERT_EMAIL_TO) {
    ctx.addIssue({ code: 'custom', message: 'Email alerts require ALERT_EMAIL_TO' });
  }
  if (cfg.OWNER_TELEFONE_WHATSAPP === cfg.WHATSAPP_NUMBER_MAIA) {
    ctx.addIssue({ code: 'custom', message: 'OWNER_TELEFONE_WHATSAPP must differ from WHATSAPP_NUMBER_MAIA' });
  }
});
```

The owner-vs-Maia phone check is critical: if equal, Maia would try to talk to herself.

## 6. LLM Boundaries

The LLM has **no access to** the `Config` object. Configuration is purely backend concern. The agent reads only the runtime *behavior* derived from config (e.g. "audit mode is active") through dedicated read paths, never as raw env.

## 7. Behavior & Rules

### 7.1 Secrets hygiene

- All fields whose name contains `KEY`, `TOKEN`, `PASS`, `SECRET` are **redacted** when logged.
- Pino's `redact` paths are configured to remove these from any log object.
- Errors thrown during LLM/HTTP calls strip these fields before being captured.
- The `.env` file is in `.gitignore`. Pre-commit hook (optional) blocks commits containing strings matching `sk-ant-*` or `sk-*`.

### 7.2 Defaults vs explicit

Defaults exist only for **non-secret, low-risk** values (timeouts, ports, TTLs). Anything that costs money or controls security has **no default** and must be set explicitly.

### 7.3 Reading config in app code

```typescript
import { config } from 'src/config/env';
// good: typed, validated
const port = config.APP_PORT;

// forbidden: lint blocks this
const x = process.env.APP_PORT;
```

ESLint rule: `no-process-env` everywhere except `src/config/env.ts`.

## 8. Error cases

| Failure | Behavior |
|---------|----------|
| Missing required env | Process exits with structured error listing every missing field |
| Invalid format (e.g., URL) | Process exits with the field name and the violated constraint |
| Cross-field violation (e.g., `OPENROUTER_API_KEY` missing when `LLM_PROVIDER=openrouter`) | Process exits with explanatory message |
| Owner phone equals Maia phone | Process exits with explanatory message |

All exits are **before** any external connection (DB, Redis, Anthropic). No partial startup.

## 9. Acceptance criteria

- [ ] `npm run dev` with empty `.env` exits in < 1s with a list of every missing required field.
- [ ] `process.env` is referenced in exactly one file (`src/config/env.ts`).
- [ ] Logs contain no API keys after running a sample interaction (verified by grep on log fixtures).
- [ ] Switching `LLM_PROVIDER` between `anthropic` and `openrouter` requires only env change + restart, no code edit. Once on `openrouter`, switching individual models is operator-driven via `/dashboard/llm-settings` (no restart).
- [ ] Tests cover: missing field, invalid URL, cross-field violation, owner==Maia phone collision.

## 10. References

- Spec 06 — agent loop (LLM provider interface)
- Spec 08 — memory (embedding provider interface)
- Spec 17 — observability (logging redaction)
