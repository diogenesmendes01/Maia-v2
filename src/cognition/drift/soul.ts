/**
 * P8b — Drift detector: SOUL_DRIFT (8º tipo, spec §5).
 *
 * Avalia se mensagens recentes do agente aderem às soul biases ATIVAS no
 * tenant+agent. Severidade NUNCA promove rollback de profile (decision-engine
 * mapeia soul_drift ALTO → queued_human, não frozen/rollback).
 *
 * Estratégia (preserva contract de outros detectores em `drift/types.ts`):
 *   1. early-return null se < 5 mensagens do agente (ruído estatístico baixo)
 *   2. fetch active biases via soulBiasesRepo.findActiveForScope
 *   3. para cada bias, aplica heurística simples (keywords) ANTES de gastar
 *      tokens em LLM judge
 *   4. quando heurística é inconclusiva, chama llmJudgeBiasAdherence — judge
 *      retorna confidence + adherence; só conta violação se conf >= 0.7
 *   5. severity_hint determinístico a partir de #violations
 *
 * Wrapper `runCognitiveModule` é injetado pelo orchestrator (drift/index.ts)
 * — este detector é testável em isolamento. Erros LLM devolvem null (sem
 * drift; orchestrator tem fallback own).
 */
import Anthropic from '@anthropic-ai/sdk';
import { DriftType, DriftSeverity } from '@/types/enums.js';
import { soulBiasesRepo } from '@/control-plane/soul/soul-biases-repo.js';
import type { SoulBias } from '@/db/schema.js';
import type {
  DriftDetector,
  DriftDetectionInput,
  DriftEvidence,
  DriftRecentMessage,
} from './types.js';

const SOUL_DRIFT_MIN_AGENT_MESSAGES = 5;

type Violation = {
  bias_id: string;
  principle: string;
  confidence: number;
  examples: string[];
  source: 'heuristic' | 'llm_judge';
};

export const soulDriftDetector: DriftDetector = {
  type: DriftType.SOUL_DRIFT,

  async detect(input: DriftDetectionInput): Promise<DriftEvidence | null> {
    const agentMessages = input.recent_messages.filter((m) => m.from === 'agent');
    if (agentMessages.length < SOUL_DRIFT_MIN_AGENT_MESSAGES) return null;

    const biases = await soulBiasesRepo.findActiveForScope({ limit: 50 });
    if (biases.length === 0) return null;

    const violations: Violation[] = [];

    for (const bias of biases) {
      // 1) Heurística cheap-first: usa keywords negativos definidos in-code
      // (não dependemos de embeddings/LLM). Quando heurística "afirma alta
      // confiança de violação", curto-circuita pra economizar tokens.
      const heur = heuristicViolation(bias, agentMessages);
      if (heur.violated_high_conf) {
        violations.push({
          bias_id: bias.id,
          principle: bias.principle,
          confidence: heur.confidence,
          examples: heur.examples,
          source: 'heuristic',
        });
        continue;
      }

      // 2) LLM judge: avalia aderência semântica. Retorna {adheres, conf, ex}.
      // No-downgrade rule (spec §5.3): se heurística diz "alta violação", LLM
      // judge NUNCA reverte para "aderente" (a violação heurística é piso).
      const judge = await llmJudgeBiasAdherence(bias, agentMessages);
      if (judge && !judge.adheres && judge.confidence >= 0.7) {
        violations.push({
          bias_id: bias.id,
          principle: bias.principle,
          confidence: judge.confidence,
          examples: judge.examples,
          source: 'llm_judge',
        });
      }
    }

    if (violations.length === 0) return null;

    const severity_hint =
      violations.length >= 5
        ? DriftSeverity.ALTO
        : violations.length >= 2
          ? DriftSeverity.MEDIO
          : DriftSeverity.BAIXO;

    return {
      drift_type: DriftType.SOUL_DRIFT,
      detected_by: 'drift_detector_soul',
      payload: {
        violations,
        biases_evaluated: biases.length,
        messages_evaluated: agentMessages.length,
        severity_hint,
      },
      evidence_summary: `${violations.length} bias(es) com aderência baixa em ${agentMessages.length} msgs`.slice(0, 200),
    };
  },
};

/**
 * Heurística simples: termos absolutistas/dogmáticos que tipicamente violam
 * biases de humildade/cautela. Configuração local; em prod, evoluir para
 * lista por bias (futuro: bias.heuristic_keywords).
 */
const ABSOLUTIST_KEYWORDS = [
  'sempre',
  'nunca',
  'com certeza',
  'certeza absoluta',
  'garantido',
  'sem dúvida',
  'obviamente',
];

function heuristicViolation(
  bias: SoulBias,
  messages: DriftRecentMessage[],
): { violated_high_conf: boolean; confidence: number; examples: string[] } {
  // Heurística genérica: conta mensagens que usam termos absolutistas. Bias
  // específicas podem ter chave `principle === 'humildade_epistemica'` que
  // amplifica o sinal.
  const isHumility = bias.principle.includes('humildade') || bias.principle.includes('humildad');
  let hits = 0;
  const examples: string[] = [];
  for (const m of messages) {
    const text = (m.text ?? '').toLowerCase();
    if (ABSOLUTIST_KEYWORDS.some((kw) => text.includes(kw))) {
      hits += 1;
      if (examples.length < 3) examples.push(m.text);
    }
  }
  const rate = hits / messages.length;
  // Conservative thresholds: 30% das msgs com termos absolutistas =
  // "alta confiança de violação" (heurística mata custo de LLM).
  // Para humildade bias, threshold é mais baixo (0.2) porque é o pico do efeito.
  const threshold = isHumility ? 0.2 : 0.4;
  return {
    violated_high_conf: rate >= threshold,
    confidence: Math.min(rate * 2, 1),
    examples,
  };
}

/**
 * LLM judge para aderência semântica. Sonnet 4.6 (raciocínio sutil); fallback
 * defensivo retorna null em qualquer erro / JSON malformado.
 *
 * Quando a flag/ENV ANTHROPIC_API_KEY não está disponível em testes, devolve
 * null silenciosamente — o caller decide o que fazer.
 */
async function llmJudgeBiasAdherence(
  bias: SoulBias,
  messages: DriftRecentMessage[],
): Promise<{ adheres: boolean; confidence: number; examples: string[] } | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const sample = messages.slice(-10).map((m) => `- ${m.text}`).join('\n');
  const anthropic = new Anthropic({ apiKey });
  const system = [
    'Você é um auditor de aderência comportamental.',
    'Dado um princípio comportamental ("soul bias") e mensagens recentes do agente, analise se as mensagens demonstram aderência ao princípio.',
    'Devolva JSON estrito.',
  ].join('\n');
  const user = [
    `PRINCÍPIO: ${bias.principle}`,
    `ORIENTAÇÃO: ${bias.guidance}`,
    '',
    `MENSAGENS RECENTES DO AGENTE:\n${sample}`,
    '',
    'Devolva {"adheres": bool, "confidence": 0-1, "examples": ["msg1", ...], "reasoning": "..."}',
  ].join('\n');

  try {
    const completion = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
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
      adheres?: boolean;
      confidence?: number;
      examples?: unknown[];
    };
    if (typeof parsed.adheres !== 'boolean') return null;
    return {
      adheres: parsed.adheres,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      examples: Array.isArray(parsed.examples)
        ? parsed.examples.filter((e): e is string => typeof e === 'string')
        : [],
    };
  } catch {
    return null;
  }
}
