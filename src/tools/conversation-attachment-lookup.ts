/**
 * Issue #416 — `conversation_attachment_lookup` (boleto proposal vertical, read).
 *
 * Retrieve files sent during the service interaction (by conversation id,
 * protocol, or attachment hints/type). Conservative: side_effect 'read'. Out of
 * scope (#416): a real attachment store integration — contract-honouring stub.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';

const inputSchema = z
  .object({
    conversation_id: z.string().max(128).optional(),
    protocol: z.string().max(128).optional(),
    attachment_type: z.string().max(64).optional(),
    attachment_hint: z.string().max(200).optional(),
  })
  .refine((v) => Boolean(v.conversation_id ?? v.protocol ?? v.attachment_hint ?? v.attachment_type), {
    message: 'a conversation id, protocol or attachment hint is required',
  });

const outputSchema = z.object({
  attachments: z
    .array(
      z.object({
        attachment_id: z.string(),
        type: z.string().optional(),
        filename: z.string().optional(),
        media_local_path: z.string().optional(),
        file_sha256: z.string().optional(),
        created_at: z.string().optional(),
      }),
    )
    .default([]),
});

export const conversationAttachmentLookupTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'conversation_attachment_lookup',
  description:
    'Recupera arquivos enviados durante o atendimento (por conversa, protocolo ou dica/tipo de anexo) e retorna a lista de anexos com metadados e referências recuperáveis. Apenas leitura.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: [],
  side_effect: 'read',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'conversation_attachment_looked_up',
  handler: async () => {
    // Stub: no live attachment store integration in #416.
    return { attachments: [] };
  },
};
