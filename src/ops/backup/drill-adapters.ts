/**
 * Issue #536 §1 — real IO behind `RestoreDrillPorts`.
 *
 * Same split as `service.ts` / `adapters.ts`: `drill.ts` owns the LIFECYCLE and
 * is fully unit-tested with fakes; this module owns the SIDE EFFECTS (S3 GET,
 * decryption, `CREATE DATABASE`, `pg_restore`, the probe queries, `DROP
 * DATABASE`) and is exercised by the integration suite.
 *
 * Two things this module is careful about, both because a drill is the one job
 * that deliberately materialises a full plaintext copy of production data:
 *
 *  - the workspace is a subdirectory of `BACKUP_DIR`, not `/tmp`. Operators
 *    already treat `BACKUP_DIR` as sensitive and back it with the right
 *    permissions and disk; scattering decrypted dumps into a world-readable
 *    temp directory would undo the encryption the pipeline just performed. The
 *    directory name does not match `isSafeArtifactRef`, so neither retention
 *    nor the `.partial` sweeper ever considers its contents;
 *  - nothing here ever puts a child process's stderr into a message. `pg_restore`
 *    echoes the connection URL — with the password — on a connection failure,
 *    which is precisely the leak issue #520 closed on the `pg_dump` side.
 */
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { TypedError } from '@/lib/utils.js';
import { audit } from '@/governance/audit.js';
import type { AuditAction } from '@/governance/audit-actions.js';
import {
  restoreDrillStore,
  readTombstoneLedger,
  selectDrillCandidate,
} from '@/db/repositories/ops-repos.js';
import { deriveTombstoneSecret } from '@/ops/retention/tombstones.js';
import { downloadBackupObjectToFile } from '@/workers/backup-s3.js';
import { runBounded } from './adapters.js';
import { resolveArtifactObjectKey, resolveArtifactPath } from './artifact-path.js';
import { sha256File } from './checksum.js';
import { decryptFile, parseBackupKeyring } from './encryption.js';
import { backupManifestKeyring } from './manifest-keyring.js';
import { assertSafeDatabaseName, type RestoreDrillPorts } from './drill.js';
import { RESTORE_DRILL_PROBES, type ProbeContext, type ProbeRow } from './drill-probes.js';

/** Where staged (downloaded / decrypted) artifacts live during a drill. */
export function drillWorkspace(): string {
  return join(config.BACKUP_DIR, 'restore-drill');
}

/**
 * Connection URL for the maintenance database, used to CREATE/DROP the
 * ephemeral drill database. Never logged — it carries the password.
 */
function adminUrl(): string {
  const u = new URL(config.DATABASE_URL);
  u.pathname = '/postgres';
  return u.toString();
}

function databaseUrl(databaseName: string): string {
  const u = new URL(config.DATABASE_URL);
  u.pathname = `/${assertSafeDatabaseName(databaseName)}`;
  return u.toString();
}

/**
 * Run one statement on the maintenance database.
 *
 * `CREATE DATABASE` / `DROP DATABASE` cannot run inside a transaction and
 * cannot be parameterised, which is why `assertSafeDatabaseName` gates every
 * name before it reaches this function.
 */
