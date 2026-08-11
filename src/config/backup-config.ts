/**
 * Backup / restore configuration subset (issue #515).
 *
 * Postgres credentials + retention + the S3 destination + the alert transport
 * used to report a failed backup. No LLM keys, no WhatsApp session.
 *
 * Side-effect free at import time.
 */
import { loadServiceConfig, type LoadOptions, type ServiceConfig } from '@/config/load.js';
import { manifestForService } from '@/config/services.js';
import type { MaiaProfile } from '@/config/metadata.js';

export type BackupConfig = ServiceConfig<'backup'>;

/** Load + validate the backup tooling's configuration. Throws `ConfigValidationError`. */
export function loadBackupConfig(options: LoadOptions = {}): BackupConfig {
  return loadServiceConfig('backup', options);
}

/** Variables the backup tooling is allowed to read, for a given profile. */
export function backupManifest(profile: MaiaProfile) {
  return manifestForService('backup', profile);
}
