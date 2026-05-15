/**
 * P4 Task 8 — Drift detector: CONFIANCA (determinístico).
 *
 * Cross-check: o agente faz afirmações confiantes ("tenho certeza", "com
 * certeza", "100%", "garanto", etc.) sobre uma skill cuja confidence real
 * no self-model é baixa (< 0.5). Se houver gap, sinaliza drift.
 *
 * 100% determinístico — sem LLM, sem rede. Apenas regex + lookup contra
 * `input.self_model_skills` (output do P2 self-model). Severity é derivada
 * do maior gap encontrado:
 *   gap >= 0.7 → critico
 *   gap >= 0.5 → alto
 *   senão     → medio
 *
 * Returns `null` quando não há self_model_skills, sem mensagens confiantes
 * do agente, ou quando todas as claims confiantes estão alinhadas com a
 * capability real (confidence >= 0.5).
 */
import { DriftType } from '@/types/enums.js';
import type { DriftDetector, DriftDetectionInput, DriftEvidence } from './types.js';

type SkillRow = { skill_name?: string; confidence?: number; evidence_count?: number };

const CONFIDENT_REGEX = /\b(tenho certeza|com certeza|sem d[úu]vida|garanto|100%|absolutamente|definitivamente)\b/i;

export const confiancaDetector: DriftDetector = {
  type: DriftType.CONFIANCA,
  async detect(input: DriftDetectionInput): Promise<DriftEvidence | null> {
    const skills = Array.isArray(input.self_model_skills) ? (input.self_model_skills as SkillRow[]) : [];
    if (skills.length === 0) return null;

    const agentMessages = input.recent_messages.filter((m) => m.from === 'agent');
    const confidentClaims: Array<{
      message_id: string;
      text: string;
      matched_skill: string;
      actual_confidence: number;
      gap: number;
    }> = [];

    for (const msg of agentMessages) {
      if (!CONFIDENT_REGEX.test(msg.text)) continue;
      // For each known skill, check if its name appears in the message
      for (const s of skills) {
        if (typeof s.skill_name !== 'string' || s.skill_name.length === 0) continue;
        if (typeof s.confidence !== 'number') continue;
        const re = new RegExp(`\\b${escapeRegex(s.skill_name)}\\b`, 'i');
        if (!re.test(msg.text)) continue;
        if (s.confidence >= 0.5) continue; // claim aligned with capability
        const gap = 1 - s.confidence;
        confidentClaims.push({
          message_id: msg.id,
          text: msg.text.slice(0, 200),
          matched_skill: s.skill_name,
          actual_confidence: s.confidence,
          gap,
        });
      }
    }

    if (confidentClaims.length === 0) return null;

    // Severity hint: largest gap drives it
    const maxGap = Math.max(...confidentClaims.map((c) => c.gap));
    const severity_hint = maxGap >= 0.7 ? 'critico' : maxGap >= 0.5 ? 'alto' : 'medio';

    return {
      drift_type: DriftType.CONFIANCA,
      detected_by: 'drift_detector_confianca',
      payload: { confident_claims: confidentClaims, max_gap: maxGap, severity_hint },
      evidence_summary: `${confidentClaims.length} afirmações confiantes sobre skills de baixa confiança (max_gap=${maxGap.toFixed(2)})`,
    };
  },
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
