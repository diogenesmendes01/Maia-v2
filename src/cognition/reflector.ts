import type { CognitiveEvent } from './types.js';
import { callLLM } from '@/lib/claude.js';
import { runCognitiveModule } from './runner.js';

/**
 * Reflector — gera candidato bruto (texto livre) a partir de evento cognitivo.
 * Saída é um insight não-tipado que será classificado pelo Classifier.
 */
export async function reflect(
  event: CognitiveEvent,
): Promise<{ insight: string; tokens_in?: number; tokens_out?: number } | null> {
  const systemPrompt = buildSystemForEvent(event);
  const userPrompt = buildUserForEvent(event);

  const result = await runCognitiveModule(
    {
      name: `reflector.${event.type}`,
      triggered_by:
        event.type === 'user_correction' || event.type === 'internal_gap'
          ? 'sync_conditional'
          : 'async_event',
      conversa_id: 'conversa_id' in event ? event.conversa_id : undefined,
      timeoutMs: 10000,
    },
    async () => {
      const res = await callLLM({
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        max_tokens: 500,
        temperature: 0.2,
      });
      return {
        insight: (res.content ?? '').trim(),
        tokens_in: res.usage?.input_tokens,
        tokens_out: res.usage?.output_tokens,
      };
    },
  );

  return result.output;
}

function buildSystemForEvent(event: CognitiveEvent): string {
  const base = `Você é o Reflector da Maia. Ao receber um evento cognitivo, produza um insight em texto livre que será classificado depois. Seja preciso, sem inventar. Se não há insight útil, diga "DESCARTE: <motivo>".`;
  switch (event.type) {
    case 'user_correction':
      return `${base}\n\nFoco: o que essa correção te ensina sobre como evitar o mesmo erro?`;
    case 'success_explicit':
      return `${base}\n\nFoco: que padrão dessa interação merece reforço pra próximas vezes?`;
    case 'conversation_closed':
      return `${base}\n\nFoco: que aprendizado essa conversa inteira deixa? Pode ser um fato sobre o interlocutor, um procedimento que emergiu, ou uma lacuna identificada.`;
    case 'pattern_detected':
      return `${base}\n\nFoco: como esse padrão repetido deve ser tratado daqui pra frente? Vira regra, procedimento, ou pede capacidade nova?`;
    case 'internal_gap':
      return `${base}\n\nFoco: identifique a capacidade faltante. Que tool, conhecimento ou procedimento te faltou pra responder bem?`;
  }
}

function buildUserForEvent(event: CognitiveEvent): string {
  return JSON.stringify(event, null, 2);
}
