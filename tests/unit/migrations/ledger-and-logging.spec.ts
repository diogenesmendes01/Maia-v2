/**
 * Issue #516 §2 + "Observabilidade" — the parts of the ledger and the runner's
 * log sink that are provable WITHOUT Postgres.
 *
 * Everything that needs a real server (the advisory lock, dirty state, the
 * v1→v2 upgrade) lives in `tests/integration/migration-runner-real-db.spec.ts`.
 * What is testable here is exactly the part that decides whether a secret
 * leaks: the error classifier (which must never keep a driver MESSAGE) and the
 * log redactor (which must never emit a connection string).
 */
import { describe, it, expect } from 'vitest';
import { errorClassOf, mapLedgerRow } from '@/migrations/ledger.js';
import { describeError, redact } from '@/migrations/log.js';
import { MIGRATION_LOCK_CLASSID, MIGRATION_LOCK_OBJID } from '@/migrations/lock.js';
import { buildSchemaManifest } from '@/migrations/manifest.js';
import { defaultMigrationsDir, discoverMigrations } from '@/migrations/discover.js';
import { MIGRATION_RUNNER_VERSION, SCHEMA_MANIFEST_VERSION } from '@/migrations/types.js';

describe('errorClassOf', () => {
  it('prefers the SQLSTATE, which is greppable and carries no message', () => {
    const err = Object.assign(new Error('relation "x" already exists'), { code: '42P07' });
    expect(errorClassOf(err)).toBe('42P07');
  });

  it('falls back to the error NAME, never the message', () => {
    expect(errorClassOf(new TypeError('postgres://u:p@h/db unreachable'))).toBe('TypeError');
  });

  it('never returns the message, even for an exotic value', () => {
    expect(errorClassOf('postgres://user:hunter2@db:5432/maia')).toBe('UnknownError');
    expect(errorClassOf(null)).toBe('UnknownError');
  });

  it('rejects an over-long `code` that is really a message in disguise', () => {
    const err = Object.assign(new Error('x'), {
      code: 'connection to postgres://u:p@h/db refused',
    });
    expect(errorClassOf(err)).toBe('Error');
  });
});

describe('mapLedgerRow', () => {
  it('reads a v1 row (no status column) as applied', () => {
    const row = mapLedgerRow({ id: '001_a.sql', applied_at: new Date('2026-01-01') });
    expect(row.status).toBe('applied');
    expect(row.checksum_sha256).toBeNull();
    expect(row.checksum_source).toBeNull();
  });

  it('keeps every non-applied status verbatim — dirty must never be softened', () => {
    for (const status of ['running', 'dirty', 'failed'] as const) {
      expect(mapLedgerRow({ id: 'x.sql', status }).status).toBe(status);
    }
  });

  it('treats an UNKNOWN status as applied rather than throwing', () => {
    // A future runner may add a status this build has never heard of. Refusing
    // to parse would take readiness down on a value that is, at worst, more
    // specific than what we know.
    expect(mapLedgerRow({ id: 'x.sql', status: 'quantum' }).status).toBe('applied');
  });

  it('coerces driver-shaped timestamps and numeric strings', () => {
    const row = mapLedgerRow({
      id: 'x.sql',
      status: 'applied',
      applied_at: '2026-07-31T10:00:00.000Z',
      execution_ms: '1234',
    });
    expect(row.applied_at?.toISOString()).toBe('2026-07-31T10:00:00.000Z');
    expect(row.execution_ms).toBe(1234);
  });
});

describe('log redaction', () => {
  it('strips a Postgres DSN with credentials', () => {
    expect(redact('connect ECONNREFUSED postgres://maia:hunter2@db.internal:5432/maia')).not.toMatch(
      /hunter2/,
    );
  });

  it('strips postgresql://, redis:// and amqp:// alike', () => {
    for (const dsn of [
      'postgresql://u:p@h/db',
      'redis://:secret@cache:6379',
      'amqp://u:p@broker',
    ]) {
      expect(redact(`boom ${dsn}`)).not.toMatch(/secret|:p@/);
    }
  });

  it('strips a bare user:password@host pair', () => {
    expect(redact('auth failed for maia:hunter2@db.internal')).not.toMatch(/hunter2/);
  });

  it('leaves ordinary operator text alone', () => {
    const msg = 'migration 110_schema_migrations_v2.sql applied in 42ms';
    expect(redact(msg)).toBe(msg);
  });
});

describe('describeError', () => {
  it('names the cause of an AggregateError whose own message is EMPTY', () => {
    // This is the real shape of "the database is not reachable": Node's
    // happy-eyeballs connect throws an AggregateError with message '' and the
    // ECONNREFUSED on the inner errors. Reading `.message` alone prints
    // nothing and tells the operator exactly zero.
    const inner = Object.assign(new Error('connect ECONNREFUSED ::1:5432'), { code: 'ECONNREFUSED' });
    const agg = Object.assign(new AggregateError([inner], ''), { name: 'AggregateError' });
    const text = describeError(agg);
    expect(text).toMatch(/AggregateError/);
    expect(text).toMatch(/ECONNREFUSED/);
  });

  it('redacts a DSN carried in the message', () => {
    const e = new Error('could not connect to postgres://maia:hunter2@db:5432/maia');
    expect(describeError(e)).not.toMatch(/hunter2/);
  });

  it('survives a thrown non-Error', () => {
    expect(describeError('boom')).toMatch(/boom/);
  });
});

describe('advisory lock namespace', () => {
  it('is the documented ("MAIA", 1) two-int32 key and fits in int4', () => {
    expect(MIGRATION_LOCK_CLASSID).toBe(0x4d414941);
    expect(MIGRATION_LOCK_OBJID).toBe(1);
    expect(MIGRATION_LOCK_CLASSID).toBeLessThan(2 ** 31);
    expect(MIGRATION_LOCK_CLASSID).toBeGreaterThan(0);
  });
});

describe('the release schema manifest', () => {
  const migrations = discoverMigrations(defaultMigrationsDir());

  it('describes the REAL artifact this build ships', () => {
    const manifest = buildSchemaManifest(migrations);
    expect(manifest.schema_manifest_version).toBe(SCHEMA_MANIFEST_VERSION);
    expect(manifest.runner_version).toBe(MIGRATION_RUNNER_VERSION);
    expect(manifest.migration_count).toBe(migrations.length);
    expect(manifest.expected_head).toBe(migrations[migrations.length - 1]!.id);
  });

  it('defaults the range to "needs my own head, tolerates anything newer"', () => {
    const manifest = buildSchemaManifest(migrations);
    expect(manifest.min_supported_migration).toBe(manifest.expected_head);
    expect(manifest.max_supported_migration).toBeNull();
  });

  it('honours an explicit expand/contract range', () => {
    const manifest = buildSchemaManifest(migrations, {
      minSupported: '001_initial.sql',
      maxSupported: '999_z.sql',
    });
    expect(manifest.min_supported_migration).toBe('001_initial.sql');
    expect(manifest.max_supported_migration).toBe('999_z.sql');
  });

  it('carries a full checksum per migration (the doctor compares these)', () => {
    const manifest = buildSchemaManifest(migrations);
    expect(manifest.migrations.every((m) => /^[0-9a-f]{64}$/.test(m.checksum_sha256))).toBe(true);
  });
});
