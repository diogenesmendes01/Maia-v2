import type { CognitiveEvent } from './types.js';
import { callLLM } from '@/lib/claude.js';
import { runCognitiveModule } from './runner.js';

/**
 * Reflector — gera candidato bruto (texto livre) a partir de evento cognitivo.
 * Saída é um insight não-tipado que será classificado pelo Classifier.
 *
 * `pessoa_id` (opcional) propaga a atribuição de custo do LLM pra pessoa certa
 * (ex.: reflexão disparada por correção de uma pessoa específica). Workers sem
 * contexto de pessoa (briefings, batches) deixam undefined.
 */
export async function reflect(
  event: CognitiveEvent,
  opts?: { pessoa_id?: string },
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
        workload: 'reflection',
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        max_tokens: 500,
        temperature: 0.2,
        pessoa_id: opts?.pessoa_id,
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

/**
 * Serializa apenas os campos semânticos do evento para o prompt do LLM.
 * Omite identificadores internos (UUIDs de conversa/mensagem) — eles não
 * ajudam o modelo a refletir e poluem o contexto, aumentando custo de tokens
 * e expondo shape interno desnecessariamente.
 */
function buildUserForEvent(event: CognitiveEvent): string {
  switch (event.type) {
    case 'user_correction':
      return JSON.stringify(
        {
          type: event.type,
          correction_text: event.correction_text,
          previous_response_text: event.previous_response_text,
        },
        null,
        2,
      );
    case 'success_explicit':
      return JSON.stringify(
        {
          type: event.type,
          signal: event.signal,
          context_summary: event.context_summary,
        },
        null,
        2,
      );
    case 'conversation_closed':
      return JSON.stringify(
        {
          type: event.type,
          summary: event.summary,
          duration_minutes: event.duration_minutes,
          transcript: event.transcript,
        },
        null,
        2,
      );
    case 'pattern_detected':
      return JSON.stringify(
        {
          type: event.type,
          pattern_descriptor: event.pattern_descriptor,
          evidence_count: event.evidence_count,
        },
        null,
        2,
      );
    case 'internal_gap':
      return JSON.stringify(
        {
          type: event.type,
          gap_description: event.gap_description,
          attempted_response: event.attempted_response,
        },
        null,
        2,
      );
  }
}
