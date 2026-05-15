/**
 * P4 Task 8 — Drift detector: PROCEDIMENTO (determinístico, sem LLM).
 *
 * Conta procedures criados nos últimos 30 dias com baixa contagem de evidência
 * (`evidence_count <= LOW_EVIDENCE_THRESHOLD`). Mais de
 * `COUNT_THRESHOLD_PER_MONTH` indica que o agente está fabricando procedimentos
 * sem ancoragem em casos reais — drift procedimental.
 *
 * Severidade:
 *   - Algum procedure de baixa evidência já está com `status === 'active'`
 *     → `alto` (o procedimento já está em uso sem ancoragem).
 *   - Caso contrário → `medio` (em proposed/queued, ainda há tempo de revisar).
 *
 * Returns `null` quando `recent_procedures` está vazio/ausente, ou quando a
 * contagem de procedimentos com baixa evidência fica abaixo do threshold.
 */
import { DriftType } from '@/types/enums.js';
import type { DriftDetector, DriftDetectionInput, DriftEvidence } from './types.js';

type ProcedureRow = {
  id?: string;
  created_at?: Date | string;
  evidence_count?: number;
  status?: string;
};

const LOW_EVIDENCE_THRESHOLD = 2; // <= 2 evidências = drift candidate
const COUNT_THRESHOLD_PER_MONTH = 1; // mais que 1/mês com baixa evidência = drift

export const procedimentoDetector: DriftDetector = {
  type: DriftType.PROCEDIMENTO,
  async detect(input: DriftDetectionInput): Promise<DriftEvidence | null> {
    const procs = Array.isArray(input.recent_procedures)
      ? (input.recent_procedures as ProcedureRow[])
      : [];
    if (procs.length === 0) return null;

    const cutoff = Date.now() - 30 * 86_400_000;
    const lowEvidenceRecent = procs.filter((p) => {
      const ts =
        p.created_at instanceof Date
          ? p.created_at.getTime()
          : new Date(p.created_at ?? 0).getTime();
      const ev = typeof p.evidence_count === 'number' ? p.evidence_count : Infinity;
      return ts >= cutoff && ev <= LOW_EVIDENCE_THRESHOLD;
    });

    if (lowEvidenceRecent.length <= COUNT_THRESHOLD_PER_MONTH) return null;

    // Severity: any low-evidence procedure already active → alto; else medio.
    const anyActive = lowEvidenceRecent.some((p) => p.status === 'active');
    const severity_hint = anyActive ? 'alto' : 'medio';

    return {
      drift_type: DriftType.PROCEDIMENTO,
      detected_by: 'drift_detector_procedimento',
      payload: {
        low_evidence_procedures: lowEvidenceRecent,
        count: lowEvidenceRecent.length,
        any_active: anyActive,
        severity_hint,
      },
      evidence_summary: `${lowEvidenceRecent.length} procedures com <=2 evidências criadas em 30d`,
    };
  },
};
