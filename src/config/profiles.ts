/**
 * Deployment profiles (issue #515).
 *
 * `MAIA_ENV` is the explicit profile selector. `NODE_ENV` keeps controlling
 * Node platform optimisations only — it cannot even express `staging`. When
 * `MAIA_ENV` is absent the profile is DERIVED from `NODE_ENV`; when both are
 * present and contradict each other, that is an error (a process running with
 * production optimisations under development validation rules is exactly the
 * "I thought this was staging" incident).
 *
 * PURE module: no `process.env` read, no side effects.
 */
import {
  type ConfigProblem,
  type MaiaProfile,
  MAIA_PROFILES,
} from '@/config/metadata.js';

export { MAIA_PROFILES };
export type { MaiaProfile };

/** `NODE_ENV` values compatible with each profile. */
const COMPATIBLE_NODE_ENV: Record<MaiaProfile, readonly string[]> = {
  development: ['development', 'test'],
  // Staging runs production-shaped code, so NODE_ENV=production is the
  // expected pairing; `development` is tolerated for a local staging rehearsal.
  staging: ['production', 'development', 'test'],
  production: ['production'],
};

/** Profile derived from `NODE_ENV` when `MAIA_ENV` is absent. */
export function profileFromNodeEnv(nodeEnv: string | undefined): MaiaProfile {
  return nodeEnv === 'production' ? 'production' : 'development';
}

export function isMaiaProfile(value: unknown): value is MaiaProfile {
  return typeof value === 'string' && (MAIA_PROFILES as readonly string[]).includes(value);
}

export interface ResolvedProfile {
  readonly profile: MaiaProfile;
  /** True when the profile came from `MAIA_ENV` rather than from `NODE_ENV`. */
  readonly explicit: boolean;
  /** Contradiction findings between `MAIA_ENV` and `NODE_ENV`. */
  readonly problems: readonly ConfigProblem[];
}

/**
 * Resolve the effective profile from a raw environment snapshot.
 *
 * Never throws: an invalid `MAIA_ENV` falls back to the `NODE_ENV`-derived
 * profile and reports a problem, so `maia config check` can list EVERY finding
 * in a single run instead of dying on the first one.
 */
export function resolveProfile(
  env: Record<string, string | undefined>,
): ResolvedProfile {
  const rawMaiaEnv = env.MAIA_ENV?.trim();
  const nodeEnv = env.NODE_ENV?.trim();
  const problems: ConfigProblem[] = [];

  if (rawMaiaEnv && !isMaiaProfile(rawMaiaEnv)) {
    problems.push({
      severity: 'error',
      variable: 'MAIA_ENV',
      rule: 'profile/invalid',
      message: `MAIA_ENV inválido: "${rawMaiaEnv}".`,
      remediation: `Use um de: ${MAIA_PROFILES.join(', ')}.`,
    });
    return { profile: profileFromNodeEnv(nodeEnv), explicit: false, problems };
  }

  const profile: MaiaProfile = isMaiaProfile(rawMaiaEnv)
    ? rawMaiaEnv
    : profileFromNodeEnv(nodeEnv);
  const explicit = isMaiaProfile(rawMaiaEnv);

  if (explicit && nodeEnv && !COMPATIBLE_NODE_ENV[profile].includes(nodeEnv)) {
    problems.push({
      severity: 'error',
      variable: 'MAIA_ENV',
      rule: 'profile/node-env-contradiction',
      message: `MAIA_ENV=${profile} contradiz NODE_ENV=${nodeEnv}.`,
      remediation:
        `Com MAIA_ENV=${profile}, NODE_ENV precisa ser um de: ` +
        `${COMPATIBLE_NODE_ENV[profile].join(', ')}. NODE_ENV controla apenas as ` +
        'otimizações da plataforma Node; o profile da Maia é MAIA_ENV.',
    });
  }

  return { profile, explicit, problems };
}

/** True when the profile must fail closed on unknown/removed configuration. */
export function isStrictProfile(profile: MaiaProfile): boolean {
  return profile === 'staging' || profile === 'production';
}
