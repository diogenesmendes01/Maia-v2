/**
 * P4 Task 8 — Drift detector: TOM.
 *
 * LLM-as-judge: avalia se as mensagens recentes do agente desviam do
 * `core_immutable.identity_block` + `operational_profile.voice_descriptor`.
 * Modelo: Sonnet 4.6 (raciocínio mais sutil que Haiku para "tom").
 *
 * Returns `null` para "sem drift", "sem mensagens do agente", ou erro
 * defensivo. Erros NÃO são tratados como drift; o orchestrator (cluster 3)
 * cuida de timeout/fallback via `runCognitiveModule`.
 */
import Anthropic from '@anthropic-ai/sdk';
import { DriftType } from '@/types/enums.js';
import type { DriftDetector, DriftDetectionInput, DriftEvidence } from './types.js';

type CoreImmutable = { identity_block?: string };
type OpProfile = { voice_descriptor?: string };

export const tomDetector: DriftDetector = {
  type: DriftType.TOM,
  async detect(input: DriftDetectionInput): Promise<DriftEvidence | null> {
    const core = (input.profile_active.core_immutable ?? {}) as CoreImmutable;
    const op = (input.profile_active.operational_profile ?? {}) as OpProfile;
    const agentMessages = input.recent_messages.filter((m) => m.from === 'agent');
    if (agentMessages.length === 0) return null;

    const sample = agentMessages.slice(-20).map((m) => `- ${m.text}`).join('\n');

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });
    const system = [
      'Você é um auditor de identidade conversacional.',
      'Dado o "núcleo" (identidade do agente) e o "descritor de voz", analise as últimas mensagens do agente.',
      'Identifique se o tom delas DESVIA do esperado. Devolva JSON estrito.',
    ].join('\n');
    const user = [
      `NÚCLEO IDENTIDADE:\n${core.identity_block ?? '(vazio)'}\n`,
      `DESCRITOR DE VOZ:\n${op.voice_descriptor ?? '(vazio)'}\n`,
      `MENSAGENS RECENTES DO AGENTE:\n${sample}\n`,
      'Devolva {"drift_detected": bool, "severity_hint": "baixo"|"medio"|"alto"|"critico", "examples": [...], "reasoning": "..."}.',
    ].join('\n');

    try {
      const completion = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        system,
        messages: [{ role: 'user', content: user }],
      });
      const text = completion.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('');
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return null;
      const parsed = JSON.parse(match[0]) as {
        drift_detected?: boolean;
        severity_hint?: string;
        examples?: unknown[];
        reasoning?: string;
      };
      if (!parsed.drift_detected) return null;
      return {
        drift_type: DriftType.TOM,
        detected_by: 'drift_detector_tom',
        payload: {
          severity_hint: parsed.severity_hint ?? 'baixo',
          examples: Array.isArray(parsed.examples) ? parsed.examples : [],
          reasoning: parsed.reasoning ?? '',
        },
        evidence_summary: (parsed.reasoning ?? 'drift de tom detectado').slice(0, 200),
      };
    } catch {
      // Errors are not "no drift" — but the orchestrator wraps with runCognitiveModule fallback null.
      // Returning null here makes detector testable in isolation; orchestrator's fallback covers timeouts.
      return null;
    }
  },
};
