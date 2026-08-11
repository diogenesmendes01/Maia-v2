/**
 * Per-service configuration loaders (issue #515).
 *
 * The contract is pure; THIS is where an environment snapshot is turned into a
 * typed configuration object. Each service gets only its declared subset, so a
 * module cannot accidentally read (or a container cannot accidentally receive)
 * another service's secrets.
 *
 * Importing this module is still side-effect free — `process.env` is read at
 * CALL time via a default argument, never at import time, and nothing here
 * touches the filesystem or the network.
 *
 * Public entry points for the migration runner (#516) and `maia doctor` (#517):
 *   - `loadServiceConfig(service, opts)`  — generic
 *   - `loadMigrationConfig(opts)`         — `src/config/migration-config.ts`
 *   - `loadAdminConfig(opts)`             — `src/config/admin-config.ts`
 *   - `loadBackupConfig(opts)`            — `src/config/backup-config.ts`
 */
import type { z } from 'zod';
import { objectSchemaForService, type ServiceShape } from '@/config/contract.js';
import type { ConfigProblem, MaiaProfile, MaiaService } from '@/config/metadata.js';
import { resolveProfile } from '@/config/profiles.js';
import { scrubSecrets } from '@/config/redact.js';
import { validateConfig } from '@/config/validate.js';

/** Typed configuration for one service, inferred from the contract. */
export type ServiceConfig<S extends MaiaService> = z.infer<
  z.ZodObject<ServiceShape<S>>
>;

export interface LoadOptions {
  /** Environment snapshot. Defaults to `process.env` at CALL time. */
  readonly env?: Record<string, string | undefined>;
  /** Force a profile instead of resolving it from `MAIA_ENV`/`NODE_ENV`. */
  readonly profile?: MaiaProfile;
  /**
   * Run the full contract validator (cross-field rules, tombstones, unknown
   * Maia keys, per-profile requirements) in addition to the schema parse.
   * Default `true` — fail closed.
   */
  readonly validate?: boolean;
  /**
   * Accept the synthetic CI fixture values. Only for the tests and CI steps
   * that prove the contract is satisfiable — never for a real deployment.
   */
  readonly allowSyntheticFixtures?: boolean;
}

/**
 * Thrown when configuration is invalid. Carries EVERY problem found, so the
 * operator fixes the whole `.env` in one pass. Secrets are scrubbed from the
 * message before it is constructed.
 */
export class ConfigValidationError extends Error {
  readonly problems: readonly ConfigProblem[];
  readonly profile: MaiaProfile;
  readonly service: MaiaService;

  constructor(service: MaiaService, profile: MaiaProfile, problems: readonly ConfigProblem[]) {
    const body = problems
      .map((p) => `  - ${p.variable ?? '<config>'} [${p.rule}]: ${p.message}\n      → ${p.remediation}`)
      .join('\n');
    super(`Invalid configuration for service "${service}" (profile ${profile}):\n${body}`);
    this.name = 'ConfigValidationError';
    this.problems = problems;
    this.profile = profile;
    this.service = service;
  }
}

/**
 * Load and validate the configuration subset a service is allowed to read.
 * Throws `ConfigValidationError` listing every problem; never returns a
 * partially-valid object and never falls back to a silent default.
 */
export function loadServiceConfig<S extends MaiaService>(
  service: S,
  options: LoadOptions = {},
): ServiceConfig<S> {
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const profile = options.profile ?? resolveProfile(env).profile;

  const problems: ConfigProblem[] = [];

  if (options.validate !== false) {
    const result = validateConfig({
      env,
      profile,
      service,
      allowSyntheticFixtures: options.allowSyntheticFixtures,
    });
    problems.push(...result.errors);
  }

  const parsed = objectSchemaForService(service).safeParse(env);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const variable = issue.path.join('.') || null;
      const rule = `schema/${issue.code}`;
      if (problems.some((p) => p.variable === variable && p.rule === rule)) continue;
      problems.push({
        severity: 'error',
        variable,
        rule,
        message: scrubSecrets(issue.message, env),
        remediation: variable
          ? `Corrija ${variable} conforme src/config/contract.ts.`
          : 'Corrija a configuração conforme src/config/contract.ts.',
      });
    }
  }

  if (problems.length > 0) {
    throw new ConfigValidationError(service, profile, problems);
  }

  // Safe: `problems` is empty ⇒ the parse succeeded.
  return (parsed as { success: true; data: ServiceConfig<S> }).data;
}

/**
 * Boot summary safe to log: profile, contract version, warning count and the
 * non-reversible hash of the NON-SECRET configuration. Never a secret value.
 */
export function bootSummary(
  service: MaiaService,
  options: LoadOptions = {},
): {
  service: MaiaService;
  profile: MaiaProfile;
  contract_version: string;
  config_hash: string;
  warnings: number;
} {
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const result = validateConfig({
    env,
    profile: options.profile,
    service,
    allowSyntheticFixtures: options.allowSyntheticFixtures,
  });
  return {
    service,
    profile: result.profile,
    contract_version: result.contractVersion,
    config_hash: result.configHash,
    warnings: result.warnings.length,
  };
}