async function adminExec(statement: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Ask the CATALOG whether the ephemeral database is still there (issue #541).
 *
 * `DROP DATABASE IF EXISTS` returning without error is not proof: it also
 * "succeeds" against a name the server never had, which is exactly what a
 * misrouted admin connection produces. `pg_database` is the only authority.
 *
 * Parameterised — this is a query, not DDL, so the name never becomes SQL. Any
 * failure PROPAGATES: `drill.ts` treats an unprovable absence as residue, and
 * swallowing the error here would put the false certification straight back.
 */
async function databaseExists(name: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    const res = await client.query<{ ok: number }>(
      'SELECT 1 AS ok FROM pg_database WHERE datname = $1',
      [assertSafeDatabaseName(name)],
    );
    return res.rowCount !== null && res.rowCount > 0;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Make a staging slot writable: create the workspace and clear any leftover.
 *
 * Both writers below open with `wx`, so a stale file from a drill that was
 * SIGKILLed mid-run would otherwise block every future drill on the same
 * artifact with a misleading `decryption_failed` / `artifact_fetch_failed`.
 * Removing first is safe because the path is a name this module generated,
 * inside its own workspace, and the drill lock rules out a concurrent writer —
 * the `wx` flag stays as the guard against the case where it does not.
 */
async function prepareStagingSlot(path: string): Promise<void> {
  await mkdir(drillWorkspace(), { recursive: true });
  await rm(path, { force: true });
}

/** Staged filename guard — the drill's own names only, never a caller's path. */
function stagedName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '');
  if (safe.length === 0 || safe.includes('..')) {
    throw new TypedError('artifact_fetch_failed', 'refusing to stage under this name', {});
  }
  return safe;
}

export function createRestoreDrillPorts(): RestoreDrillPorts {
  return {
    now: () => new Date(),
    newId: () => crypto.randomUUID(),

    selectCandidate: (source) => selectDrillCandidate(source),

    // Same material the manifest was SIGNED with (src/ops/backup/adapters.ts).
    // It lives outside the artifact, so an attacker holding the dump cannot
    // forge a manifest for it — and it is resolved BY THE VERSION the envelope
    // names, so a key rotation does not strand the recovery points signed
    // before it (see `manifest-keyring.ts`).
    manifestKeyring: backupManifestKeyring,

    stagingPath: (name) => join(drillWorkspace(), stagedName(name)),

    fetchArtifact: async (candidate, dest) => {
      if (candidate.source === 'offsite') {
        await prepareStagingSlot(dest);
        const key = resolveArtifactObjectKey(config.BACKUP_S3_PREFIX, candidate.artifact_ref);
        const digest = await downloadBackupObjectToFile(key, dest);
        return { path: dest, sha256: digest.sha256, bytes: digest.bytes, ephemeral: true };
      }
      // A LOCAL candidate is read IN PLACE. Copying a multi-gigabyte artifact
      // to prove it is readable would double the disk requirement, and — more
      // importantly — `ephemeral: false` is what stops the drill's teardown
      // from deleting the recovery point it exists to validate.
      const path = resolveArtifactPath(config.BACKUP_DIR, candidate.artifact_ref);
      try {
        const digest = await sha256File(path);
        return { path, sha256: digest.sha256, bytes: digest.bytes, ephemeral: false };
      } catch (err) {
        throw new TypedError('artifact_fetch_failed', 'local artifact could not be read', {
          cause: (err as NodeJS.ErrnoException).code ?? (err as Error).name,
        });
      }
    },

    decrypt: async (src, dest) => {
      await prepareStagingSlot(dest);
      const keyring = parseBackupKeyring(
        config.BACKUP_ENCRYPTION_KEYRING,
        config.BACKUP_ENCRYPTION_ACTIVE_KEY_ID,
      );
      await decryptFile(src, dest, keyring);
      // Verify-after-write: digest what actually landed, not what we intended
      // to write. The caller binds this against the manifest's plaintext digest.
      return sha256File(dest);
    },

    createIsolatedDatabase: async (name) => {
      await adminExec(`CREATE DATABASE "${assertSafeDatabaseName(name)}"`);
    },

    restore: async (databaseName, artifactPath) => {
      const res = await runBounded(
        'pg_restore',
        ['--no-owner', '--no-privileges', '-d', databaseUrl(databaseName), artifactPath],
        config.BACKUP_RESTORE_TIMEOUT_MS,
        'restore_failed',
      );
      if (!res.ok) {
        // Exit code only. `pg_restore` stderr contains the connection URL.
        throw new TypedError('restore_failed', `pg_restore exited with code ${res.exitCode}`, {
          exit_code: res.exitCode,
        });
      }
    },

    runProbes: async (databaseName, _ctx: ProbeContext) => {
      const rows: Record<string, ProbeRow | null> = {};
      const client = new pg.Client({ connectionString: databaseUrl(databaseName) });
      try {
        await client.connect();
      } catch {
        // Every probe is `null`, which `gradeProbeSuite` treats as a failed
        // query — so an unreachable drill database fails the drill instead of
        // producing an empty, passing probe set.
        for (const spec of RESTORE_DRILL_PROBES) rows[spec.id] = null;
        return rows;
      }
      try {
        for (const spec of RESTORE_DRILL_PROBES) {
          try {
            const res = await client.query<ProbeRow>(spec.sql);
            rows[spec.id] = res.rows[0] ?? null;
          } catch {
            // A missing table is a legitimate probe RESULT, not an exception
            // the drill must special-case: `null` grades as `query_failed`.
            rows[spec.id] = null;
          }
        }
      } finally {
        await client.end().catch(() => undefined);
      }
      return rows;
    },

    dropDatabase: async (name) => {
      // FORCE (PostgreSQL 13+) terminates any connection still attached — a
      // probe client that failed to close must not leave a full copy of
      // production data behind on the host.
      await adminExec(`DROP DATABASE IF EXISTS "${assertSafeDatabaseName(name)}" WITH (FORCE)`);
    },

    removeFile: async (path) => {
      await rm(path, { force: true });
    },

    databaseExists,

    // ENOENT is the proof of absence. Every OTHER errno (EACCES on the
    // directory, EIO) is NOT: it means we cannot tell, so it propagates and
    // `drill.ts` records `unverified` residue rather than certifying the drill.
    fileExists: async (path) => {
      try {
        await stat(path);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw err;
      }
    },

    readLedger: readTombstoneLedger,
    tombstoneSecret: () => deriveTombstoneSecret(config.RUNTIME_TRACE_HMAC_MASTER_SECRET),

    store: restoreDrillStore,
    audit: (action, metadata) => audit({ acao: action as AuditAction, metadata }),
    log: (event, detail) => logger.info(detail, event),
  };
}
