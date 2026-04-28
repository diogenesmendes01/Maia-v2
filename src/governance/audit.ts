import { auditRepo } from '@/db/repositories.js';
import type { AuditAction } from './audit-actions.js';
import { logger } from '@/lib/logger.js';

export async function audit(input: {
  acao: AuditAction;
  pessoa_id?: string | null;
  entidade_alvo?: string | null;
  alvo_id?: string | null;
  conversa_id?: string | null;
  mensagem_id?: string | null;
  diff?: { before?: unknown; after?: unknown } | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await auditRepo.write({
      acao: input.acao,
      pessoa_id: input.pessoa_id ?? null,
      entidade_alvo: input.entidade_alvo ?? null,
      alvo_id: input.alvo_id ?? null,
      conversa_id: input.conversa_id ?? null,
      mensagem_id: input.mensagem_id ?? null,
      diff: (input.diff ?? null) as object | null,
      metadata: input.metadata ?? {},
    });
  } catch (err) {
    logger.error({ err, acao: input.acao }, 'audit.write_failed');
  }
}
