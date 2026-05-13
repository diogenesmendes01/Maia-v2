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
 * Provider-agnostic (P86-C4): usa `callLLM`. Erros propagam para o runner.
 *
 * Returns `null` quando não há mensagens do agente, ou quando o LLM responde
 * `drift_detected: false`. Throws em falha de provider/parse — o runner
 * audita como `status:'error'`.
 */
import { callLLM } from '@/lib/claude.js';
import { DriftType } from '@/types/enums.js';
import type { DriftDetector, DriftDetectionInput, DriftEvidence } from './types.js';

type OpProfile = { voice_descriptor?: string };

export const linguagemDetector: DriftDetector = {
  type: DriftType.LINGUAGEM,
  async detect(input: DriftDetectionInput): Promise<DriftEvidence | null> {
    const op = (input.profile_active.operational_profile ?? {}) as OpProfile;
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
  },
};
