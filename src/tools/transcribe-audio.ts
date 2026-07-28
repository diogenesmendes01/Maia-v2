import { z } from 'zod';
import type { Tool } from './_registry.js';
import { transcribeWhisper } from '@/lib/whisper.js';
import { wrapWithTag } from '@/agent/sanitize.js';
import { resolveAttachmentById } from '@/lib/attachment-resolver.js';
import { readStoredMedia, MAX_AUDIO_BYTES } from '@/lib/media-guard.js';
import { TypedError } from '@/lib/utils.js';

const inputSchema = z.object({
  attachment_id: z.string().uuid(),
});

const outputSchema = z.object({
  texto: z.string(),
  idioma: z.string(),
  duracao_segundos: z.number(),
  confianca: z.number(),
});

/**
 * P0 audit chapter 4: input is an OPAQUE `attachment_id` (a mensagens row id
 * from `conversation_attachment_lookup`). The backend resolves it
 * (tenant/agent/conversation-scoped, fail-closed) and reads the audio through
 * media-guard (containment under MEDIA_ROOT, symlink rejection, 25MB cap
 * enforced pre-read, magic-byte mime sniffing) before any Whisper upload.
 */
export const transcribeAudioTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'transcribe_audio',
  description:
    'Transcreve um áudio (voice note) para texto em português. Recebe o attachment_id de um anexo desta conversa (obtenha via conversation_attachment_lookup).',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['read_balance'],
  side_effect: 'read',
  redis_required: true,
  operation_type: 'parse_only',
  audit_action: 'audio_transcribed',
  handler: async (args, ctx) => {
    const attachment = await resolveAttachmentById(ctx.conversa.id, args.attachment_id);
    if (!attachment) {
      throw new TypedError(
        'attachment_not_found',
        'anexo não encontrado nesta conversa — use conversation_attachment_lookup para obter um attachment_id válido',
      );
    }
    const media = await readStoredMedia(attachment.path, {
      maxBytes: MAX_AUDIO_BYTES,
      kind: 'audio',
    });
    const result = await transcribeWhisper({ buf: media.buf, mime: media.mime });
    return {
      ...result,
      texto: wrapWithTag(result.texto, 'audio_transcript'),
    };
  },
};
