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
import { soulDriftDetector } from './soul.js';
import type { DriftDetector, DriftDetectionInput, DriftEvidence } from './types.js';

const DETECTORS: DriftDetector[] = [
  tomDetector,
  valoresDetector,
  confiancaDetector,
  viesDetector,
  escopoDetector,
  linguagemDetector,
  procedimentoDetector,
  // P8b: 8º detector. Severidade NUNCA promove rollback de profile
  // (decision-engine mapeia soul_drift → queued_human no máximo).
  soulDriftDetector,
];

export async function runAllDriftDetectors(
  input: DriftDetectionInput,
): Promise<DriftEvidence[]> {
  const results = await Promise.all(
    DETECTORS.map((d) =>
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
