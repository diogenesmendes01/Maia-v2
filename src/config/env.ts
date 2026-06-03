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
    // #227 — outbound delivery idempotency ledger. When on, dispatch routes
    // record pre-send / mark-sent / mark-failed against `outbound_messages`,
    // and the safeDispatchOutput boundary short-circuits already-attempted
    // turns. Default off so the migration can deploy ahead of the wiring.
    FEATURE_OUTBOUND_DEDUP: z
      .string()
      .default('false')
      .transform((s) => s === 'true' || s === '1'),
    // #292 — outbound_messages sweeper cutoffs (follow-up de #227/#233).
    // OUTBOUND_SWEEPER_STALE_PENDING_SEC: rows em status='pending' com
    //   created_at < now() - N são promovidas a 'unknown' (terminal per #233).
    //   Default 300s (5min) — folga grande contra o tempo normal de send+persist.
    // OUTBOUND_SWEEPER_RETENTION_DAYS: rows terminais (sent/failed/unknown) com
    //   age > N dias são DELETADAS no mesmo sweeper pass. Default 30 dias.
    OUTBOUND_SWEEPER_STALE_PENDING_SEC: z.coerce.number().int().positive().default(300),
    OUTBOUND_SWEEPER_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
    // #292 Codex blocker #1 — retention DELETE batch size. The retention
    //   cleanup deletes terminal rows in bounded chunks (DELETE ... WHERE id IN
    //   (SELECT ... LIMIT N)) and loops until a pass returns 0 rows, so a large
    //   backlog never holds a table-wide lock for a single unbounded DELETE.
    //   Default 1000 — balances per-statement overhead vs WAL/replication lag.
    OUTBOUND_SWEEPER_RETENTION_BATCH_SIZE: z.coerce.number().int().positive().default(1000),
    // #292 Codex blocker #2 — per-tenant fairness cap on stale-pending
    //   recovery. Each tenant promotes AT MOST this many stale-pending rows per
    //   pass (oldest first), so a single high-volume tenant cannot consume the
    //   whole sweep window and starve later tenants. Default 500 — the next
    //   */5min tick drains any remainder. Promotion is expected to be 0/rare in
    //   healthy operation (each promotion is an ops_alert).
    OUTBOUND_SWEEPER_RECOVERY_LIMIT_PER_TENANT: z.coerce.number().int().positive().default(500),
    // #316 — idempotency transactional effect outbox relayer. The relayer
    //   (src/workers/idempotency-outbox-relayer.ts) runs every minute, single-
    //   flight (GLOBAL advisory lock), per-tenant fan-out, and dispatches each
    //   committed pending effect EXACTLY ONCE with retry/backoff.
    // OUTBOX_RELAYER_BATCH_PER_TENANT: max pending effects dispatched per
    //   (tenant, agent) per pass (oldest-first fairness). Default 100 — the
    //   next */1min tick drains any remainder; a high-volume tenant can't
    //   starve others within one pass.
    OUTBOX_RELAYER_BATCH_PER_TENANT: z.coerce.number().int().positive().default(100),
    // OUTBOX_RELAYER_BASE_BACKOFF_SEC: base of the exponential backoff applied
    //   on a transient dispatch failure. next_attempt_at is pushed forward by
    //   base * 2^attempts (capped at the max below). Default 30s.
    OUTBOX_RELAYER_BASE_BACKOFF_SEC: z.coerce.number().int().positive().default(30),
    // OUTBOX_RELAYER_MAX_BACKOFF_SEC: cap on the backoff interval so a row that
    //   has retried many times still gets revisited within a bounded window.
    //   Default 3600s (1h).
    OUTBOX_RELAYER_MAX_BACKOFF_SEC: z.coerce.number().int().positive().default(3600),
    // OUTBOX_RELAYER_RETENTION_DAYS: terminal rows (sent/failed) older than this
    //   are deleted in the same pass (bounded batched DELETE). Default 30 days.
    OUTBOX_RELAYER_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
    // OUTBOX_RELAYER_RETENTION_BATCH_SIZE: bounded retention DELETE chunk size
    //   (mirrors OUTBOUND_SWEEPER_RETENTION_BATCH_SIZE). Default 1000.
    OUTBOX_RELAYER_RETENTION_BATCH_SIZE: z.coerce.number().int().positive().default(1000),
    // Feature flags do roadmap Maia v2
    // P6 — FEATURE_MULTI_CHANNEL removed in #411: channel resolution now has a
    //   single-tenant catch-all (resolves any sender to default/default), so the
    //   toggle is always-on / gone.
    // P7 — FEATURE_COGNITIVE_GRAPH removed in #412: the cognitive graph runs
    //   unconditionally (parity with the imperative path proven), so there is no
    //   env toggle. The SYNC_LATENCY_P95_* budget vars below remain — they gate
    //   p95 latency, not the graph itself.
    /** Cache TTL (ms) for PolicyResolverCache. Default 5min = 300_000ms. */
    POLICY_RESOLVER_CACHE_TTL_MS: z.coerce.number().int().positive().default(300_000),
    /** LRU cap for PolicyResolverCache. Default 10_000 entries. */
    POLICY_RESOLVER_CACHE_MAX_ENTRIES: z.coerce.number().int().positive().default(10_000),
    /** HMAC key version currently in use (rotates every 90d). */
    RUNTIME_TRACE_HMAC_KEY_VERSION: z.coerce.number().int().positive().default(1),
    /** Master secret material (test only — prod fetches from KMS). */
    RUNTIME_TRACE_HMAC_MASTER_SECRET: z.string().optional(),
    /**
     * Previous HMAC master secrets for audit-row verification after rotation.
     * Format: semicolon-separated `version=secret` pairs, e.g.:
     *   "1=<old-secret>;2=<older-secret>"
     * The current master secret is keyed separately in RUNTIME_TRACE_HMAC_MASTER_SECRET
     * (at RUNTIME_TRACE_HMAC_KEY_VERSION). Previous secrets are retained here
     * through the audit-retention window so old rows remain verifiable.
     * Round-2 finding #3 fix.
     */
    RUNTIME_TRACE_HMAC_PREV_MASTER_SECRETS: z.string().optional(),
    /** S3 bucket for debug-mode encrypted snapshots (24h TTL). */
    RUNTIME_TRACE_DEBUG_S3_BUCKET: z.string().optional(),
    /** AES-GCM key (base64) for debug-mode snapshot encryption. */
    RUNTIME_TRACE_DEBUG_AES_KEY: z.string().optional(),
    /** Max age in seconds of a pending envelope body before recoverer alerts (default 300). */
    RUNTIME_TRACE_BODY_ORPHAN_SEC: z.coerce.number().int().positive().default(300),
    /** Refresh interval for unified_trace_events matview (worker schedules; this is metadata only). */
    RUNTIME_TRACE_MATVIEW_REFRESH_SEC: z.coerce.number().int().positive().default(300),
    /** Baseline pré-P7 em ms para p95 do sync path. Se ausente, gate skipa. */
    SYNC_LATENCY_P95_BASELINE_MS: z.coerce.number().int().positive().optional(),
    /** Percentual extra permitido sobre baseline (default 20). */
    SYNC_LATENCY_P95_BUDGET_PERCENT: z.coerce.number().int().nonnegative().default(20),
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
    // Outbox backpressure caps (per agent instance). Defaults are
    // conservative; tune per provider rate-limits.
    OUTBOX_MAX_PER_SECOND: z.coerce.number().int().positive().default(2),
    OUTBOX_MAX_PER_HOUR: z.coerce.number().int().positive().default(120),
    // How long a leased occurrence stays leased before another worker can
    // reclaim it (e.g. crashed worker). Stale leases are reclaimed on the
    // next tick.
    OCCURRENCE_LEASE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
    OUTBOX_LEASE_TTL_SECONDS: z.coerce.number().int().positive().default(60),
    OUTBOX_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),
    // Drain worker tick parameters: how many drain passes per tick and how
    // long to sleep between ticks. Defaults give ~1 pass/200ms.
    OUTBOX_DRAIN_LOOP_PASSES: z.coerce.number().int().positive().default(5),
    OUTBOX_DRAIN_LOOP_SLEEP_MS: z.coerce.number().int().nonnegative().default(200),
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
    // P10b (Codex review #102 — issue 2): fail-closed on missing HMAC secret.
    // P11: runtime trace is always-on (flag removed), so in production the
    // master secret MUST be set (KMS-backed) unconditionally. Test/dev can
    // override via _setTestMasterSecretForTests().
    if (
      cfg.NODE_ENV === 'production' &&
      !cfg.RUNTIME_TRACE_HMAC_MASTER_SECRET
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RUNTIME_TRACE_HMAC_MASTER_SECRET'],
        message:
          'RUNTIME_TRACE_HMAC_MASTER_SECRET is required in production — audit HMACs would be forgeable without it',
      });
    }
    // PR #406 — fail-closed on the REMOVED context-packet flag. The
    // FEATURE_CONTEXT_PACKET_V1 hot-path was deleted (the agent loop always
    // uses buildPrompt), but a stale deployment could still carry the flag (or
    // its kill switch) in its env. Setting it now is a no-op that would
    // SILENTLY mislead operators into thinking the path is live, so boot fails
    // loudly instead. Read process.env directly: these are no longer schema
    // fields, so cfg does not carry them.
    if (
      process.env.FEATURE_CONTEXT_PACKET_V1 === 'true' ||
      process.env.FEATURE_CONTEXT_PACKET_V1_KILL_SWITCH === 'true'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FEATURE_CONTEXT_PACKET_V1'],
        message:
          'FEATURE_CONTEXT_PACKET_V1 (and its kill switch) was REMOVED in PR #406 — ' +
          'the context-packet path no longer exists. Unset FEATURE_CONTEXT_PACKET_V1 / ' +
          'FEATURE_CONTEXT_PACKET_V1_KILL_SWITCH in this environment.',
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
