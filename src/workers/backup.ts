import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { config } from '@/config/env.js';
import { audit } from '@/governance/audit.js';
import { sendAlert } from '@/lib/alerts.js';
import { logger } from '@/lib/logger.js';
import { uploadBackup } from '@/lib/s3-backup.js';

function tsName(): string {
  return `maia-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.dump`;
}

/**
 * Backup runner shared by the nightly worker and the manual `npm run backup`
 * script: pg_dump → prune local → upload S3 (if configured) → audit
 * 'backup_completed'. On pg_dump failure: audit 'backup_failed' + alert + throw
 * so manual callers exit non-zero.
 *
 * S3 upload is skipped when BACKUP_S3_BUCKET is unset; an "all-clear" warning
 * is logged once per run instead of failing.
 */
export async function runBackup(): Promise<void> {
  mkdirSync(config.BACKUP_DIR, { recursive: true });
  const file = join(config.BACKUP_DIR, tsName());

  try {
    await runPgDump(file);
  } catch (err) {
    const message = (err as Error).message;
    logger.error({ err: message }, 'backup.failed');
    await audit({ acao: 'backup_failed', metadata: { error: message } });
    await sendAlert({
      subject: 'Backup FAILED',
      body: `pg_dump failed: ${message}\nCheck disk space and Postgres connectivity.`,
    }).catch(() => null);
    throw err;
  }

  pruneLocal();

  let s3_url: string | undefined;
  if (!config.BACKUP_S3_BUCKET) {
    logger.warn('backup.no_s3_bucket — local-only backup');
  } else if (!config.BACKUP_S3_ACCESS_KEY) {
    // Defensive: env validation already enforces this, but a missing key here
    // means a misconfigured override at runtime — log and skip rather than
    // crash the whole nightly job.
    logger.warn(
      { bucket: config.BACKUP_S3_BUCKET },
      'backup.s3_skipped_missing_credentials',
    );
  } else {
    try {
      const key = `maia/${basename(file)}`;
      s3_url = await uploadBackup(file, key);
      logger.info({ s3_url }, 'backup.s3_upload_ok');
    } catch (err) {
      const message = (err as Error).message;
      logger.error({ err: message }, 'backup.s3_upload_failed');
      await audit({
        acao: 'backup_s3_upload_failed',
        metadata: { file, error: message },
      });
      // Do not return: local backup succeeded; cloud failure is degraded but
      // not fatal. backup_completed will still be emitted (without s3_url).
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
