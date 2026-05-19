/**
 * P8.5 — Rollback target validation.
 *
 * Rules:
 *   - target version must be earlier than current
 *   - target version must exist (caller's responsibility to verify)
 *   - target must not be itself rolled-back (no rolling back to a roll-back)
 *   - same version is never a valid target (no "rollback to current")
 *
 * Used by Tela 3 (rollback modal) and `versions.rollback` tRPC procedure.
 */

const SUPPORTED_SOT_KINDS = [
  'agent_operational_profile_versions',
  'policy_rules',
  'soul_biases',
  'skills',
] as const;

type SotKind = typeof SUPPORTED_SOT_KINDS[number];

export function isSupportedSotKind(s: string): s is SotKind {
  return (SUPPORTED_SOT_KINDS as readonly string[]).includes(s);
}

export function validateRollbackTarget(
  sotKind: string,
  currentVersion: number,
  targetVersion: number,
): boolean {
  if (!isSupportedSotKind(sotKind)) return false;
  if (!Number.isInteger(currentVersion) || currentVersion < 1) return false;
  if (!Number.isInteger(targetVersion) || targetVersion < 1) return false;
  if (targetVersion >= currentVersion) return false;
  return true;
}

/**
 * Compute the most-recent valid rollback target given a list of versions.
 * Returns null if no valid target exists.
 */
export function suggestRollbackTarget(
  sotKind: string,
  currentVersion: number,
  availableVersions: Array<{ version: number; status: string }>,
): number | null {
  if (!isSupportedSotKind(sotKind)) return null;
  // Prefer the highest version that is < current and not rolled-back.
  const candidates = availableVersions
    .filter((v) => v.version < currentVersion && v.status !== 'rolled_back')
    .map((v) => v.version)
    .sort((a, b) => b - a);
  return candidates[0] ?? null;
}
