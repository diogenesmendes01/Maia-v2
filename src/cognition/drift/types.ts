/**
 * P4 Task 8 — Drift detection types.
 *
 * Tipos compartilhados pelos 7 detectores de drift de identidade operacional
 * (spec §4.3). Cada detector implementa `DriftDetector` e devolve `null` (sem
 * drift) ou um `DriftEvidence` com payload tipado e summary <200 chars.
 *
 * Os detectores são **standalone**: NÃO são wrapped em `runCognitiveModule`
 * aqui — o orchestrator (cluster 3) injeta timeout/fallback/audit. Isso
 * permite testá-los em isolamento sem depender do runner cognitivo.
 */
import type { DriftType } from '@/types/enums.js';
import type { AgentOperationalProfileVersion } from '@/db/schema.js';

export type DriftRecentMessage = {
  id: string;
  from: 'agent' | 'user';
  text: string;
  created_at: Date;
};

export type DriftDetectionInput = {
  profile_active: AgentOperationalProfileVersion;
  recent_messages: DriftRecentMessage[];
  capabilities?: unknown;     // for escopo (cluster 3)
  self_model_skills?: unknown; // for confianca (cluster 2)
  recent_procedures?: unknown; // for procedimento (cluster 3)
};

export type DriftEvidence = {
  drift_type: DriftType;
  detected_by: string;       // module name
  payload: Record<string, unknown>;
  evidence_summary: string;  // human-readable, <200 chars
};

export interface DriftDetector {
  type: DriftType;
  detect(input: DriftDetectionInput): Promise<DriftEvidence | null>;
}
