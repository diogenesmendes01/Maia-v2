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
 *  - Anthropic throw / timeout → status='error'/'timeout' (runner cobre).
 *  - JSON ausente / malformado / inválido pelo Zod schema → THROW
 *    `LLMGateParseError` (Codex review #97 finding 2). Antes, o gate
 *    devolvia `null` silenciosamente e o runner registrava status='success'
 *    com output=null — uma regressão de prompt podia ficar invisível.
 *    Agora o throw força runner status='error', fallback_triggered=true e
 *    fallback_reason com a mensagem do erro de parse.
 *  - O contrato NÃO força no-downgrade no LLM — defesa em profundidade
 *    deixa essa validação para o scorer (cf. `scorer.ts`).
 */
import { z } from 'zod';
import { callLLM } from '@/lib/claude.js';
import { runCognitiveModule } from '@/cognition/runner.js';
import { logger } from '@/lib/logger.js';
import { RiskLevel } from '@/types/enums.js';
import type { LLMGate } from './types.js';

/**
 * Zod schema do JSON estrito esperado do Haiku. Falha de validação =
 * throw `LLMGateParseError` para o runCognitiveModule registrar como erro.
 */
const HaikuResponseSchema = z.object({
  suggested_level: z.enum([
    RiskLevel.LOW,
    RiskLevel.MEDIUM,
    RiskLevel.HIGH,
    RiskLevel.CRITICAL,
  ]),
  reason: z.string().optional().default(''),
});

/**
 * Erro tipado emitido quando a resposta do Haiku é unparseable / inválida.
 * Causa: runner classifica como `status='error'` e `fallback_triggered=true`,
 * o que aparece no cognitive_module_log e permite alarme operacional.
 *
 * Defesa em profundidade: o scorer trata `gate→null` (que é o fallback do
 * runner) como "manter heurístico" — o piso de risco nunca cai.
 */
export class LLMGateParseError extends Error {
  readonly kind: 'no_json' | 'malformed_json' | 'schema_invalid';
  readonly raw_text_sample: string;
  constructor(kind: LLMGateParseError['kind'], raw_text_sample: string, detail?: string) {
    super(`risk_assessor_llm parse failure (${kind})${detail ? ': ' + detail : ''}`);
    this.name = 'LLMGateParseError';
    this.kind = kind;
    // Cap to avoid logging huge bodies; first 200 chars is enough for postmortem.
    this.raw_text_sample = raw_text_sample.slice(0, 200);
  }
}

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

      // Issue #508: o modelo não é mais fixado aqui. O tier `fast` do
      // workload `risk_classifier` é resolvido pelo backend a partir das
      // settings dinâmicas — antes este gate ignorava o modelo configurado
      // pelo operador e exigia ANTHROPIC_API_KEY mesmo com
      // LLM_PROVIDER=openrouter.
      const completion = await callLLM({
        workload: 'risk_classifier',
        max_tokens: 150,
        system,
        messages: [{ role: 'user', content: user }],
      });
      const text = completion.content ?? '';

      // Stage 1: JSON detection. Sem chaves no texto → throw para audit.
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) {
        logger.warn(
          { module: 'risk_assessor_llm', kind: 'no_json', sample: text.slice(0, 80) },
          'haikuRiskGate.parse_failure_no_json',
        );
        throw new LLMGateParseError('no_json', text);
      }

      // Stage 2: JSON.parse. Sintaxe inválida → throw.
      let raw: unknown;
      try {
        raw = JSON.parse(match[0]);
      } catch (err) {
        const msg = (err as Error).message;
        logger.warn(
          { module: 'risk_assessor_llm', kind: 'malformed_json', err: msg },
          'haikuRiskGate.parse_failure_malformed',
        );
        throw new LLMGateParseError('malformed_json', match[0], msg);
      }

      // Stage 3: Zod schema. Shape inválido (level fora do enum, suggested_level
      // ausente, etc.) → throw para audit.
      const validation = HaikuResponseSchema.safeParse(raw);
      if (!validation.success) {
        const issues = validation.error.issues
          .map((i) => `${i.path.join('.')}:${i.code}`)
          .join('|');
        logger.warn(
          { module: 'risk_assessor_llm', kind: 'schema_invalid', issues },
          'haikuRiskGate.parse_failure_schema',
        );
        throw new LLMGateParseError('schema_invalid', match[0], issues);
      }

      return {
        suggested_level: validation.data.suggested_level,
        reason: validation.data.reason,
      };
    },
  );
  return result.output;
};
