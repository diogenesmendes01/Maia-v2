/**
 * Admin UI configuration subset (issue #515).
 *
 * Replaces the duplicate Zod schema that used to live in
 * `src/admin-ui/lib/env.ts`: the Admin UI now derives its variables from the
 * same contract as the runtime, so the two can no longer disagree about what a
 * variable means or defaults to.
 *
 * Side-effect free at import time.
 */
import { loadServiceConfig, type LoadOptions, type ServiceConfig } from '@/config/load.js';
import { manifestForService } from '@/config/services.js';
import type { MaiaProfile } from '@/config/metadata.js';

export type AdminConfig = ServiceConfig<'admin-ui'>;

/** Load + validate the Admin UI's configuration. Throws `ConfigValidationError`. */
export function loadAdminConfig(options: LoadOptions = {}): AdminConfig {
  return loadServiceConfig('admin-ui', options);
}

/** Variables the Admin UI is allowed to read, for a given profile. */
export function adminManifest(profile: MaiaProfile) {
  return manifestForService('admin-ui', profile);
}
