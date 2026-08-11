/**
 * Issue #431 — `conversation_attachment_lookup` (boleto proposal domain adapter).
 *
 * Finds files already SENT during the current service interaction. This is NOT
 * a media downloader and never reaches Baileys / re-downloads WhatsApp media.
 *
 * Reuse boundary + schema reality (verified against the live gateway,
 * `src/gateway/baileys.ts`):
 *   - Reads via `mensagensRepo.recentInConversation(ctx.conversa.id, n)`, which
 *     pins tenant_id + agent_id from the ALS context AND filters to the caller's
 *     conversation (invariant #1). The `conversation_id` input is accepted for
 *     API parity but the read is ALWAYS the ALS conversation — a divergent id is
 *     ignored, never honored (no scope-escape vector).
 *   - `mensagens` has exactly ONE media column, `midia_url` (the local path the
 *     gateway saved). P0 audit chapter 4: that path (and the stored sha) is NO
 *     LONGER exposed to the LLM. Each item carries an OPAQUE `attachment_id`
 *     (= the mensagens row id) that the parse/transcribe tools resolve
 *     server-side (scoped + fail-closed) and read through media-guard.
 *     Exposed per item: attachment_id, type (from `tipo` + metadata.media_mime),
 *     media_mime, created_at, caption (`conteudo`).
 *
 * Behavior: returns only attachments visible in the active
 * tenant/agent/conversation scope; bounded; optional filtering by type / hints
 * (hints match caption + attachment_id prefix only — never paths or shas).
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
  // Opaque handle for parse_image / parse_receipt / parse_boleto /
  // transcribe_audio / receipt_validate. Equals the mensagens row id.
  attachment_id: z.string(),
  message_id: z.string(),
  type: z.string(),
  media_mime: z.string().optional(),
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
    'Lista os arquivos (imagens, PDFs, áudios, documentos) já enviados nesta conversa, com o attachment_id de cada um — use esse id nas ferramentas parse_image/parse_receipt/parse_boleto/transcribe_audio. Não baixa nem rebaixa mídia do WhatsApp. Apenas leitura, escopo tenant/agente/conversa.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: [],
  side_effect: 'read',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'conversation_attachment_looked_up',
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
        return {
          attachment_id: m.id,
          message_id: m.id,
          type: mapType(m.tipo, mime),
          media_mime: mime ?? undefined,
          created_at: m.created_at.toISOString(),
          caption: m.conteudo ?? undefined,
        };
      })
      .filter((a) => (args.attachment_type ? a.type === args.attachment_type : true))
      .filter((a) => {
        if (hints.length === 0) return true;
        // Hints match the caption or an attachment_id prefix — NEVER a
        // filesystem path or sha (no longer exposed).
        const caption = (a.caption ?? '').toLowerCase();
        const id = a.attachment_id.toLowerCase();
        return hints.some((h) => caption.includes(h) || id.startsWith(h));
      });

    if (attachments.length === 0) warnings.push('no_attachments_in_scope');

    return { attachments, count: attachments.length, warnings };
  },
};
