/**
 * P4 Task 8 — Drift detector: ESCOPO (LLM-driven).
 *
 * Extrai promessas/compromissos das mensagens recentes do agente via LLM e
 * cruza contra `input.capabilities` (saída do P2 capability tracker). Se o
 * agente prometeu algo que ele NÃO TEM capability ativa para entregar →
 * drift.
 *
 * `input.capabilities` é um `Array<{ name, status }>` (P2). Apenas
 * capabilities com `status === 'active'` contam como disponíveis. A
 * comparação é case-insensitive em `name` para tolerar diferenças de
 * convenção entre o LLM (que extrai capability_required do texto) e o P2.
 *
 * Returns `null` quando não há mensagens do agente, quando o Anthropic falha
 * (defensivo — o orchestrator cuida do fallback via runCognitiveModule), ou
 * quando todas as promessas têm capability ativa.
 */
import Anthropic from '@anthropic-ai/sdk';
import { DriftType } from '@/types/enums.js';
import type { DriftDetector, DriftDetectionInput, DriftEvidence } from './types.js';

type CapabilityRow = { name?: string; status?: string };

export const escopoDetector: DriftDetector = {
  type: DriftType.ESCOPO,
  async detect(input: DriftDetectionInput): Promise<DriftEvidence | null> {
    const capabilities = Array.isArray(input.capabilities)
      ? (input.capabilities as CapabilityRow[])
      : [];
    const activeNames = new Set(
      capabilities
        .filter((c) => typeof c.name === 'string' && c.status === 'active')
        .map((c) => (c.name as string).toLowerCase()),
    );

    const agentMessages = input.recent_messages.filter((m) => m.from === 'agent');
    if (agentMessages.length === 0) return null;

    const sample = agentMessages
      .slice(-20)
      .map((m) => `- (id=${m.id}) ${m.text}`)
      .join('\n');

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });
    const system = [
      'Você audita o agente em busca de promessas que ele não pode cumprir.',
      'Extraia das mensagens dele promessas/compromissos para o usuário.',
      'Para cada promessa, devolva o "capability_required" (nome curto da capability necessária).',
      'Devolva JSON com lista de promessas extraídas.',
    ].join('\n');
    const user = [
      `MENSAGENS RECENTES DO AGENTE:\n${sample}\n`,
      'Devolva {"promises": [{"message_id": "...", "promise": "...", "capability_required": "..."}], "reasoning": "..."}',
    ].join('\n');

    try {
      const completion = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 800,
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
        promises?: Array<{ message_id?: string; promise?: string; capability_required?: string }>;
        reasoning?: string;
      };
      const promises = Array.isArray(parsed.promises) ? parsed.promises : [];
      const unfulfillable = promises.filter(
        (p) =>
          typeof p.capability_required === 'string' &&
          !activeNames.has(p.capability_required.toLowerCase()),
      );
      if (unfulfillable.length === 0) return null;

      const severity_hint =
        unfulfillable.length >= 3 ? 'critico' : unfulfillable.length >= 2 ? 'alto' : 'alto';

      return {
        drift_type: DriftType.ESCOPO,
        detected_by: 'drift_detector_escopo',
        payload: {
          unfulfillable_promises: unfulfillable,
          available_capabilities: Array.from(activeNames),
          severity_hint,
        },
        evidence_summary: `${unfulfillable.length} promessas sem capability ativa`,
      };
    } catch {
      return null;
    }
  },
};
