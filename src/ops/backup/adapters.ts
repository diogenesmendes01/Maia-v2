/**
 * Issue #520 — real IO adapters behind the `BackupPorts` interface.
 *
 * `src/ops/backup/service.ts` owns the LIFECYCLE and is fully unit-tested with
 * fakes; this module owns the SIDE EFFECTS (`pg_dump`, filesystem, S3, DB) and
 * is exercised by the integration suite. Keeping them apart is what let the
 * whole state machine be tested without Postgres, S3 or a pg_dump binary.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, readFileSync } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { config } from '@/config/env.js';
import { db } from '@/db/client.js';
import { logger } from '@/lib/logger.js';
import { TypedError } from '@/lib/utils.js';
import { audit } from '@/governance/audit.js';
import type { AuditAction } from '@/governance/audit-actions.js';
import {
  headBackupObject,
  isS3Configured,
  uploadBackupObject,
} from '@/workers/backup-s3.js';
import { sha256File } from './checksum.js';
import { encryptFile, parseBackupKeyring } from './encryption.js';
import { opaqueLocator } from './redaction.js';
import type { BackupPorts, Provenance, UploadOutcome } from './service.js';
import { backupEvidenceStore } from '@/db/repositories/ops-repos.js';

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');

/**
 * Run a child process with a hard timeout, surfacing a STABLE code.
 *
 * The child's stderr is captured for the exit-code check but is NEVER put into
 * the thrown message: on a connection failure `pg_dump` echoes `DATABASE_URL`
 * with the password. Only the exit code travels.
 */
function runBounded(
  bin: string,
  args: string[],
  timeoutMs: number,
  code: string,
): Promise<{ ok: boolean; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      reject(new TypedError(code, `${bin} exceeded its ${timeoutMs}ms budget`, { bin }));
    }, timeoutMs);
    // Drain stderr so the pipe never fills and blocks the child — but discard
    // the content (it can contain the connection string).
    proc.stderr?.resume();
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new TypedError(code, `${bin} could not be started (${err.name})`, { bin }));
    });
    proc.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: exitCode === 0, exitCode });
    });
  });
}

/**
 * Provenance for the manifest. Every field here is deliberately non-sensitive:
 *  - `source_id` is a hash of the hostname, not the hostname;
 *  - `config_fingerprint` hashes the sorted config KEY NAMES, never values —
 *    it detects "the shape of the configuration changed" without embedding a
 *    single secret in the manifest;
 *  - `migration_head` / `schema_fingerprint` come from the migration filenames
 *    on disk, so a restore drill can detect a schema-head divergence.
 */
export async function collectProvenance(): Promise<Provenance> {
  let appVersion = 'unknown';
  try {
    appVersion =
      (JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version?: string })
        .version ?? 'unknown';
  } catch {
    /* keep 'unknown' */
  }

  let migrationHead: string | null = null;
  let schemaFingerprint: string | null = null;
  try {
    const forward = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql') && !f.endsWith('_down.sql'))
      .sort();
    migrationHead = forward.at(-1) ?? null;
    schemaFingerprint = createHash('sha256').update(forward.join('\n'), 'utf8').digest('hex');
  } catch {
    /* migrations dir unavailable (packaged build) — null is honest */
  }

  let pgServerVersion: string | null = null;
  try {
    const res = await db.execute<{ server_version: string }>(sql`SHOW server_version`);
    pgServerVersion = res.rows[0]?.server_version ?? null;
  } catch {
    // Version unknown is honest; it is provenance, not a gate.
  }

  return {
    environment: config.NODE_ENV,
    source_id: `host-${createHash('sha256').update(hostname(), 'utf8').digest('hex').slice(0, 12)}`,
    app_version: appVersion,
    // Injected by the deploy pipeline; spawning `git` from a nightly worker is
    // not worth the failure mode.
    commit: process.env.GIT_COMMIT ?? null,
    pg_client_version: null,
    pg_server_version: pgServerVersion,
    migration_head: migrationHead,
    schema_fingerprint: schemaFingerprint,
    config_fingerprint: createHash('sha256')
      .update(Object.keys(config).sort().join(','), 'utf8')
      .digest('hex'),
  };
}

/** Newest tombstone instant — the §13 replay watermark stamped into the manifest. */
export async function readTombstoneWatermark(): Promise<Date | null> {
  try {
    const res = await db.execute<{ watermark: string | null }>(
      sql`SELECT max(effective_at)::text AS watermark FROM data_tombstones`,
    );
    const raw = res.rows[0]?.watermark;
    return raw ? new Date(raw) : null;
  } catch {
    // The ledger being unreadable is recorded as "no watermark", which makes
    // any later restore of this artifact fail closed at reconciliation
    // (planReconciliation → blocked_reason 'watermark_missing'). That is the
    // correct conservative outcome.
    return null;
  }
}

