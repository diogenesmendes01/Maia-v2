import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '@/config/env.js';
import { audit } from '@/governance/audit.js';
import { sendAlert } from '@/lib/alerts.js';
import { logger } from '@/lib/logger.js';

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
  if (!config.BACKUP_S3_BUCKET) {
    logger.warn('backup.no_s3_bucket — local-only backup');
  } else {
    // Upload deferred to a follow-up PR; spec 17 §11.2 acceptable as Phase 1.
    logger.info({ bucket: config.BACKUP_S3_BUCKET }, 'backup.s3_upload_pending');
  }
  const size = (() => {
    try {
      return statSync(file).size;
    } catch {
      return 0;
    }
  })();
  await audit({ acao: 'backup_completed', metadata: { file, size_bytes: size } });
  logger.info({ file, size_bytes: size }, 'backup.completed');
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
