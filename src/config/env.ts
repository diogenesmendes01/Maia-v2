import { z } from 'zod';
import 'dotenv/config';

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
    OLLAMA_BASE_URL: z.string().url().optional(),
    OLLAMA_MODEL: z.string().optional(),

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

    DAILY_LLM_USD_THRESHOLD: z.coerce.number().positive().default(5),

    FEATURE_PROACTIVE_MESSAGES: z
      .string()
      .default('false')
      .transform((s) => s === 'true' || s === '1'),
    FEATURE_OLLAMA_FALLBACK: z
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
