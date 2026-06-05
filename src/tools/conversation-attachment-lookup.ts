/**
 * Issue #431 — `conversation_attachment_lookup` (boleto proposal domain adapter).
 *
 * Finds files already SENT during the current service interaction. This is NOT
 * a media downloader and never reaches Baileys / re-downloads WhatsApp media.
 *
 * Reuse boundary + schema reality (verified against the live gateway,
 * `src/gateway/baileys.ts:571-595`):
 *   - Reads via `mensagensRepo.recentInConversation(ctx.conversa.id, n)`, which
 *     pins tenant_id + agent_id from the ALS context AND filters to the caller's
 *     conversation (invariant #1). The `conversation_id` input is accepted for
 *     API parity but the read is ALWAYS the ALS conversation — a divergent id is
 *     ignored, never honored (no scope-escape vector).
 *   - `mensagens` has exactly ONE media column, `midia_url` (the local path the
 *     gateway saved). There is NO `media_local_path` / `media_mime` /
 *     `file_sha256` / `caption` column. The REAL keys the gateway writes:
 *       · midia_url  (column)            → media_local_path
 *       · conteudo   (column)            → caption (text/caption of the message)
 *       · tipo       (column)            → 'imagem' | 'audio' | 'documento' | …
 *       · metadata.media_mime            → media_mime
 *       · metadata.media_sha256          → file_sha256  (NB: NOT `file_sha256`)
 *       · metadata.whatsapp_id           → provider message id (for hints)
 *     so the output is assembled from the column + the `metadata` jsonb, not
 *     from non-existent columns.
 *
 * Behavior: returns only attachments visible in the active
 * tenant/agent/conversation scope; bounded; optional filtering by type / hints.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';
import { mensagensRepo } from '@/db/repositories.js';

const ATTACHMENT_TYPES = ['image', 'pdf', 'audio', 'document', 'unknown'] as const;

const inputSchema = z.object({
  // Accepted for API parity only — the read is pinned to the ALS conversation.
  conversation_id: z.string().max(120).optional(),
  protocol: z.string().max(120).optional(),
  attachment_hints: z.array(z.string().max(256)).max(20).optional(),
  attachment_type: z.enum(ATTACHMENT_TYPES).optional(),
  // How many recent messages to scan for attachments. Bounded.
  limit: z.number().int().positive().max(200).default(100),
});

const attachmentSchema = z.object({
  message_id: z.string(),
  type: z.string(),
  media_local_path: z.string().optional(),
  media_mime: z.string().optional(),
  file_sha256: z.string().optional(),
  created_at: z.string().optional(),
  caption: z.string().optional(),
});

const outputSchema = z.object({
  attachments: z.array(attachmentSchema),
  count: z.number(),
  warnings: z.array(z.string()),
});

/** Map the message `tipo` (PT, gateway vocabulary) to the contract's English
 * attachment type, refining `documento` to `pdf` when the MIME says so. */
function mapType(tipo: string, mime: string | null): string {
  switch (tipo) {
    case 'imagem':
      return 'image';
    case 'audio':
      return 'audio';
    case 'documento':
      return mime && mime.includes('pdf') ? 'pdf' : 'document';
    default:
      return 'unknown';
  }
}

export const conversationAttachmentLookupTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'conversation_attachment_lookup',
  description:
    'Lista os arquivos (imagens, PDFs, áudios, documentos) já enviados nesta conversa, lendo os metadados de mídia das mensagens. Não baixa nem rebaixa mídia do WhatsApp. Apenas leitura, escopo tenant/agente/conversa.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: [],
  side_effect: 'read',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'conversation_attachment_lookup_completed',
  handler: async (args, ctx) => {
    const warnings: string[] = [];
    if (args.conversation_id && args.conversation_id !== ctx.conversa.id) {
      // Do NOT honor a divergent id — pin to the ALS conversation (invariant #1).
      warnings.push('conversation_id_ignored_scoped_to_current_conversation');
    }

    const rows = await mensagensRepo.recentInConversation(ctx.conversa.id, args.limit);
    const hints = (args.attachment_hints ?? []).map((h) => h.toLowerCase()).filter((h) => h.length > 0);

    const attachments = rows
      .filter((m) => Boolean(m.midia_url))
      .map((m) => {
        const meta = (m.metadata ?? {}) as Record<string, unknown>;
        const mime = typeof meta.media_mime === 'string' ? meta.media_mime : null;
        const sha = typeof meta.media_sha256 === 'string' ? meta.media_sha256 : undefined;
        return {
          message_id: m.id,
          type: mapType(m.tipo, mime),
          media_local_path: m.midia_url ?? undefined,
          media_mime: mime ?? undefined,
          file_sha256: sha,
          created_at: m.created_at.toISOString(),
          caption: m.conteudo ?? undefined,
        };
      })
      .filter((a) => (args.attachment_type ? a.type === args.attachment_type : true))
      .filter((a) => {
        if (hints.length === 0) return true;
        const hay = [a.caption ?? '', a.media_local_path ?? '', a.file_sha256 ?? '']
          .join(' ')
          .toLowerCase();
        return hints.some((h) => hay.includes(h));
      });

    if (attachments.length === 0) warnings.push('no_attachments_in_scope');

    return { attachments, count: attachments.length, warnings };
  },
};
