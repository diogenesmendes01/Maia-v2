/**
 * Weekly cloud backup rotation. Lists every dump under `maia/` in the
 * configured bucket and deletes anything older than
 * `BACKUP_RETENTION_CLOUD_DAYS`. Skip silently when S3 isn't configured.
 *
 * Cron: `0 4 * * 0` (Sunday 04:00 America/Sao_Paulo, well outside the
 * nightly backup at 03:00 to avoid racing the just-uploaded dump).
 */
import { config } from '@/config/env.js';
import { audit } from '@/governance/audit.js';
import { logger } from '@/lib/logger.js';
import { listBackups, deleteBackup } from '@/lib/s3-backup.js';

export async function runBackupRotate(): Promise<void> {
  if (!config.BACKUP_S3_BUCKET || !config.BACKUP_S3_ACCESS_KEY) {
    logger.debug('backup-rotate.skipped_no_s3_config');
    return;
  }

  const cutoff = Date.now() - config.BACKUP_RETENTION_CLOUD_DAYS * 86_400_000;
  let entries;
  try {
    entries = await listBackups('maia/');
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'backup-rotate.list_failed');
    return;
  }

  const stale = entries.filter((e) => e.lastModified.getTime() < cutoff);
  if (stale.length === 0) {
    logger.info({ scanned: entries.length }, 'backup-rotate.nothing_to_delete');
    return;
  }

  const deleted: string[] = [];
  const failed: Array<{ key: string; error: string }> = [];
  for (const entry of stale) {
    try {
      await deleteBackup(entry.key);
      deleted.push(entry.key);
    } catch (err) {
      failed.push({ key: entry.key, error: (err as Error).message });
      logger.warn(
        { key: entry.key, err: (err as Error).message },
        'backup-rotate.delete_failed',
      );
    }
  }

  await audit({
    acao: 'backup_cloud_rotated',
    metadata: {
      scanned: entries.length,
      deleted_count: deleted.length,
      failed_count: failed.length,
      cutoff_days: config.BACKUP_RETENTION_CLOUD_DAYS,
      ...(deleted.length > 0 ? { deleted_keys: deleted } : {}),
      ...(failed.length > 0 ? { failures: failed } : {}),
    },
  });
  logger.info(
    { deleted: deleted.length, failed: failed.length, scanned: entries.length },
    'backup-rotate.completed',
  );
}
