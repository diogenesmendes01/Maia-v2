/**
 * P4 Task 8 — Drift detector: TOM.
 *
 * LLM-as-judge: avalia se as mensagens recentes do agente desviam do
 * `core_immutable.identity_block` + `operational_profile.voice_descriptor`.
 *
 * Provider-agnostic: roteia via `callLLM` (respeitando `LLM_PROVIDER`,
 * `CLAUDE_MODEL_*` / `OPENROUTER_MODEL_*`) em vez de instanciar Anthropic
 * direto. Issue P86-C4: deployments com `LLM_PROVIDER=openrouter` antes
 * rodavam sem credenciais Anthropic e o catch silenciava a falha como
 * "sem drift" — drift critico podia ficar invisível.
 *
 * Erros API/parse PROPAGAM (throw) para que `runCognitiveModule` no
 * orchestrator audite como `status:'error'` / `status:'timeout'` em vez de
 * "success com output null". Sem swallow silencioso.
 *
 * Returns `null` para "sem drift" ou "sem mensagens do agente". Throws em
 * falha de provider/parse — o runner converte em fallback observável.
 */
import { callLLM } from '@/lib/claude.js';
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

    // No try/catch here: API / parse failures throw to the orchestrator's
    // runCognitiveModule wrapper, which records `status: 'error'` and uses
    // `fallback: null`. Silent null swallowing was P86-C4.
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
  },
};
