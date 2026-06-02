/**
 * calendar-pattern-detector — LLM Haiku detecta padrões de feriado em
 * transcripts. Wrap em runCognitiveModule (P7 invariant).
 *
 * Input: trecho de conversa que pode mencionar feriado ("amanhã estamos
 * fechados", "feriado da padaria", "recesso 24/12").
 *
 * Output: descriptor estruturado se positivo (parseável por holiday-descriptor),
 * null se LLM diz que não é padrão de feriado.
 */
import Anthropic from '@anthropic-ai/sdk';
import { runCognitiveModule } from './runner.js';
import {
  buildHolidayDescriptor,
  type HolidayProposalType,
} from './holiday-descriptor.js';

export interface CalendarDetectorInput {
  text: string;
  entidade_id?: string;
  conversa_id?: string;
  turno_id?: string;
}

export interface CalendarDetectorOutput {
  is_holiday_pattern: boolean;
  name?: string;
  month?: number;
  day?: number;
  year?: number;
  type?: HolidayProposalType;
  scope?: 'national' | 'state' | 'municipal' | 'entity_custom' | 'holding_recess';
  descriptor?: string;
}

const DETECTOR_MODEL = 'claude-haiku-4-5-20251001';
const DETECTOR_TIMEOUT_MS = 15000;

export async function detectHolidayPattern(
  input: CalendarDetectorInput,
): Promise<CalendarDetectorOutput | null> {
  const result = await runCognitiveModule<CalendarDetectorOutput | null>(
    {
      name: 'calendar_pattern_detector',
      timeoutMs: DETECTOR_TIMEOUT_MS,
      triggered_by: 'async_event',
      conversa_id: input.conversa_id,
      turno_id: input.turno_id,
      fallback: null,
    },
    async () => {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });
      const system = [
        'Você é um classificador rápido de padrões de feriado/recesso em conversas em português brasileiro.',
        'Dado um trecho, decida se ele indica um feriado/recesso reconhecível.',
        'Retorne JSON estrito: { "is_holiday_pattern": boolean, "name": string?, "month": 1-12?, "day": 1-31?, "year": int?, "type": "national"|"state"|"municipal"|"entity_custom"|"holding_recess"?, "scope": idem? }',
        'Se NÃO é padrão de feriado, retorne apenas { "is_holiday_pattern": false }.',
        'NÃO inclua julgamento de valor. NÃO invente dados que não estão no trecho.',
      ].join('\n');

      const completion = await anthropic.messages.create({
        model: DETECTOR_MODEL,
        max_tokens: 500,
        system,
        messages: [{ role: 'user', content: input.text }],
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

      let parsed: CalendarDetectorOutput;
      try {
        parsed = JSON.parse(match[0]) as CalendarDetectorOutput;
      } catch {
        return null;
      }

      if (!parsed.is_holiday_pattern) return parsed;

      // Constrói descriptor canônico se positivo + completo.
      if (parsed.name && parsed.month && parsed.day && parsed.type) {
        const entId = input.entidade_id ?? 'global';
        parsed.descriptor = buildHolidayDescriptor({
          name: parsed.name,
          month: parsed.month,
          day: parsed.day,
          type: parsed.type,
          entidade_id: entId,
        });
      }

      return parsed;
    },
  );

  return result.output;
}
