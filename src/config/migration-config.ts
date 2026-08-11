/**
 * Migration-runner configuration subset (issue #515; consumed by #516).
 *
 * The migrator gets Postgres + core process knobs and NOTHING else — no LLM
 * keys, no WhatsApp session, no S3 credentials, no alert transports. That is
 * the whole point of a per-service manifest: a migration container that leaks
 * cannot leak what it was never given.
 *
 * Side-effect free at import time.
 */
import { loadServiceConfig, type LoadOptions, type ServiceConfig } from '@/config/load.js';
import { manifestForService } from '@/config/services.js';
import type { MaiaProfile } from '@/config/metadata.js';

export type MigrationConfig = ServiceConfig<'migrator'>;

/** Load + validate the migrator's configuration. Throws `ConfigValidationError`. */
export function loadMigrationConfig(options: LoadOptions = {}): MigrationConfig {
  return loadServiceConfig('migrator', options);
}

/** Variables the migrator is allowed to read, for a given profile. */
export function migrationManifest(profile: MaiaProfile) {
  return manifestForService('migrator', profile);
}
