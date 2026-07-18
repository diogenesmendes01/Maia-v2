/**
 * Sonda sintética (spec §1.4c) — LLM-as-judge. Asserção SECUNDÁRIA e opt-in
 * (sub-flag MAIA_PROBE_LLM_JUDGE): dá uma nota "a resposta satisfez a intenção?"
 * para cenários sem efeito determinístico. Para o cenário de tool (§1.4a) a
 * asserção PRIMÁRIA é o efeito colateral verificável — o judge só complementa
 * (registrado no detail; não rebaixa um efeito satisfeito).
 *
 * Implementado desde a v1 (ligável sem redeploy). Falha SEGURO: qualquer erro
 * ⇒ veredito indeterminado (`pass: null`), nunca derruba o run.
 *
 * Fica em src/probe/ (não src/{agent,workers,cognition}/), então o gate de
 * auditoria cognitiva (grep por `callLLM(` naqueles diretórios) não se aplica —
 * é uma sonda de QA, não um módulo do agente no hot-path.
 */
import { callLLM } from '../lib/claude.js';
import { logger } from '../lib/logger.js';

export type JudgeVerdict = { pass: boolean | null; reason: string };

const JUDGE_SYSTEM =
  'Você é um juiz objetivo de QA de um assistente financeiro. Avalie se a ' +
  'RESPOSTA satisfaz a INTENÇÃO do pedido do usuário. Seja tolerante a ' +
  'variações de forma; foque na substância. Responda SOMENTE com um JSON ' +
  '{"verdict":"pass"|"fail","reason":"<curto>"} e nada mais.';

export async function judgeReply(input: {
  intent: string;
  prompt: string;
  reply: string | null;
}): Promise<JudgeVerdict> {
  if (!input.reply || input.reply.trim().length === 0) {
    return { pass: false, reason: 'sem resposta para julgar' };
  }
  try {
    const res = await callLLM({
      system: JUDGE_SYSTEM,
      messages: [
        {
          role: 'user',
          content:
            `INTENÇÃO: ${input.intent}\n\n` +
            `PEDIDO DO USUÁRIO: ${input.prompt}\n\n` +
            `RESPOSTA DO ASSISTENTE: ${input.reply}\n\n` +
            'A resposta satisfez a intenção?',
        },
      ],
      max_tokens: 200,
      temperature: 0,
    });
    const text = res.content ?? '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as { verdict?: unknown; reason?: unknown };
      const pass = String(parsed.verdict).toLowerCase() === 'pass';
      const reason = typeof parsed.reason === 'string' ? parsed.reason : '';
      return { pass, reason };
    }
    // Sem JSON parseável: heurística tolerante por token.
    const hasPass = /\bpass\b/i.test(text);
    const hasFail = /\bfail\b/i.test(text);
    if (hasPass && !hasFail) return { pass: true, reason: text.slice(0, 160) };
    if (hasFail && !hasPass) return { pass: false, reason: text.slice(0, 160) };
    return { pass: null, reason: 'veredito não-parseável' };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'synthetic_probe.judge_failed');
    return { pass: null, reason: 'erro no judge' };
  }
}
