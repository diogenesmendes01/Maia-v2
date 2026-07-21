/**
 * P0 security audit — chapter 4 (attachment IDs + media protection).
 *
 * Resolves the OPAQUE attachment handle the tools now accept
 * (`attachment_id` = `mensagens.id`, a uuid) back to the gateway-stored media
 * row. The LLM never sees or supplies a filesystem path or a sha again —
 * it references media by row id, and the backend decides what that id maps to.
 *
 * Scope guarantees (fail-closed on every miss):
 *   - `mensagensRepo.findById` is ALS tenant/agent-scoped (see
 *     src/db/repositories/conversation-repos.ts) — a cross-tenant id resolves
 *     to null.
 *   - The row must belong to the CALLER'S conversation (`conversa_id` must
 *     equal the ctx conversation) — a cross-conversation id resolves to null.
 *   - The row must actually carry media (`midia_url` present).
 *
 * NOTE: `metadata.media_sha256` is deliberately NOT returned/trusted here —
 * the consumer (src/lib/media-guard.ts) recomputes the sha from the bytes it
 * reads, so a poisoned metadata row cannot poison caches or idempotency keys.
 */
import { mensagensRepo } from '@/db/repositories.js';

export type ResolvedAttachment = {
  /** The mensagens row id (== the attachment_id that resolved). */
  message_id: string;
  /** Local path stored by the gateway (validated downstream by media-guard). */
  path: string;
  /** Declared mime from ingest metadata — informational only; consumers use the SNIFFED mime. */
  mime: string | null;
  /** Gateway message tipo: 'imagem' | 'audio' | 'documento' | … */
  tipo: string;
  caption: string | null;
};

export async function resolveAttachmentById(
  conversaId: string,
  attachmentId: string,
): Promise<ResolvedAttachment | null> {
  if (!conversaId) return null;
  const row = await mensagensRepo.findById(attachmentId);
  if (!row) return null;
  if (row.conversa_id !== conversaId) return null;
  if (!row.midia_url) return null;
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  return {
    message_id: row.id,
    path: row.midia_url,
    mime: typeof meta.media_mime === 'string' ? meta.media_mime : null,
    tipo: row.tipo,
    caption: row.conteudo ?? null,
  };
}
