/**
 * P4 Task 8 — Drift detector: VALORES.
 *
 * LLM-as-judge: verifica se as mensagens recentes do agente CONTRADIZEM
 * explicitamente algum dos `core_immutable.principles`.
 *
 * Provider-agnostic (P86-C4): usa `callLLM`. Erros propagam para o runner.
 *
 * Returns `null` quando não há princípios definidos, sem mensagens do agente,
 * sem drift detectado, ou quando o JSON do LLM não pode ser parseado. Throws
 * em falha de API/timeout — runCognitiveModule converte em audit observável.
 */
import { callLLM } from '@/lib/claude.js';
import { DriftType } from '@/types/enums.js';
import type { DriftDetector, DriftDetectionInput, DriftEvidence } from './types.js';

type CoreImmutable = { principles?: string[] };

export const valoresDetector: DriftDetector = {
  type: DriftType.VALORES,
  async detect(input: DriftDetectionInput): Promise<DriftEvidence | null> {
    const core = (input.profile_active.core_immutable ?? {}) as CoreImmutable;
    const principles = Array.isArray(core.principles) ? core.principles : [];
    if (principles.length === 0) return null;

    const agentMessages = input.recent_messages.filter((m) => m.from === 'agent');
    if (agentMessages.length === 0) return null;

    const sample = agentMessages.slice(-20).map((m) => `- ${m.text}`).join('\n');
    const principlesTxt = principles.map((p, i) => `${i + 1}. ${p}`).join('\n');

    const system = [
      'Você é um auditor de princípios do agente.',
      'Dado os princípios do núcleo e as últimas mensagens do agente,',
      'identifique se alguma contradiz explicitamente um princípio. Devolva JSON.',
    ].join('\n');
    const user = [
      `PRINCÍPIOS:\n${principlesTxt}\n`,
      `MENSAGENS RECENTES DO AGENTE:\n${sample}\n`,
      'Devolva {"drift_detected": bool, "severity_hint": "baixo"|"medio"|"alto"|"critico", "violated_principles": [<indices>], "examples": [...], "reasoning": "..."}',
    ].join('\n');

    const res = await callLLM({
      system,
      messages: [{ role: 'user', content: user }],
      max_tokens: 600,
      temperature: 0.2,
    });
    const text = res.content ?? '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as {
      drift_detected?: boolean;
      severity_hint?: string;
      violated_principles?: number[];
      examples?: unknown[];
      reasoning?: string;
    };
    if (!parsed.drift_detected) return null;
    return {
      drift_type: DriftType.VALORES,
      detected_by: 'drift_detector_valores',
      payload: {
        severity_hint: parsed.severity_hint ?? 'medio',
        violated_principles: Array.isArray(parsed.violated_principles)
          ? parsed.violated_principles
          : [],
        examples: Array.isArray(parsed.examples) ? parsed.examples : [],
        reasoning: parsed.reasoning ?? '',
      },
      evidence_summary: (parsed.reasoning ?? 'drift de valores detectado').slice(0, 200),
    };
  },
};
