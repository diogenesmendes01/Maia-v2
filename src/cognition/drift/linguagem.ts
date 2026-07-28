/**
 * P4 Task 8 — Drift detector: LINGUAGEM (LLM-as-judge).
 *
 * LLM verifica vocabulário/registro recente do agente contra
 * `operational_profile.voice_descriptor`. Diferente do `tom`, foca em
 * vocabulário específico, gírias inadequadas, formalidade fora do registro,
 * ou linguagem ofensiva — não no "tom geral" da conversa.
 *
 * Severidade:
 *   - Linguagem ofensiva confirmada → `critico` (override do LLM hint).
 *   - Caso contrário, usa `severity_hint` devolvido pelo LLM
 *     (`baixo`/`medio`/`alto`/`critico`), com default `baixo`.
 *
 * Returns `null` quando não há mensagens do agente, quando o LLM responde
 * `drift_detected: false`, ou quando há erro/parse failure (defensivo).
 */
import { callLLM } from '@/lib/claude.js';
import { DriftType } from '@/types/enums.js';
import type { DriftDetector, DriftDetectionInput, DriftEvidence } from './types.js';

import { resolveLegacyPayload } from '@/identity/profile-legacy-resolver.js';

export const linguagemDetector: DriftDetector = {
  type: DriftType.LINGUAGEM,
  async detect(input: DriftDetectionInput): Promise<DriftEvidence | null> {
    // v3.1.1 contract (migration 061 + Codex review #163 round 4): the legacy
    // operational_profile now lives at profile_body.operational_profile on a
    // Drizzle-shaped row. Shared resolver handles read precedence.
    const { operational_profile: op } = resolveLegacyPayload(input.profile_active);
    const agentMessages = input.recent_messages.filter((m) => m.from === 'agent');
    if (agentMessages.length === 0) return null;

    const sample = agentMessages.slice(-20).map((m) => `- ${m.text}`).join('\n');

    const system = [
      'Você audita o vocabulário e registro linguístico do agente.',
      'Compare as últimas mensagens com o descritor de voz esperado.',
      'Sinalize: vocabulário fora do registro, gírias inadequadas, formalidade excessiva ou linguagem ofensiva.',
      'Devolva JSON estrito.',
    ].join('\n');
    const user = [
      `DESCRITOR DE VOZ:\n${op.voice_descriptor ?? '(vazio)'}\n`,
      `MENSAGENS RECENTES:\n${sample}\n`,
      'Devolva {"drift_detected": bool, "severity_hint": "baixo"|"medio"|"alto"|"critico", "offensive": bool, "examples": [...], "reasoning": "..."}',
    ].join('\n');

    try {
      const completion = await callLLM({
        workload: 'drift_detector',
        max_tokens: 600,
        system,
        messages: [{ role: 'user', content: user }],
      });
      const text = completion.content ?? '';
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return null;
      const parsed = JSON.parse(match[0]) as {
        drift_detected?: boolean;
        severity_hint?: string;
        offensive?: boolean;
        examples?: unknown[];
        reasoning?: string;
      };
      if (!parsed.drift_detected) return null;
      const severity_hint = parsed.offensive ? 'critico' : parsed.severity_hint ?? 'baixo';
      return {
        drift_type: DriftType.LINGUAGEM,
        detected_by: 'drift_detector_linguagem',
        payload: {
          severity_hint,
          offensive: parsed.offensive === true,
          examples: Array.isArray(parsed.examples) ? parsed.examples : [],
          reasoning: parsed.reasoning ?? '',
        },
        evidence_summary: (parsed.reasoning ?? 'drift de linguagem').slice(0, 200),
      };
    } catch {
      return null;
    }
  },
};
