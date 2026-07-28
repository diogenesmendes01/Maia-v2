import { readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '@/config/env.js';
import { audit } from '@/governance/audit.js';
import { sendAlert } from '@/lib/alerts.js';
import { logger } from '@/lib/logger.js';
import { pool } from '@/db/client.js';
import { isS3Configured, pruneCloud } from './backup-s3.js';
import { runWithSystemContext } from '@/db/tenant-context.js';
import { resolveBackupProfile } from '@/ops/backup/profile.js';
import { createBackupPorts } from '@/ops/backup/adapters.js';
import { runVerifiedBackup, type BackupTrigger } from '@/ops/backup/service.js';
import { OPS_LOCK_KEYS, withOpsLock } from '@/ops/backup/single-flight.js';

/**
 * Nightly backup runner — issue #520.
 *
 * WHAT CHANGED FROM THE BASELINE. This worker used to spawn `pg_dump`, prune by
 * mtime, best-effort the S3 upload, and then audit `backup_completed` with the
 * file's SIZE as the only evidence — even when the upload had just failed
 * (old `src/workers/backup.ts:50-85`). "Backup concluído" meant "pg_dump
 * exited 0".
 *
 * It is now a thin adapter over ONE shared service:
 *   - `scripts/backup.ts` (the CLI) calls the SAME `runVerifiedBackup`, so the
 *     two can no longer drift;
 *   - a global advisory lock makes a cron/CLI collision impossible — the loser
 *     reports `already_running` and starts nothing;
 *   - the terminal state is COMPUTED from evidence (catalog readable, checksum
 *     verified, encrypted if required, remote copy verified), so a local-only
 *     or upload-failed run is `completed_degraded`/`failed`, never a green
 *     `backup_completed`.
 *
 * Still GENUINELY-GLOBAL maintenance (issue #323 phase 2): a `pg_dump` covers
 * the whole database and has no owning tenant, so the run executes under the
 * reserved `system` sentinel — never the legacy `default` literal.
 */
export async function runNightlyBackup(): Promise<void> {
  await runWithSystemContext(() => executeBackup('schedule'));
}

/**
 * Shared entry point for cron and CLI. Returns the outcome so the CLI can pick
 * a process exit code.
 */
export async function executeBackup(trigger: BackupTrigger): Promise<{
  status: 'ran' | 'already_running' | 'disabled';
  outcome?: 'completed' | 'completed_degraded' | 'failed';
  reason?: string;
}> {
  const profile = resolveBackupProfile(config);
  if (!profile.enabled) {
    logger.warn({ profile: profile.name }, 'backup.disabled');
    return { status: 'disabled' };
  }

  // Single-flight: cron, CLI and any retry contend for one global lock. The
  // loser does NOT wait and does NOT start a second dump.
  const result = await withOpsLock(
    OPS_LOCK_KEYS.backup_run,
    { pool, onWarn: (event, detail) => logger.warn(detail, event) },
    () => runVerifiedBackup(createBackupPorts(), profile, trigger),
  );

  if (result.status === 'already_running') {
    logger.info({ trigger }, 'backup.already_running');
    return { status: 'already_running' };
  }

  const run = result.result;
  // Local retention still runs nightly, but it is no longer the ONLY lifecycle
  // signal — see pruneLocal's note on why mtime alone is not enough.
  pruneLocal();

  if (run.outcome !== 'completed') {
    await sendAlert({
      subject:
        run.outcome === 'failed'
          ? 'Nightly backup FAILED'
          : 'Nightly backup DEGRADED (no verified off-site copy)',
      // Codes only — the alert channel is not a place for a path or a URL.
      body:
        `Backup ${run.backup_id} finished with outcome=${run.outcome} reason=${run.reason}.\n` +
        `Inspect backup_runs for this correlation id: ${run.correlation_id}.`,
    }).catch(() => null);
  }

  return { status: 'ran', outcome: run.outcome, reason: run.reason };
}

/**
 * Weekly cron — prunes cloud backups older than BACKUP_RETENTION_CLOUD_DAYS.
 * Local rotation runs nightly inside `executeBackup` via `pruneLocal`.
 */
export async function runCloudBackupRotation(): Promise<void> {
  // Genuinely-GLOBAL maintenance (issue #323 phase 2): `pruneCloud` only walks
  // and deletes objects in the S3 backup bucket (no DB read at all) and the
  // only DB writes are ownerless `backup_cloud_rotation_*` audit rows.
  await runWithSystemContext(async () => {
    if (!isS3Configured()) {
      logger.debug('backup.rotation_skipped_no_s3');
      return;
    }
    try {
      const { scanned, deleted } = await pruneCloud();
      logger.info({ scanned, deleted }, 'backup.cloud_rotation_done');
      await audit({
        acao: 'backup_cloud_rotation_completed',
        metadata: { scanned, deleted, retention_days: config.BACKUP_RETENTION_CLOUD_DAYS },
      });
    } catch (err) {
      const message = (err as Error).message;
      logger.error({ err: message }, 'backup.cloud_rotation_failed');
      await audit({
        acao: 'backup_cloud_rotation_failed',
        metadata: { error: message },
      });
    }
  });
}

/**
 * Local disk rotation.
 *
 * Two behaviours worth naming:
 *  - `.partial` files are swept aggressively (a leftover from a crashed run is
 *    never a restore candidate and must not accumulate);
 *  - final artifacts are still removed by age. Issue §10 is explicit that mtime
 *    must not be the ONLY source of truth for retention — the authoritative
 *    lifecycle lives in `backup_runs.delete_after` + the manifest. Wiring the
 *    manifest-driven reaper (with legal-hold evaluation before each delete) is
 *    the follow-up slice; until then this stays a pure DISK-SPACE guard on the
 *    local copy, and the off-site copy — the one that matters for recovery —
 *    is governed by `runCloudBackupRotation`.
 */
function pruneLocal(): void {
  const cutoff = Date.now() - config.BACKUP_RETENTION_LOCAL_DAYS * 86_400_000;
  let files: string[];
  try {
    files = readdirSync(config.BACKUP_DIR);
  } catch {
    return;
  }
  for (const name of files) {
    if (!name.startsWith('maia-')) continue;
    const isPartial = name.endsWith('.partial');
    if (!isPartial && !name.endsWith('.dump')) continue;
    const path = join(config.BACKUP_DIR, name);
    try {
      const mtime = statSync(path).mtimeMs;
      // A partial older than one dump budget is definitively orphaned.
      const partialCutoff = Date.now() - config.BACKUP_DUMP_TIMEOUT_MS * 2;
      if (isPartial ? mtime < partialCutoff : mtime < cutoff) {
        rmSync(path);
        logger.info({ file: name, partial: isPartial }, 'backup.pruned');
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message, file: name }, 'backup.prune_failed');
    }
  }
}
