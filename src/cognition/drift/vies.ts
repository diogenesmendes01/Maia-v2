/**
 * P4 Task 8 — Drift detector: VIES (regex + LLM).
 *
 * Híbrido: primeiro filtra mensagens do agente por padrões de generalização
 * (regex). Se houver match, pergunta ao Sonnet se essas mensagens contêm
 * vieses reais (classificação semântica). Combina determinismo (regex) com
 * julgamento (LLM).
 *
 * Floor determinístico: se o LLM falhar (rede, parse), o detector AINDA
 * devolve evidência com `severity_hint='baixo'` para que a regex não seja
 * silenciosamente engolida. Esse é o ponto: a regex é a base; o LLM eleva
 * a severidade quando confirma. Sem LLM, a regex sozinha não é alarme
 * crítico, mas merece registro.
 *
 * Returns `null` quando não há matches regex (sem chamar Anthropic), ou
 * quando o LLM classifica como falso positivo (`drift_detected: false`).
 */
import { callLLM } from '@/lib/claude.js';
import { DriftType } from '@/types/enums.js';
import type { DriftDetector, DriftDetectionInput, DriftEvidence } from './types.js';

// Heuristic patterns that often signal bias-prone generalizations
const GENERALIZATION_REGEXES = [
  /\btodos? os? \w+\b/i,
  /\bsempre que \w+\b/i,
  /\b(qualquer|todo) cliente \w+/i,
  /\b(homens|mulheres|jovens|idosos|brasileiros|estrangeiros)\b.*(?:nunca|sempre|costumam|tendem a|geralmente)/i,
  /\bs?eu (?:tipo|grupo|perfil) de \w+ (?:nunca|sempre|n[ãa]o)/i,
];

export const viesDetector: DriftDetector = {
  type: DriftType.VIES,
  async detect(input: DriftDetectionInput): Promise<DriftEvidence | null> {
    const agentMessages = input.recent_messages.filter((m) => m.from === 'agent');
    const matches: Array<{ message_id: string; text: string; matched_pattern: string }> = [];

    for (const msg of agentMessages) {
      for (const re of GENERALIZATION_REGEXES) {
        if (re.test(msg.text)) {
          matches.push({
            message_id: msg.id,
            text: msg.text.slice(0, 300),
            matched_pattern: re.source,
          });
          break;
        }
      }
    }

    if (matches.length === 0) return null;

    const sample = matches.map((m) => `- (pattern: ${m.matched_pattern}) "${m.text}"`).join('\n');
    const system = [
      'Você audita mensagens de um agente em busca de generalizações enviesadas.',
      'Para cada mensagem suspeita, classifique como: bias_real | falso_positivo | inconclusivo.',
      'Devolva JSON estrito.',
    ].join('\n');
    const user = [
      `MENSAGENS SUSPEITAS (filtradas por regex):\n${sample}\n`,
      'Devolva {"drift_detected": bool, "severity_hint": "baixo"|"medio"|"alto"|"critico", "confirmed": [...], "reasoning": "..."}',
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
      if (!match) {
        // LLM unable to judge — surface regex matches anyway as soft signal (severity baixo)
        return {
          drift_type: DriftType.VIES,
          detected_by: 'drift_detector_vies',
          payload: { regex_matches: matches, llm_unparseable: true, severity_hint: 'baixo' },
          evidence_summary: `${matches.length} matches regex de generalização (LLM não classificou)`,
        };
      }
      const parsed = JSON.parse(match[0]) as {
        drift_detected?: boolean;
        severity_hint?: string;
        confirmed?: unknown[];
        reasoning?: string;
      };
      if (!parsed.drift_detected) return null;
      return {
        drift_type: DriftType.VIES,
        detected_by: 'drift_detector_vies',
        payload: {
          regex_matches: matches,
          confirmed: Array.isArray(parsed.confirmed) ? parsed.confirmed : [],
          severity_hint: parsed.severity_hint ?? 'medio',
          reasoning: parsed.reasoning ?? '',
        },
        evidence_summary: (parsed.reasoning ?? `${matches.length} possíveis vieses detectados`).slice(0, 200),
      };
    } catch {
      // Defensive — but DO surface regex matches at baixo severity, even when LLM is down.
      // This is the "regex + LLM" detector; the regex side is the deterministic floor.
      return {
        drift_type: DriftType.VIES,
        detected_by: 'drift_detector_vies',
        payload: { regex_matches: matches, llm_error: true, severity_hint: 'baixo' },
        evidence_summary: `${matches.length} matches regex de generalização (LLM falhou)`,
      };
    }
  },
};
