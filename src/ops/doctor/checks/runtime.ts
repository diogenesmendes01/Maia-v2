/**
 * `maia doctor` — runtime checks (issue #517 §3, "Runtime").
 *
 * Offline by construction: nothing here opens a socket or reads a file, so
 * these are the checks that still answer something useful on a box where
 * Postgres and Redis are both down.
 */
import { pass, type DoctorCheck, type DoctorResult } from '../types.js';

/**
 * Runtime floor. Mirrors `engines.node` in `package.json` and
 * `MINIMUM_PARTS` in `scripts/check-node.mjs`.
 *
 * Duplicated on purpose, exactly like `scripts/check-node.mjs` duplicates it:
 * the doctor must answer inside the production image, where reading
 * `package.json` means depending on the image layout. Divergence is caught by
 * `tests/unit/ops/doctor-checks.spec.ts`, not by hope.
 */
export const MINIMUM_NODE_VERSION = '22.13.0';

/** `[major, minor, patch]`, or `null` when the string is not a release version. */
export function parseSemver(raw: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Negative when `a < b`, 0 when equal, positive when `a > b`. */
export function compareSemver(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export const nodeVersionCheck: DoctorCheck = {
  id: 'runtime.node_version',
  category: 'runtime',
  criticality: 'blocker',
  describes: `o processo roda em Node >= ${MINIMUM_NODE_VERSION}`,
  deadlineMs: 1_000,
  requiresNetwork: false,
  run(): Promise<DoctorResult> {
    const current = process.versions.node;
    const parsed = parseSemver(current);
    const floor = parseSemver(MINIMUM_NODE_VERSION)!;
    if (!parsed) {
      return Promise.resolve({
        status: 'fail',
        summary: `versão do Node irreconhecível: "${current}"`,
        evidence: { node: current, minimum: MINIMUM_NODE_VERSION },
        remediation: [`Instale Node ${MINIMUM_NODE_VERSION} ou superior (\`nvm install\` lê o .nvmrc).`],
      });
    }
    if (compareSemver(parsed, floor) < 0) {
      return Promise.resolve({
        status: 'fail',
        summary: `Node ${current} está abaixo do piso ${MINIMUM_NODE_VERSION}`,
        evidence: { node: current, minimum: MINIMUM_NODE_VERSION },
        remediation: [
          `\`nvm install && nvm use\` (o .nvmrc fixa a linha 22) e reconstrua a imagem.`,
        ],
      });
    }
    return Promise.resolve(pass(`Node ${current}`, { node: current, minimum: MINIMUM_NODE_VERSION }));
  },
};

export const RUNTIME_CHECKS: readonly DoctorCheck[] = [nodeVersionCheck];
