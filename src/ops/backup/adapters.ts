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
import { link, mkdir, open, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { config } from '@/config/env.js';
import { db } from '@/db/client.js';
import { logger } from '@/lib/logger.js';
import { sendAlert } from '@/lib/alerts.js';
import { TypedError } from '@/lib/utils.js';
import { audit } from '@/governance/audit.js';
import type { AuditAction } from '@/governance/audit-actions.js';
import {
  backupObjectKey,
  deleteBackupObject,
  downloadAndDigestBackupObject,
  headBackupObject,
  isS3Configured,
  uploadBackupObject,
} from '@/workers/backup-s3.js';
import { base64ToHex, verifyRemoteArtifact } from './remote-verify.js';
import { putWithDeadline } from './upload-deadline.js';
import { sha256File } from './checksum.js';
import { encryptFile, parseBackupKeyring } from './encryption.js';
import { opaqueLocator } from './redaction.js';
import type {
  BackupPorts,
  Provenance,
  TombstoneWatermarkProbe,
  UploadOutcome,
} from './service.js';
import { backupEvidenceStore } from '@/db/repositories/ops-repos.js';

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');

/**
 * Run a child process with a hard timeout, surfacing a STABLE code.
 *
 * The child's stderr is captured for the exit-code check but is NEVER put into
 * the thrown message: on a connection failure `pg_dump` echoes `DATABASE_URL`
 * with the password. Only the exit code travels.
 */
export function runBounded(
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
    // Injected by the deploy pipeline via the contract variable
    // MAIA_BUILD_COMMIT (issue #515 forbids a raw `process.env` read here, and
    // spawning `git` from a nightly worker is not worth the failure mode).
    commit: config.MAIA_BUILD_COMMIT ?? null,
    pg_client_version: null,
    pg_server_version: pgServerVersion,
    migration_head: migrationHead,
    schema_fingerprint: schemaFingerprint,
    config_fingerprint: createHash('sha256')
      .update(Object.keys(config).sort().join(','), 'utf8')
      .digest('hex'),
  };
}

/**
 * Probe the tombstone ledger and derive this artifact's replay watermark (§13).
 *
 * ROUND-1 REVIEW FINDING (P1). This used to return `max(effective_at)` or
 * `null`, and swallowed a DB error into that same `null`. Three problems in
 * one:
 *
 *  1. an UNREADABLE ledger looked exactly like an EMPTY one;
 *  2. either way the manifest carried no watermark, and `planReconciliation`
 *    blocks a restore with `watermark_missing` — so a run reported `completed`
 *    could be intrinsically un-restorable;
 *  3. an installation that has never deleted anything could NEVER produce a
 *    restorable backup, because `max()` over zero rows is null forever.
 *
 * Now the read is a REACHABILITY probe and the watermark is the run's own
 * reference instant. Any tombstone effective after it gets replayed on restore;
 * anything effective before it is already inside the dump. A deletion landing
 * mid-dump is replayed too, which is harmless because reconciliation is
 * idempotent — erring toward replay is the conservative direction.
 */
