/**
 * P9c — Stage 2 do risk-assessor: gate Haiku 4.5 (LLM-as-judge).
 *
 * Chamada APENAS para casos ambíguos (low/medium ambíguos). Conversa
 * claramente simples (low não-ambíguo) e qualquer high/critical pulam o
 * gate — preserva o princípio "sync mínimo" (spec §10.11).
 *
 * Contrato:
 *  - Wrapped in `runCognitiveModule` (`name='risk_assessor_llm'`,
 *    `triggered_by='sync_conditional'`, `timeoutMs=2500`, fallback=null,
 *    audit=true). cognitive_module_log registra latência + status.
 *  - Anthropic throw / timeout / JSON malformado → null silencioso
 *    (gate retorna null; scorer trata como "manter heurístico").
 *  - O contrato NÃO força no-downgrade no LLM — defesa em profundidade
 *    deixa essa validação para o scorer (cf. `scorer.ts`).
 */
import Anthropic from '@anthropic-ai/sdk';
import { runCognitiveModule } from '@/cognition/runner.js';
import { RiskLevel } from '@/types/enums.js';
import type { LLMGate } from './types.js';

const VALID_LEVELS: ReadonlySet<string> = new Set([
  RiskLevel.LOW,
  RiskLevel.MEDIUM,
  RiskLevel.HIGH,
  RiskLevel.CRITICAL,
]);

/**
 * Implementação default backed by Anthropic Haiku 4.5. Para tests que
 * querem isolar do SDK, passe um stub conformante a `LLMGate` aos
 * scorers em vez deste.
 */
export const haikuRiskGate: LLMGate = async ({ current_level, context_text }) => {
  const result = await runCognitiveModule<{ suggested_level: RiskLevel; reason: string } | null>(
    {
      name: 'risk_assessor_llm',
      version: 'v1',
      triggered_by: 'sync_conditional',
      timeoutMs: 2500,
      fallback: null,
    },
    async () => {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });
      const system = [
        'Você é um classificador de risco operacional. Recebe o nível atual',
        '(heurístico determinístico) e um texto de contexto, e retorna o nível',
        'SUGERIDO. Você só pode ELEVAR ou MANTER, NUNCA REBAIXAR.',
        'Níveis válidos: low, medium, high, critical (ordem crescente).',
        'Devolva JSON estrito: {"suggested_level": "<level>", "reason": "<curto>"}.',
      ].join(' ');
      const user = [
        `NÍVEL ATUAL (heurístico): ${current_level}`,
        '',
        'CONTEXTO:',
        context_text,
        '',
        'Devolva JSON.',
      ].join('\n');

      const completion = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        system,
        messages: [{ role: 'user', content: user }],
      });
      const text = (completion.content as Array<{ type: string; text?: string }>)
        .filter(
          (c): c is { type: 'text'; text: string } =>
            c.type === 'text' && typeof c.text === 'string',
        )
        .map((c) => c.text)
        .join('');
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return null;
      let parsed: { suggested_level?: string; reason?: string };
      try {
        parsed = JSON.parse(match[0]) as { suggested_level?: string; reason?: string };
      } catch {
        return null;
      }
      if (typeof parsed.suggested_level !== 'string') return null;
      if (!VALID_LEVELS.has(parsed.suggested_level)) return null;
      return {
        suggested_level: parsed.suggested_level as RiskLevel,
        reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      };
    },
  );
  return result.output;
};
