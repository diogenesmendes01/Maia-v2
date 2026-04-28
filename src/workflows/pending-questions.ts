import { z } from 'zod';
import { config } from '@/config/env.js';
import { conversasRepo, pendingQuestionsRepo } from '@/db/repositories.js';
import type { Conversa } from '@/db/schema.js';
import { audit } from '@/governance/audit.js';

export type PendingQuestionData = {
  id: string;
  pergunta: string;
  acao_proposta?: { tool: string; args: Record<string, unknown> };
  opcoes_validas: Array<{ key: string; label: string }>;
  expira_em: string;
  created_at: string;
};

export const IntentResolutionSchema = z.object({
  resolves_pending: z.boolean(),
  option_chosen: z.string().optional(),
  confidence: z.number().min(0).max(1),
  reason: z.string().optional(),
  is_topic_change: z.boolean().optional(),
  is_cancellation: z.boolean().optional(),
});

export type IntentResolution = z.infer<typeof IntentResolutionSchema>;

export async function setLightweightPending(
  conversa: Conversa,
  data: Omit<PendingQuestionData, 'id' | 'created_at' | 'expira_em'>,
): Promise<PendingQuestionData> {
  const id = 'PQ-' + Math.random().toString(36).slice(2, 8);
  const expira_em = new Date(
    Date.now() + config.PENDING_QUESTION_TTL_MINUTES * 60 * 1000,
  ).toISOString();
  const full: PendingQuestionData = {
    id,
    pergunta: data.pergunta,
    acao_proposta: data.acao_proposta,
    opcoes_validas: data.opcoes_validas,
    expira_em,
    created_at: new Date().toISOString(),
  };
  const meta = (conversa.metadata ?? {}) as Record<string, unknown>;
  meta.pending_question = full;
  await conversasRepo.updateMetadata(conversa.id, meta);
  return full;
}

export function getActivePending(conversa: Conversa): PendingQuestionData | null {
  const meta = (conversa.metadata ?? {}) as Record<string, unknown>;
  const pq = meta.pending_question as PendingQuestionData | null | undefined;
  if (!pq) return null;
  if (new Date(pq.expira_em) <= new Date()) return null;
  return pq;
}

export async function clearLightweightPending(conversa: Conversa): Promise<void> {
  const meta = (conversa.metadata ?? {}) as Record<string, unknown>;
  delete meta.pending_question;
  await conversasRepo.updateMetadata(conversa.id, meta);
}

export async function applyResolution(
  conversa: Conversa,
  resolution: IntentResolution,
): Promise<{ resolved: boolean; action?: { tool: string; args: Record<string, unknown> } }> {
  const pq = getActivePending(conversa);
  if (!pq) return { resolved: false };

  if (resolution.is_cancellation) {
    await clearLightweightPending(conversa);
    await audit({
      acao: 'pending_cancelled',
      conversa_id: conversa.id,
      metadata: { pq_id: pq.id },
    });
    return { resolved: true };
  }

  if (
    resolution.resolves_pending &&
    resolution.confidence >= 0.7 &&
    resolution.option_chosen &&
    pq.opcoes_validas.some((o) => o.key === resolution.option_chosen)
  ) {
    await clearLightweightPending(conversa);
    await audit({
      acao: 'pending_resolved',
      conversa_id: conversa.id,
      metadata: { pq_id: pq.id, option: resolution.option_chosen },
    });
    if (pq.acao_proposta) {
      const args = { ...pq.acao_proposta.args, _pending_choice: resolution.option_chosen };
      return { resolved: true, action: { tool: pq.acao_proposta.tool, args } };
    }
    return { resolved: true };
  }
  return { resolved: false };
}

export async function expireAll(): Promise<{ table: number; conversas: number }> {
  const tableExpired = await pendingQuestionsRepo.expireDue();

  // Conversas with stale pending_question in metadata
  // (best-effort: a real implementation would scan by JSON path)
  return { table: tableExpired, conversas: 0 };
}