export async function readTombstoneWatermark(
  reference: Date,
): Promise<TombstoneWatermarkProbe> {
  try {
    const res = await db.execute<{ rows_present: boolean }>(
      sql`SELECT EXISTS (SELECT 1 FROM data_tombstones) AS rows_present`,
    );
    return {
      available: true,
      watermark: reference,
      rows_present: res.rows[0]?.rows_present === true,
    };
  } catch {
    // Unreadable: the caller FAILS the run rather than publishing an artifact
    // nobody could reconcile.
    return { available: false, watermark: null, rows_present: false };
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

    // Two guarantees, both load-bearing:
    //
    //  1. fsync BEFORE publishing — without it a power loss can leave a
    //     final-named file whose contents never reached the platter.
    //  2. NO-REPLACE publication (round-1 P1). `rename` silently replaces an
    //     existing destination on POSIX, so a name collision would overwrite a
    //     previous artifact whose manifest still points at it. `link` fails
    //     with EEXIST instead, turning a collision into a loud `promote_failed`
    //     rather than silent data loss. The temp name is then unlinked; both
    //     names referenced the same inode, so the published file survives.
    promote: async (tempPath, finalPath) => {
      try {
        const fh = await open(tempPath, 'r');
        try {
          await fh.sync();
        } finally {
          await fh.close();
        }
        await link(tempPath, finalPath);
      } catch (err) {
        throw new TypedError('promote_failed', 'could not promote the temporary artifact', {
          cause: (err as NodeJS.ErrnoException).code ?? (err as Error).name,
        });
      }
      // Non-fatal: the artifact is already published under its final name. A
      // leftover `.partial` is swept by the nightly local prune.
      await rm(tempPath, { force: true }).catch(() => undefined);
    },

    remove: async (path) => {
      await rm(path, { force: true });
    },

    upload: async (path, timeoutMs) => {
      if (!isS3Configured()) {
        throw new TypedError('upload_failed', 'no off-site destination configured', {});
      }
      const { sha256 } = await sha256File(path);
      // The key is derived BEFORE the request so a cancelled upload can reap
      // its own leftover (round-1 P2).
      const key = backupObjectKey(path);
      const bucket = config.BACKUP_S3_BUCKET ?? '';
      await putWithDeadline(
        {
          put: async (signal) => {
            await uploadBackupObject(path, sha256, { signal });
          },
          objectExists: async () => (await headBackupObject(key)) !== null,
          deleteObject: () => deleteBackupObject(key),
          // The key is hashed even in a warning: an object key names the
          // artifact and, with the bucket, locates the crown jewels.
          log: (event, detail) =>
            logger.warn({ ...detail, key_hash: opaqueLocator(bucket, key) }, event),
          // An orphan we can only DECLARE needs a human: it is an object
          // off-site with no manifest and no run row, outside retention and
          // outside legal hold until someone reconciles the bucket.
          alert: async (detail) => {
            await sendAlert({
              subject: 'Backup upload cancelled without acknowledgement (possible orphan object)',
              body:
                `${String(detail.impact)}\n` +
                `Action: ${String(detail.action)}\n` +
                `Object locator (hashed): ${opaqueLocator(bucket, key)}`,
            }).catch(() => null);
          },
        },
        timeoutMs,
      );
      const head = await headBackupObject(key);
      return {
        locator: opaqueLocator(bucket, key),
        remote_bytes: head?.bytes ?? null,
        // The provider's own digest, hex — null when it offers none. This is
        // NOT the uploader's metadata stamp (round-1 P1); `verifyRemote`
        // re-reads it from the destination anyway and decides there.
        remote_sha256: head?.providerSha256Base64
          ? (base64ToHex(head.providerSha256Base64) ?? null)
          : null,
        // Carried so verifyRemote can re-HEAD without re-deriving the key.
        ...({ _key: key } as Record<string, string>),
      } as UploadOutcome;
    },

    // Verification asks the PROVIDER for a digest it computed over the stored
    // bytes, and falls back to downloading and re-hashing. The uploader's own
    // metadata stamp is never consulted — that was the round-1 P1 finding.
    verifyRemote: async (uploadOutcome, expected) => {
      const key = (uploadOutcome as unknown as { _key?: string })._key;
      if (!key) return { verified: false, method: 'none', reason: 'object_missing' };
      return verifyRemoteArtifact(
        {
          head: headBackupObject,
          downloadAndDigest: downloadAndDigestBackupObject,
          // A nightly artifact is gigabytes; re-downloading it on every run
          // would multiply egress. We only pay it when the provider offers no
          // checksum of its own — otherwise the copy is reported UNVERIFIED
          // rather than assumed good.
          allowFullDownload: true,
        },
        key,
        expected,
      );
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

// A `withTimeout` helper used to live here and bounded the upload by RACING a
// timer against the request. It was deleted in the round-1 P2 fix: racing
// rejects the outer promise while the request keeps running, which is how a
// "failed" run ended up with an untracked remote object. `putWithDeadline`
// (src/ops/backup/upload-deadline.ts) aborts, awaits settlement and reaps.

/** Exported for the restore drill: stream a local artifact for verification. */
export function openArtifact(path: string): ReturnType<typeof createReadStream> {
  return createReadStream(path);
}
