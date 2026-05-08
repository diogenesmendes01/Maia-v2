import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '@/config/env.js';
import { audit } from '@/governance/audit.js';
import { sendAlert } from '@/lib/alerts.js';
import { logger } from '@/lib/logger.js';
import { isS3Configured, uploadBackup, pruneCloud } from './backup-s3.js';

function tsName(): string {
  return `maia-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.dump`;
}

/**
 * Nightly backup runner — same pg_dump as scripts/backup.ts but invoked from
 * the worker registry so it runs without operator action. On success: audit
 * 'backup_completed'. On failure: audit 'backup_failed' + alert.
 *
 * S3 upload is skipped when BACKUP_S3_BUCKET is unset; an "all-clear" warning
 * is logged once per run instead of failing.
 */
export async function runNightlyBackup(): Promise<void> {
  mkdirSync(config.BACKUP_DIR, { recursive: true });
  const file = join(config.BACKUP_DIR, tsName());

  try {
    await runPgDump(file);
  } catch (err) {
    const message = (err as Error).message;
    logger.error({ err: message }, 'backup.failed');
    await audit({ acao: 'backup_failed', metadata: { error: message } });
    await sendAlert({
      subject: 'Nightly backup FAILED',
      body: `pg_dump failed: ${message}\nCheck disk space and Postgres connectivity.`,
    }).catch(() => null);
    return;
  }

  pruneLocal();

  let s3_url: string | null = null;
  if (!isS3Configured()) {
    logger.warn('backup.no_s3_bucket — local-only backup');
  } else {
    try {
      s3_url = await uploadBackup(file);
      logger.info({ s3_url }, 'backup.s3_upload_ok');
    } catch (err) {
      const message = (err as Error).message;
      logger.error({ err: message, file }, 'backup.s3_upload_failed');
      // Local backup is intact — emit a non-fatal audit. The operator
      // gets an alert separately. The main `backup_completed` audit below
      // still fires (the file is on disk; cloud is best-effort).
      await audit({
        acao: 'backup_s3_upload_failed',
        metadata: { file, error: message },
      });
      await sendAlert({
        subject: 'Nightly backup S3 upload FAILED (local OK)',
        body: `S3 upload failed for ${file}: ${message}\nLocal copy is intact under ${config.BACKUP_DIR}.`,
      }).catch(() => null);
    }
  }

  const size = (() => {
    try {
      return statSync(file).size;
    } catch {
      return 0;
    }
  })();
  await audit({
    acao: 'backup_completed',
    metadata: { file, size_bytes: size, ...(s3_url ? { s3_url } : {}) },
  });
  logger.info({ file, size_bytes: size, s3_url }, 'backup.completed');
}

/**
 * Weekly cron — prunes cloud backups older than BACKUP_RETENTION_CLOUD_DAYS.
 * Local rotation already runs nightly inside `runNightlyBackup` via
 * `pruneLocal`. Splitting cloud rotation into its own job keeps the nightly
 * run fast and lets ops schedule it independently if needed.
 */
export async function runCloudBackupRotation(): Promise<void> {
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
}

function runPgDump(target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('pg_dump', ['--no-owner', '-Fc', config.DATABASE_URL, '-f', target], {
      stdio: 'pipe',
    });
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pg_dump exit=${code} ${stderr.trim()}`));
    });
  });
}

function pruneLocal(): void {
  const cutoff = Date.now() - config.BACKUP_RETENTION_LOCAL_DAYS * 86_400_000;
  const files = readdirSync(config.BACKUP_DIR)
    .filter((f) => f.startsWith('maia-') && f.endsWith('.dump'))
    .map((f) => ({ name: f, path: join(config.BACKUP_DIR, f) }));
  for (const f of files) {
    try {
      if (statSync(f.path).mtimeMs < cutoff) {
        rmSync(f.path);
        logger.info({ file: f.name }, 'backup.pruned');
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message, file: f.name }, 'backup.prune_failed');
    }
  }
}
