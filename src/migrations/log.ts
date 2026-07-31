/**
 * Structured logging for the migration runner (issue #516 §"Observabilidade").
 *
 * WHY NOT `@/lib/logger.js`: that module imports `@/config/env.js`, which loads
 * and validates the WHOLE runtime configuration at import time — LLM keys,
 * WhatsApp session, S3 credentials. The migrator is deliberately given none of
 * those (issue #515's per-service manifest), so importing the app logger would
 * either crash the migrator or force the operator to hand a migration container
 * secrets it must never hold. This sink imports nothing.
 *
 * REDACTION BY CONSTRUCTION: every value that leaves here goes through
 * `redact()`, which strips Postgres DSNs. `DATABASE_URL` must never appear in
 * migration logs — the migrator is the one process whose whole configuration is
 * a connection string.
 */

/** `postgres://user:pass@host/db`, `postgresql://…` — with or without creds. */
const DSN_RE = /\b(postgres(?:ql)?|redis|rediss|amqp|mysql):\/\/[^\s"']*/gi;
/** A bare `user:password@host` pair that escaped a full URL. */
const USERINFO_RE = /\b[\w.+-]+:[^\s:@/"']{3,}@[\w.-]+/g;

/** Strip anything that could carry a credential. Applied to every string. */
export function redact(value: string): string {
  return value.replace(DSN_RE, '$1://[REDACTED]').replace(USERINFO_RE, '[REDACTED]@[REDACTED]');
}

function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[TRUNCATED]';
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Operator-facing one-liner for an unexpected error, redacted.
 *
 * Handles the shape that actually shows up when a migrator cannot reach the
 * database: Node's happy-eyeballs connect produces an `AggregateError` whose
 * own `message` is EMPTY, so a naive `err.message` prints nothing at all and
 * the operator is told "something failed" with no cause. The inner errors
 * carry the real `ECONNREFUSED`.
 */
export function describeError(e: unknown): string {
  const err = e as { name?: string; message?: string; code?: string; errors?: unknown[] };
  const inner = Array.isArray(err?.errors)
    ? (err.errors[0] as { message?: string; code?: string } | undefined)
    : undefined;
  const detail = err?.message || inner?.message || err?.code || inner?.code || String(e);
  const name = err?.name ?? 'Error';
  return redact(detail ? `${name}: ${detail}` : name);
}

export type MigrationLogEvent =
  | 'migration.lock_wait'
  | 'migration.lock_timeout'
  | 'migration.started'
  | 'migration.applied'
  | 'migration.failed'
  | 'migration.dirty'
  | 'migration.checksum_mismatch'
  | 'migration.blocked'
  | 'migration.backfill'
  | 'migration.stale_running_reset'
  | 'migration.repair'
  | 'migration.plan'
  | 'migration.done';

export interface MigrationLogger {
  info(event: MigrationLogEvent, fields?: Record<string, unknown>): void;
  warn(event: MigrationLogEvent, fields?: Record<string, unknown>): void;
  error(event: MigrationLogEvent, fields?: Record<string, unknown>): void;
}

function emit(
  stream: NodeJS.WriteStream,
  level: 'info' | 'warn' | 'error',
  event: MigrationLogEvent,
  fields: Record<string, unknown>,
): void {
  const line = {
    level,
    time: new Date().toISOString(),
    component: 'migration-runner',
    event,
    ...(redactDeep(fields) as Record<string, unknown>),
  };
  stream.write(`${JSON.stringify(line)}\n`);
}

/** JSON-lines logger: `info` on stdout, `warn`/`error` on stderr. */
export const migrationLogger: MigrationLogger = {
  info: (event, fields = {}) => emit(process.stdout, 'info', event, fields),
  warn: (event, fields = {}) => emit(process.stderr, 'warn', event, fields),
  error: (event, fields = {}) => emit(process.stderr, 'error', event, fields),
};

/** Discards everything — for tests and for library callers that log elsewhere. */
export const silentMigrationLogger: MigrationLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