/** Build the production port set. */
export function createBackupPorts(): BackupPorts {
  return {
    now: () => new Date(),
    newId: () => crypto.randomUUID(),
    resolvePath: (name) => join(config.BACKUP_DIR, name),
    ensureBackupDir: async () => {
      await mkdir(config.BACKUP_DIR, { recursive: true });
    },

    dump: async (target, timeoutMs) => {
      const res = await runBounded(
        'pg_dump',
        ['--no-owner', '-Fc', config.DATABASE_URL, '-f', target],
        timeoutMs,
        'dump_failed',
      );
      if (!res.ok) {
        throw new TypedError('dump_failed', `pg_dump exited with code ${res.exitCode}`, {
          exit_code: res.exitCode,
        });
      }
    },

    // Reading the catalog is the cheapest proof that the artifact is a
    // structurally valid dump — a truncated file has a size too.
    readCatalog: async (path, timeoutMs) => {
      try {
        const res = await runBounded('pg_restore', ['--list', path], timeoutMs, 'catalog_unreadable');
        return res.ok;
      } catch {
        return false;
      }
    },

    digest: (path) => sha256File(path),

    encrypt: async (src, dest) => {
      const keyring = parseBackupKeyring(
        config.BACKUP_ENCRYPTION_KEYRING,
        config.BACKUP_ENCRYPTION_ACTIVE_KEY_ID,
      );
      try {
        const res = await encryptFile(src, dest, keyring);
        return { key_id: res.key_id };
      } catch (err) {
        throw new TypedError('encryption_failed', 'artifact encryption failed', {
          cause: (err as TypedError).code ?? (err as Error).name,
        });
      }
    },

    // fsync BEFORE rename: without it a power loss can leave a final-named
    // file whose contents never reached the platter.
    promote: async (tempPath, finalPath) => {
      try {
        const fh = await open(tempPath, 'r');
        try {
          await fh.sync();
        } finally {
          await fh.close();
        }
        await rename(tempPath, finalPath);
      } catch (err) {
        throw new TypedError('promote_failed', 'could not promote the temporary artifact', {
          cause: (err as Error).name,
        });
      }
    },

    remove: async (path) => {
      await rm(path, { force: true });
    },

    upload: async (path, timeoutMs) => {
      if (!isS3Configured()) {
        throw new TypedError('upload_failed', 'no off-site destination configured', {});
      }
      const { sha256 } = await sha256File(path);
      const uploaded = await withTimeout(
        uploadBackupObject(path, sha256),
        timeoutMs,
        'upload_failed',
      );
      const head = await headBackupObject(uploaded.key);
      return {
        locator: opaqueLocator(uploaded.bucket, uploaded.key),
        remote_bytes: head?.bytes ?? null,
        remote_sha256: head?.sha256 ?? null,
        // Carried so verifyRemote can re-HEAD without re-deriving the key.
        ...({ _key: uploaded.key } as Record<string, string>),
      } as UploadOutcome;
    },

    // Verification compares what the DESTINATION reports against what we
    // hashed locally. A provider that reports neither size nor checksum yields
    // `false` — the run degrades/fails instead of claiming a verified copy.
    verifyRemote: async (uploadOutcome, expected) => {
      const key = (uploadOutcome as unknown as { _key?: string })._key;
      const head = key ? await headBackupObject(key) : null;
      const remoteBytes = head?.bytes ?? uploadOutcome.remote_bytes;
      const remoteSha = head?.sha256 ?? uploadOutcome.remote_sha256;
      if (remoteSha === null || remoteBytes === null) return false;
      return remoteSha.toLowerCase() === expected.sha256.toLowerCase() && remoteBytes === expected.bytes;
    },

    provenance: collectProvenance,
    tombstoneWatermark: readTombstoneWatermark,

    // Reuses the existing KMS-backed HMAC material (env.ts requires it in
    // production). The signing key lives OUTSIDE the artifact — issue §5
    // forbids storing a key alongside what it protects.
    manifestSecret: () => ({
      secret: config.RUNTIME_TRACE_HMAC_MASTER_SECRET ?? '',
      key_version: config.RUNTIME_TRACE_HMAC_KEY_VERSION,
    }),

    store: backupEvidenceStore,
    audit: (action, metadata) => audit({ acao: action as AuditAction, metadata }),
    log: (event, detail) => logger.info(detail, event),
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, code: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new TypedError(code, `operation exceeded its ${ms}ms budget`, {})),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e as Error);
      },
    );
  });
}

/** Exported for the restore drill: stream a local artifact for verification. */
export function openArtifact(path: string): ReturnType<typeof createReadStream> {
  return createReadStream(path);
}
