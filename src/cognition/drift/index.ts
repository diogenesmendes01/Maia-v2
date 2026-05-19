/**
 * P4 Task 8 — Drift detection orchestrator.
 *
 * Fans out os 7 detectores em paralelo via `runCognitiveModule` para garantir
 * timeout (8s/detector), auditoria em `cognitive_module_log` e fallback `null`
 * em erro. O resultado é a lista de `DriftEvidence` (sem nulls) que alimenta
 * o decision engine do Task 9.
 *
 * `triggered_by: 'async_event'` porque drift detection roda em worker
 * (não no caminho síncrono do turno) — consistente com convenção do runner.
 *
 * Cada detector continua testável em isolamento (sem runner) — o orchestrator
 * apenas adiciona governança operacional.
 */
import { runCognitiveModule } from '../runner.js';
import { tomDetector } from './tom.js';
import { valoresDetector } from './valores.js';
import { confiancaDetector } from './confianca.js';
import { viesDetector } from './vies.js';
import { escopoDetector } from './escopo.js';
import { linguagemDetector } from './linguagem.js';
import { procedimentoDetector } from './procedimento.js';
import { papelDriftDetector } from './papel.js';
import { soulDriftDetector } from './soul.js';
import type { DriftDetector, DriftDetectionInput, DriftEvidence } from './types.js';
import { featureFlags } from '@/config/feature-flags.js';
import { FeatureFlagName } from '@/types/enums.js';

// P4 — base detectors, always active.
export const BASE_DETECTORS: DriftDetector[] = [
  tomDetector,
  valoresDetector,
  confiancaDetector,
  viesDetector,
  escopoDetector,
  linguagemDetector,
  procedimentoDetector,
];

/**
 * Builds the active detector list.
 *
 * - P8b: soulDriftDetector appended only when FEATURE_SOUL_LAYER_V1 is on
 *   (runtime kill switch — no soul-layer DB/LLM work when off).
 * - P8d: papelDriftDetector appended only when OPERATIONAL_PROFILE_V2 is on
 *   (kill switch — no Anthropic call, freeze/rollback or alert row when off).
 *
 * NOTE: evaluated at call time (not module load time) so runtime override()
 * and killSwitch() calls in tests take effect without re-importing the module.
 *
 * `DETECTORS` is kept for backwards-compatibility with existing tests that
 * inspect the list (base-only).
 */
export function buildDetectors(): DriftDetector[] {
  const detectors = [...BASE_DETECTORS];
  if (featureFlags.isEnabled(FeatureFlagName.FEATURE_SOUL_LAYER_V1)) {
    // P8b: 8º detector. Severidade NUNCA promove rollback de profile
    // (decision-engine mapeia soul_drift → queued_human no máximo).
    detectors.push(soulDriftDetector);
  }
  if (featureFlags.isEnabled(FeatureFlagName.OPERATIONAL_PROFILE_V2)) {
    detectors.push(papelDriftDetector);
  }
  return detectors;
}

/** @deprecated Use buildDetectors() to get the flag-aware list. */
export const DETECTORS: DriftDetector[] = BASE_DETECTORS;

export async function runAllDriftDetectors(
  input: DriftDetectionInput,
): Promise<DriftEvidence[]> {
  const activeDetectors = buildDetectors();
  const results = await Promise.all(
    activeDetectors.map((d) =>
      runCognitiveModule<DriftEvidence | null>(
        {
          name: `drift_detector_${d.type}`,
          timeoutMs: 8000,
          triggered_by: 'async_event',
          fallback: null,
        },
        () => d.detect(input),
      ),
    ),
  );
  return results
    .map((r) => r.output)
    .filter((o): o is DriftEvidence => o !== null);
}

export type {
  DriftEvidence,
  DriftDetectionInput,
  DriftDetector,
  DriftRecentMessage,
} from './types.js';
