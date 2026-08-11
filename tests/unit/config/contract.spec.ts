/**
 * Issue #515 — shape of the canonical contract itself.
 *
 * The contract is data, so the invariants that keep it usable (every entry
 * documented, every secret marked, every variable owned by at least one
 * service, no name collisions with a tombstone) are asserted here rather than
 * relied on by convention.
 *
 * The `LEGACY_RUNTIME_KEYS` list is a deliberate regression fence: it is the
 * exact key set the pre-contract `src/config/env.ts` schema produced. 66 modules
 * import `config`, so silently dropping one of these keys from the contract
 * would be a type-level break at best and a silent default at worst.
 */
import { describe, it, expect } from 'vitest';
import {
  CONTRACT_ENTRIES,
  CONTRACT_VERSION,
  SECRET_NAMES,
  TOMBSTONES,
  entriesForService,
  findSpec,
  findTombstone,
  isUnknownMaiaKey,
  objectSchemaForService,
} from '@/config/contract.js';
import { GROUP_ORDER, MAIA_SERVICES, isOperatorPlaceholder } from '@/config/metadata.js';

/** Key set of the pre-#515 runtime schema (src/config/env.ts @ d93624b). */
const LEGACY_RUNTIME_KEYS = [
  'NODE_ENV', 'TZ', 'APP_PORT', 'LOG_LEVEL',
  'DATABASE_URL', 'POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB', 'POSTGRES_PORT',
  'REDIS_URL', 'REDIS_PORT',
  'LLM_PROVIDER', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL_MAIN',
  'OPENROUTER_MODEL_FAST', 'CLAUDE_MODEL_MAIN', 'CLAUDE_MODEL_FAST', 'OPENAI_API_KEY',
  'WHISPER_PROVIDER', 'WHISPER_MODEL',
  'EMBEDDING_PROVIDER', 'EMBEDDING_MODEL', 'EMBEDDING_DIMENSIONS', 'VOYAGE_API_KEY',
  'COHERE_API_KEY',
  'BAILEYS_AUTH_DIR', 'WHATSAPP_NUMBER_MAIA', 'MAIA_DISPLAY_NAME',
  'OWNER_TELEFONE_WHATSAPP', 'OWNER_NOME',
  'VALOR_LIMITE_SEM_CONFIRMACAO', 'VALOR_DUAL_APPROVAL', 'VALOR_LIMITE_DURO',
  'DUAL_APPROVAL_TIMEOUT_HOURS', 'AUDIT_MODE_TTL_HOURS', 'IDEMPOTENCY_BUCKET_MINUTES',
  'PENDING_QUESTION_TTL_MINUTES', 'PENDING_ACTION_TTL_HOURS', 'RATE_LIMIT_MSGS_PER_HOUR',
  'CLAUDE_MAX_RETRIES', 'CLAUDE_TIMEOUT_MS', 'WHATSAPP_RECONNECT_ALERT_MIN',
  'DECISION_ENGINE_BUDGET_MS',
  'ALERT_CHANNELS', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'ALERT_EMAIL_TO',
  'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID',
  'BACKUP_DIR', 'BACKUP_RETENTION_LOCAL_DAYS', 'BACKUP_RETENTION_CLOUD_DAYS',
  'BACKUP_S3_BUCKET', 'BACKUP_S3_ENDPOINT', 'BACKUP_S3_REGION', 'BACKUP_S3_ACCESS_KEY',
  'BACKUP_S3_SECRET_KEY', 'BACKUP_S3_PREFIX',
  'DAILY_LLM_USD_THRESHOLD', 'DLQ_ALERT_THRESHOLD',
  'FEATURE_MCP_TOOLS', 'FEATURE_PROACTIVE_MESSAGES', 'FEATURE_OFX_IMPORT', 'FEATURE_DASHBOARD',
  'FEATURE_PENDING_GATE', 'FEATURE_PRESENCE',
  'MAIA_MULTI_LINE', 'MAIA_CHANNEL_ROUTING_MODE', 'MAIA_STAGING_KEYRING',
  'MAIA_STAGING_ACTIVE_KEY_ID',
  'MAIA_SYNTHETIC_PROBE', 'MAIA_PROBE_LLM_JUDGE', 'MAIA_PROBE_CRON', 'MAIA_PROBE_SLO_MS',
  'MAIA_PROBE_SLO_WARN_MS', 'MAIA_PROBE_ALERT_AFTER_K', 'MAIA_PROBE_AUTOSILENCE_AFTER_N',
  'MAIA_PROBE_SILENCED_BACKOFF_MS', 'MAIA_PROBE_RUN_TTL_MS', 'MAIA_PROBE_LEASE_MS',
  'MAIA_PROBE_ALERT_MODE',
  'FEATURE_ONE_TAP', 'FEATURE_MESSAGE_UPDATE', 'FEATURE_PENDING_REMINDER',
  'FEATURE_VIEW_ONCE_SENSITIVE', 'FEATURE_PDF_REPORTS', 'FEATURE_OUTBOUND_VOICE',
  'FEATURE_OUTBOUND_DEDUP',
  'OUTBOUND_SWEEPER_STALE_PENDING_SEC', 'OUTBOUND_SWEEPER_RETENTION_DAYS',
  'OUTBOUND_SWEEPER_RETENTION_BATCH_SIZE', 'OUTBOUND_SWEEPER_RECOVERY_LIMIT_PER_TENANT',
  'OUTBOX_RELAYER_BATCH_PER_TENANT', 'OUTBOX_RELAYER_BASE_BACKOFF_SEC',
  'OUTBOX_RELAYER_MAX_BACKOFF_SEC', 'OUTBOX_RELAYER_RETENTION_DAYS',
  'OUTBOX_RELAYER_RETENTION_BATCH_SIZE',
  'POLICY_RESOLVER_CACHE_TTL_MS', 'POLICY_RESOLVER_CACHE_MAX_ENTRIES',
  'RUNTIME_TRACE_HMAC_KEY_VERSION', 'RUNTIME_TRACE_HMAC_MASTER_SECRET',
  'RUNTIME_TRACE_HMAC_PREV_MASTER_SECRETS', 'RUNTIME_TRACE_DEBUG_S3_BUCKET',
  'RUNTIME_TRACE_DEBUG_AES_KEY', 'RUNTIME_TRACE_BODY_ORPHAN_SEC',
  'RUNTIME_TRACE_MATVIEW_REFRESH_SEC',
  'SYNC_LATENCY_P95_BASELINE_MS', 'SYNC_LATENCY_P95_BUDGET_PERCENT',
  'FEATURE_MESSAGE_DEBOUNCE', 'FEATURE_PROCEDURE_RUNTIME',
  'PROCEDURE_SELECTOR_CONFIDENCE_THRESHOLD',
  'MESSAGE_DEBOUNCE_MS', 'MESSAGE_DEBOUNCE_MAX_MS',
  'OUTBOX_MAX_PER_SECOND', 'OUTBOX_MAX_PER_HOUR',
  'OCCURRENCE_LEASE_TTL_SECONDS', 'OUTBOX_LEASE_TTL_SECONDS', 'OUTBOX_WORKER_CONCURRENCY',
  'OUTBOX_DRAIN_LOOP_PASSES', 'OUTBOX_DRAIN_LOOP_SLEEP_MS',
  'SETUP_TOKEN_OVERRIDE',
] as const;

