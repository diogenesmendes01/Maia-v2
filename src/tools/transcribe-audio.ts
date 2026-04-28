import { z } from 'zod';
import type { Tool } from './_registry.js';
import { transcribeWhisper } from '@/lib/whisper.js';

const inputSchema = z.object({
  media_local_path: z.string().min(1),
  file_sha256: z.string().min(1),
});

const outputSchema = z.object({
  texto: z.string(),
  idioma: z.string(),
  duracao_segundos: z.number(),
  confianca: z.number(),
});

export const transcribeAudioTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'transcribe_audio',
  description: 'Transcreve um áudio (voice note) para texto em português.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['read_balance'],
  side_effect: 'read',
  redis_required: true,
  operation_type: 'parse_only',
  audit_action: 'audio_transcribed',
  handler: async (args) => {
    return transcribeWhisper(args.media_local_path);
  },
};
