/**
 * P8d §6 — Drift detector: papel (LLM-as-judge).
 *
 * 9º detector. Verifica aderência das mensagens recentes do agente ao
 * `role_descriptor` declarado em `profile_body.identity`.
 *
 * Exemplos de drift:
 *  - Profile = `atendimento_financeiro_pf`, agente responde dúvidas trabalhistas
 *  - Profile = `consultoria_juridica`, agente está fechando vendas
 *
 * Returns `null` quando:
 *  - role_descriptor é '' ou 'unset' (sem papel para auditar)
 *  - sem mensagens do agente (nada para auditar)
 *  - LLM diz drift_detected=false
 *  - JSON inválido / Anthropic throw (defensivo, mesma justificativa do tom)
 */
import Anthropic from '@anthropic-ai/sdk';
import { DriftType } from '@/types/enums.js';
import type { DriftDetector, DriftDetectionInput, DriftEvidence } from './types.js';

type IdentityPapel = { role_descriptor?: string; priorities?: string[] };

export const papelDriftDetector: DriftDetector = {
  type: DriftType.PAPEL_DRIFT,
  async detect(input: DriftDetectionInput): Promise<DriftEvidence | null> {
    const body = (input.profile_active.profile_body ?? {}) as Record<string, unknown>;
    const identity = (body.identity ?? {}) as IdentityPapel;

    const role = typeof identity.role_descriptor === 'string' ? identity.role_descriptor : '';
    if (!role || role === 'unset') return null;

    const priorities = Array.isArray(identity.priorities) ? identity.priorities : [];

    const agentMessages = input.recent_messages.filter((m) => m.from === 'agent');
    if (agentMessages.length === 0) return null;

    const sample = agentMessages
      .slice(-20)
      .map((m) => `- ${m.text}`)
      .join('\n');

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });
    const system = [
      'Você é um auditor de papel operacional do agente.',
      'Dado o papel declarado e as prioridades, avalie se as mensagens recentes',
      'estão aderentes ao papel ou claramente saem do escopo. Devolva JSON.',
    ].join('\n');
    const user = [
      `PAPEL DECLARADO: ${role}\n`,
      `PRIORIDADES: ${priorities.length > 0 ? priorities.join(', ') : '(nenhuma)'}\n`,
      `MENSAGENS RECENTES DO AGENTE:\n${sample}\n`,
      'Devolva {"drift_detected": bool, "severity_hint": "baixo"|"medio"|"alto"|"critico", "off_role_examples": [...], "observed_role_inferred": "...", "reasoning": "..."}.',
    ].join('\n');

    try {
      const completion = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 700,
        system,
        messages: [{ role: 'user', content: user }],
      });
      const text = completion.content
        .filter((c): c is Anthropic.TextBlock => c.type === 'text')
        .map((c) => c.text)
        .join('');
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return null;
      const parsed = JSON.parse(match[0]) as {
        drift_detected?: boolean;
        severity_hint?: string;
        off_role_examples?: unknown[];
        observed_role_inferred?: string;
        reasoning?: string;
      };
      if (!parsed.drift_detected) return null;

      return {
        drift_type: DriftType.PAPEL_DRIFT,
        detected_by: 'drift_detector_papel',
        payload: {
          severity_hint: parsed.severity_hint ?? 'medio',
          declared_role: role,
          observed_role_inferred:
            typeof parsed.observed_role_inferred === 'string'
              ? parsed.observed_role_inferred
              : null,
          off_role_examples: Array.isArray(parsed.off_role_examples)
            ? parsed.off_role_examples
            : [],
          reasoning: parsed.reasoning ?? '',
        },
        evidence_summary: (parsed.reasoning ?? 'papel desviado').slice(0, 200),
      };
    } catch {
      return null; // defensivo; orchestrator wrappa fallback null
    }
  },
};