describe('config contract — shape (#515)', () => {
  it('has a semantic version', () => {
    expect(CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('every entry is fully documented', () => {
    for (const spec of CONTRACT_ENTRIES) {
      expect(spec.name, 'name').toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(spec.description.length, `${spec.name}: description`).toBeGreaterThan(10);
      expect(spec.services.length, `${spec.name}: services`).toBeGreaterThan(0);
      expect(typeof spec.secret, `${spec.name}: secret`).toBe('boolean');
      expect(typeof spec.restartRequired, `${spec.name}: restartRequired`).toBe('boolean');
      expect(
        GROUP_ORDER.some((g) => g.group === spec.group),
        `${spec.name}: group "${spec.group}" is missing from GROUP_ORDER`,
      ).toBe(true);
    }
  });

  it('variable names are unique and the map key matches the `name` field', () => {
    const names = CONTRACT_ENTRIES.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(findSpec(name)?.name).toBe(name);
    }
  });

  it('every entry has a synthetic fixture value', () => {
    const missing = CONTRACT_ENTRIES.filter((s) => s.fixture === undefined).map((s) => s.name);
    expect(missing, 'fixtures are what prove the contract is satisfiable').toEqual([]);
  });

  it("every SECRET's fixture is unmistakably synthetic", () => {
    // `secret/synthetic-fixture` matches a secret's fixture EXACTLY, so a
    // fixture that could plausibly be somebody's real value becomes a false
    // positive that aborts their boot (PR #522 review round 2). Every secret
    // fixture must therefore carry a synthetic marker: the literal `fixture`,
    // or the all-zero base64 block used for key-shaped fields.
    const offenders = CONTRACT_ENTRIES.filter((s) => s.secret).filter((s) => {
      const values = [s.fixture, ...Object.values(s.fixtureByProfile ?? {})].filter(
        (v): v is string => typeof v === 'string',
      );
      return values.some((v) => !/fixture/i.test(v) && !/A{20,}=/.test(v));
    });
    expect(
      offenders.map((s) => s.name),
      'um fixture de segredo que pareça um valor real vira falso positivo no boot',
    ).toEqual([]);
  });

  it('no secret carries a usable credential as its example', () => {
    // A URL with no userinfo (`redis://localhost:6379`) carries no credential,
    // so it may be shown verbatim. Anything else that is declared secret must
    // be a recognisable placeholder that the strict profiles reject.
    const carriesNoCredential = (example: string) =>
      /^[a-z][a-z0-9+.-]*:\/\//i.test(example) && !example.includes('@');

    for (const spec of CONTRACT_ENTRIES.filter((s) => s.secret)) {
      expect(spec.example, `${spec.name} must document an example`).toBeDefined();
      const example = spec.example!;
      expect(
        isOperatorPlaceholder(example) || carriesNoCredential(example),
        `${spec.name}: the .env.example value must be a placeholder (or a credential-free URL), got "${example}"`,
      ).toBe(true);
    }
  });

  it('SECRET_NAMES matches the entries flagged secret', () => {
    expect([...SECRET_NAMES].sort()).toEqual(
      CONTRACT_ENTRIES.filter((s) => s.secret).map((s) => s.name).sort(),
    );
  });

  it('no tombstone shares a name with a live variable', () => {
    for (const t of TOMBSTONES) {
      expect(findSpec(t.name), `${t.name} is both live and tombstoned`).toBeUndefined();
      expect(findTombstone(t.name)?.name).toBe(t.name);
      expect(t.reason.length).toBeGreaterThan(10);
    }
  });

  it('the removed flags named by the issue are tombstoned, not merely absent', () => {
    for (const name of ['FEATURE_MULTI_CHANNEL', 'FEATURE_COGNITIVE_GRAPH', 'APROVAR_MENSAGENS_PROATIVAS']) {
      expect(findTombstone(name), `${name} must have a tombstone`).toBeDefined();
      expect(isUnknownMaiaKey(name), `${name} must not read as merely unknown`).toBe(false);
    }
  });

  it('every service owns at least one variable, and every variable at least one service', () => {
    for (const service of MAIA_SERVICES) {
      expect(entriesForService(service).length, service).toBeGreaterThan(0);
    }
    const owned = new Set(MAIA_SERVICES.flatMap((s) => entriesForService(s).map((e) => e.name)));
    expect([...owned].sort()).toEqual(CONTRACT_ENTRIES.map((e) => e.name).sort());
  });

  it('the migrator subset excludes LLM keys, WhatsApp session and S3 credentials', () => {
    const names = entriesForService('migrator').map((s) => s.name);
    for (const forbidden of [
      'ANTHROPIC_API_KEY',
      'OPENROUTER_API_KEY',
      'OPENAI_API_KEY',
      'BAILEYS_AUTH_DIR',
      'WHATSAPP_NUMBER_MAIA',
      'BACKUP_S3_SECRET_KEY',
      'NEXTAUTH_SECRET',
    ]) {
      expect(names, `migrator must not receive ${forbidden}`).not.toContain(forbidden);
    }
    expect(names).toContain('DATABASE_URL');
  });

  it('the admin-ui subset excludes the WhatsApp session and the backup credentials', () => {
    const names = entriesForService('admin-ui').map((s) => s.name);
    for (const forbidden of ['BAILEYS_AUTH_DIR', 'BACKUP_S3_SECRET_KEY', 'SETUP_TOKEN_OVERRIDE']) {
      expect(names, `admin-ui must not receive ${forbidden}`).not.toContain(forbidden);
    }
    expect(names).toContain('NEXTAUTH_SECRET');
  });

  it('preserves every key of the pre-contract runtime schema', () => {
    const runtimeKeys = new Set(entriesForService('runtime').map((s) => s.name));
    const dropped = LEGACY_RUNTIME_KEYS.filter((k) => !runtimeKeys.has(k));
    expect(
      dropped,
      'dropping a runtime key silently changes 66 import sites — add a tombstone instead',
    ).toEqual([]);
  });

  it('the runtime object schema accepts the runtime keys and drops admin-only ones', () => {
    const shape = objectSchemaForService('runtime').shape as Record<string, unknown>;
    expect(Object.keys(shape)).toEqual(entriesForService('runtime').map((s) => s.name));
    expect(shape.NEXTAUTH_SECRET).toBeUndefined();
    expect(shape.DATABASE_URL).toBeDefined();
  });
});
