import { z } from 'zod';
import 'dotenv/config';
import { assertSafeAuthDir } from '@/setup/auth-dir.js';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    TZ: z.string().default('America/Sao_Paulo'),
    APP_PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

    DATABASE_URL: z.string().url(),
    POSTGRES_USER: z.string().min(1),
    POSTGRES_PASSWORD: z.string().min(8),
    POSTGRES_DB: z.string().min(1),
    POSTGRES_PORT: z.coerce.number().int().positive().default(5432),

    REDIS_URL: z.string().url(),
    REDIS_PORT: z.coerce.number().int().positive().default(6379),

    LLM_PROVIDER: z.enum(['anthropic', 'openrouter']).default('anthropic'),
    ANTHROPIC_API_KEY: z.string().startsWith('sk-ant-').optional(),
    OPENROUTER_API_KEY: z.string().startsWith('sk-or-').optional(),
    OPENROUTER_MODEL_MAIN: z.string().default('anthropic/claude-sonnet-4.6'),
    OPENROUTER_MODEL_FAST: z.string().default('anthropic/claude-haiku-4.5'),
    CLAUDE_MODEL_MAIN: z.string().default('claude-sonnet-4-6'),
    CLAUDE_MODEL_FAST: z.string().default('claude-haiku-4-5-20251001'),
    OPENAI_API_KEY: z.string().startsWith('sk-').optional(),

    WHISPER_PROVIDER: z.enum(['openai']).default('openai'),
    WHISPER_MODEL: z.string().default('whisper-1'),

    EMBEDDING_PROVIDER: z.enum(['voyage', 'openai', 'cohere']).default('voyage'),
    EMBEDDING_MODEL: z.string().default('voyage-3'),
    EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1024),
    VOYAGE_API_KEY: z.string().optional(),
    COHERE_API_KEY: z.string().optional(),

    BAILEYS_AUTH_DIR: z.string().default('./.baileys-auth'),
    WHATSAPP_NUMBER_MAIA: z.string().regex(/^\+\d{10,15}$/),
    MAIA_DISPLAY_NAME: z.string().default('Maia'),

    OWNER_TELEFONE_WHATSAPP: z.string().regex(/^\+\d{10,15}$/),
    OWNER_NOME: z.string().min(1),

    VALOR_LIMITE_SEM_CONFIRMACAO: z.coerce.number().nonnegative().default(1000),
    VALOR_DUAL_APPROVAL: z.coerce.number().nonnegative().default(20000),
    VALOR_LIMITE_DURO: z.coerce.number().positive().default(50000),
    DUAL_APPROVAL_TIMEOUT_HOURS: z.coerce.number().int().positive().default(6),
    AUDIT_MODE_TTL_HOURS: z.coerce.number().int().positive().default(24),
    IDEMPOTENCY_BUCKET_MINUTES: z.coerce.number().int().positive().default(5),
    PENDING_QUESTION_TTL_MINUTES: z.coerce.number().int().positive().default(120),
    PENDING_ACTION_TTL_HOURS: z.coerce.number().int().positive().default(6),
    RATE_LIMIT_MSGS_PER_HOUR: z.coerce.number().int().positive().default(30),

    CLAUDE_MAX_RETRIES: z.coerce.number().int().nonnegative().default(3),
    CLAUDE_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
    WHATSAPP_RECONNECT_ALERT_MIN: z.coerce.number().int().positive().default(5),

    ALERT_CHANNELS: z
      .string()
      .default('email')
      .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    ALERT_EMAIL_TO: z.string().email().optional(),
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    TELEGRAM_CHAT_ID: z.string().optional(),

    BACKUP_DIR: z.string().default('./backups'),
    BACKUP_RETENTION_LOCAL_DAYS: z.coerce.number().int().positive().default(7),
    BACKUP_RETENTION_CLOUD_DAYS: z.coerce.number().int().positive().default(30),
    BACKUP_S3_BUCKET: z.string().optional(),
    // Optional custom endpoint for S3-compatible providers (Backblaze B2,
    // Cloudflare R2, Wasabi, etc.). Leave unset for AWS S3 native.
    BACKUP_S3_ENDPOINT: z.string().url().optional(),
    BACKUP_S3_REGION: z.string().default('us-east-1'),
    BACKUP_S3_ACCESS_KEY: z.string().optional(),
    BACKUP_S3_SECRET_KEY: z.string().optional(),
    // S3 path prefix inside the bucket (no leading or trailing slash).
    BACKUP_S3_PREFIX: z.string().default('maia'),

    DAILY_LLM_USD_THRESHOLD: z.coerce.number().positive().default(5),
    DLQ_ALERT_THRESHOLD: z.coerce.number().int().positive().default(10),

    FEATURE_PROACTIVE_MESSAGES: z
      .string()
      .default('false')
      .transform((s) => s === 'true' || s === '1'),
    FEATURE_OFX_IMPORT: z
      .string()
      .default('false')
      .transform((s) => s === 'true' || s === '1'),
    FEATURE_DASHBOARD: z
      .string()
      .default('false')
      .transform((s) => s === 'true' || s === '1'),
    FEATURE_PENDING_GATE: z
      .string()
      .default('false')
      .transform((s) => s === 'true' || s === '1'),
    FEATURE_PRESENCE: z
      .string()
      .default('false')
      .transform((s) => s === 'true' || s === '1'),
    FEATURE_ONE_TAP: z
      .string()
      .default('false')
      .transform((s) => s === 'true' || s === '1'),
    FEATURE_MESSAGE_UPDATE: z
      .string()
      .default('false')
      .transform((s) => s === 'true' || s === '1'),
    FEATURE_PENDING_REMINDER: z
      .string()
      .default('false')
      .transform((s) => s === 'true' || s === '1'),
    FEATURE_VIEW_ONCE_SENSITIVE: z
      .string()
      .default('false')
      .transform((s) => s === 'true' || s === '1'),
    FEATURE_PDF_REPORTS: z
      .string()
      .default('false')
      .transform((s) => s === 'true' || s === '1'),
    FEATURE_OUTBOUND_VOICE: z
      .string()
      .default('false')
      .transform((s) => s === 'true' || s === '1'),
    // Feature flags do roadmap Maia v2
    FEATURE_P0_TENANT_GUARD_ENFORCED: z
      .string()
      .default('false')
      .transform((s) => s === 'true' || s === '1'),
    // Spec 18 — Scheduling V2 (series/occurrences/tasks/outbox). When off,
    // the scheduling workers and start_recurring_* tools are inert; the
    // schedule_reminder tool still works because it just writes a series
    // row, but no firing happens. Default off — production rollout per §12.
    FEATURE_SCHEDULING_V2: z
      .string()
      .default('false')
      .transform((s) => s === 'true' || s === '1'),
    // Outbox drain backpressure — spec 18 §7.2. Defaults are conservative;
    // tune per WhatsApp account standing.
    OUTBOX_MAX_PER_SECOND: z.coerce.number().positive().default(1),
    OUTBOX_MAX_PER_HOUR: z.coerce.number().int().positive().default(600),
    OUTBOX_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),
    OUTBOX_LEASE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
    OCCURRENCE_LEASE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
    // Spec 18 §7.2 backpressure cadence (Blocker 4, review 2):
    // outbox-drain is a cron job firing once per minute, but the rate
    // gate is per-second. Without a loop inside one firing, only ~1 msg
    // per minute drains regardless of OUTBOX_MAX_PER_SECOND. We loop
    // up to this many passes within one tick, sleeping ~1s between
    // when rate-limited, so 10k backlog drains at the configured rate.
    // Set to 1 in tests for predictable behaviour.
    OUTBOX_DRAIN_LOOP_PASSES: z.coerce.number().int().positive().default(55),
    OUTBOX_DRAIN_LOOP_SLEEP_MS: z.coerce.number().int().nonnegative().default(1000),
    // Message debounce: hold incoming text messages from the same user for a
    // short window so chunked typing ("Oi, " / "como está " / "a finança?")
    // arrives at the LLM as a single coherent turn. Off by default — when on,
    // each new text resets the timer up to MESSAGE_DEBOUNCE_MAX_MS, then the
    // worker aggregates all unprocessed inbound texts in the conversation.
    // Media (audio/imagem/documento) bypasses the buffer and runs immediately.
    FEATURE_MESSAGE_DEBOUNCE: z
      .string()
      .default('false')
      .transform((s) => s === 'true' || s === '1'),
    // P84-Op (PR #84 review): kill switch for the P3b procedure runtime
    // (selector + engine + post-turn evaluator). When OFF, the runtime
    // no-ops: no selector decisions are recorded, no executions are
    // created, no events are emitted. Defaults to ON. Set to 'false'
    // when zombie executions accumulate or any procedure-runtime bug
    // surfaces in prod before P3c lands. The baseline ReAct turn is
    // unaffected either way — procedure runtime never blocks reply.
    FEATURE_PROCEDURE_RUNTIME: z
      .string()
      .default('true')
      .transform((s) => s === 'true' || s === '1'),
    // PR #84 Minor #5: selector confidence threshold was hardcoded at 0.6.
    // Different tenants/agents have different acceptable false-positive
    // rates; expose as env override so ops can tune without a redeploy.
    // Constrained to (0, 1] — 0 would auto-start on any candidate.
    PROCEDURE_SELECTOR_CONFIDENCE_THRESHOLD: z.coerce
      .number()
      .gt(0)
      .lte(1)
      .default(0.6),
    MESSAGE_DEBOUNCE_MS: z.coerce.number().int().positive().default(5000),
    MESSAGE_DEBOUNCE_MAX_MS: z.coerce.number().int().positive().default(30000),
    // SETUP: optional override for the bootstrap token. When set, bypasses
    // the file-backed token. Discouraged in prod (env vars leak more than
    // file mode 0o600). Useful for dev / scripted deploys / E2E tests.
    SETUP_TOKEN_OVERRIDE: z.string().optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.LLM_PROVIDER === 'anthropic' && !cfg.ANTHROPIC_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'ANTHROPIC_API_KEY required when LLM_PROVIDER=anthropic',
      });
    }
    if (cfg.LLM_PROVIDER === 'openrouter' && !cfg.OPENROUTER_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'OPENROUTER_API_KEY required when LLM_PROVIDER=openrouter',
      });
    }
    if (cfg.EMBEDDING_PROVIDER === 'voyage' && !cfg.VOYAGE_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'VOYAGE_API_KEY required when EMBEDDING_PROVIDER=voyage',
      });
    }
    if (cfg.EMBEDDING_PROVIDER === 'openai' && !cfg.OPENAI_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'OPENAI_API_KEY required when EMBEDDING_PROVIDER=openai',
      });
    }
    if (cfg.EMBEDDING_PROVIDER === 'cohere' && !cfg.COHERE_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'COHERE_API_KEY required when EMBEDDING_PROVIDER=cohere',
      });
    }
    if (
      cfg.ALERT_CHANNELS.includes('telegram') &&
      (!cfg.TELEGRAM_BOT_TOKEN || !cfg.TELEGRAM_CHAT_ID)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Telegram alerts require TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID',
      });
    }
    if (cfg.ALERT_CHANNELS.includes('email') && !cfg.ALERT_EMAIL_TO) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Email alerts require ALERT_EMAIL_TO',
      });
    }
    if (cfg.OWNER_TELEFONE_WHATSAPP === cfg.WHATSAPP_NUMBER_MAIA) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'OWNER_TELEFONE_WHATSAPP must differ from WHATSAPP_NUMBER_MAIA',
      });
    }
    try {
      assertSafeAuthDir(cfg.BAILEYS_AUTH_DIR);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BAILEYS_AUTH_DIR'],
        message: (err as Error).message,
      });
    }
  });

export type Config = z.infer<typeof envSchema>;

function loadConfig(): Config {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    // Throw instead of process.exit(1) - main().catch in index.ts handles
    // fatal logging and exit. Throwing keeps vitest alive when a spec file
    // imports a config-dependent module without mocking env.
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return result.data;
}

export const config: Config = loadConfig();
