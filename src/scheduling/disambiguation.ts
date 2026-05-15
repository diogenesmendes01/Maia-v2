/**
 * Spec 18 §7.4 — multi-pending disambiguation.
 *
 * Called by the agent core when a known destinatario sends an inbound
 * text and at least one `recurring_outreach` occurrence is awaiting that
 * destinatario's response.
 *
 * Resolution order:
 *   1. Token in the reply matches an active occurrence → route directly.
 *   2. No token, exactly one active occurrence → route there.
 *   3. No token, multiple active occurrences → enqueue a disambiguation
 *      pending_question to the owner; HOLD the inbound (do not route yet).
 *
 * In case 3 the destinatario's text stays in the database as a normal
 * inbound mensagem (the agent loop doesn't drop it), but the engine
 * doesn't advance any of the candidate occurrences until the owner
 * answers the disambiguation prompt. When the owner answers, the
 * pending-resolver path (or `confirmDisambiguation` here) feeds the
 * captured text into the chosen occurrence and advances it.
 */

import { eq } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { audit } from '@/governance/audit.js';
import { logger } from '@/lib/logger.js';
import {
  pessoasRepo,
  conversasRepo,
  pendingQuestionsRepo,
} from '@/db/repositories.js';
import { occurrencesRepo, tasksRepo, outboxRepo } from './repos.js';
import { extractCorrelationToken } from './correlation.js';
import { tasks as tasksTable } from '@/db/schema.js';
import type { Occurrence, Mensagem, Pessoa } from '@/db/schema.js';
import type { RecurringOutreachContexto } from './types.js';

export type CaptureResult =
  | { kind: 'routed'; occurrence_id: string }
  | { kind: 'disambiguation_requested'; pending_question_id: string }
  | { kind: 'no_match' };

/**
 * Try to attach an inbound text from `sender` to an awaiting outreach.
 */
export async function captureInboundForOutreach(input: {
  sender: Pessoa;
  inbound: Mensagem;
  owner_pessoa_id: string;
}): Promise<CaptureResult> {
  const { sender, inbound, owner_pessoa_id } = input;
  const text = inbound.conteudo ?? '';

  // 1. Token match.
  const token = extractCorrelationToken(text);
  if (token) {
    const occ = await occurrencesRepo.findActiveByCorrelation(token);
    if (occ) {
      const snap = occ.contexto_snapshot as RecurringOutreachContexto;
      if (snap.destinatario_pessoa_id === sender.id) {
        await attachResponse(occ, text, inbound.id);
        return { kind: 'routed', occurrence_id: occ.id };
      }
    }
    // Token in text but mismatched series — fall through (treat as no token).
    logger.info(
      { token, sender_id: sender.id, inbound_id: inbound.id },
      'outreach.token_mismatch',
    );
  }

  // 2. Single-candidate fallback.
  const candidates = await occurrencesRepo.listAwaitingForDestinatario(sender.id);
  if (candidates.length === 0) return { kind: 'no_match' };
  if (candidates.length === 1) {
    await attachResponse(candidates[0]!, text, inbound.id);
    return { kind: 'routed', occurrence_id: candidates[0]!.id };
  }

  // 3. Disambiguation prompt to the owner.
  const owner = await pessoasRepo.findById(owner_pessoa_id);
  if (!owner) {
    // No owner to ask — drop with audit (won't lose the inbound mensagem,
    // it's already persisted; just don't auto-route).
    await audit({
      acao: 'outreach_response_dropped_no_match',
      pessoa_id: sender.id,
      mensagem_id: inbound.id,
      metadata: { reason: 'owner_missing', candidates: candidates.map((c) => c.id) },
    });
    return { kind: 'no_match' };
  }
  const ownerConv = await conversasRepo.findActive(owner.id);
  if (!ownerConv) {
    await audit({
      acao: 'outreach_response_dropped_no_match',
      pessoa_id: sender.id,
      mensagem_id: inbound.id,
      metadata: { reason: 'owner_conv_missing', candidates: candidates.map((c) => c.id) },
    });
    return { kind: 'no_match' };
  }
  const opcoes = candidates.map((c, i) => ({
    key: String.fromCharCode(65 + i), // A, B, C ...
    label: shortLabel(c),
  }));
  const pergunta = `${sender.nome} respondeu, mas tenho ${candidates.length} pedidos abertos com ${sender.nome}. Qual deles? (${opcoes.map((o) => `${o.key}: ${o.label}`).join(' / ')})`;
  const pq = await pendingQuestionsRepo.create({
    conversa_id: ownerConv.id,
    pessoa_id: owner.id,
    tipo: 'outreach_disambiguation',
    pergunta,
    opcoes_validas: opcoes,
    acao_proposta: {
      kind: 'outreach_disambiguation',
      candidates: candidates.map((c, i) => ({
        key: String.fromCharCode(65 + i),
        occurrence_id: c.id,
      })),
      inbound_mensagem_id: inbound.id,
      response_text: text,
      destinatario_pessoa_id: sender.id,
    },
    expira_em: new Date(Date.now() + 6 * 3600_000),
    status: 'aberta',
    metadata: {
      kind: 'outreach_disambiguation',
      candidate_occurrence_ids: candidates.map((c) => c.id),
    },
  });
  await outboxRepo.enqueue({
    occurrence_id: null,
    task_id: null,
    kind: 'whatsapp_text',
    payload: { jid: jidFromPhone(owner.telefone_whatsapp), text: pergunta },
    dedup_key: `disambig:${pq.id}`,
  });
  await audit({
    acao: 'outreach_response_disambiguation_required',
    pessoa_id: sender.id,
    mensagem_id: inbound.id,
    metadata: { pending_question_id: pq.id, candidates: candidates.map((c) => c.id) },
  });
  return { kind: 'disambiguation_requested', pending_question_id: pq.id };
}

async function attachResponse(occ: Occurrence, text: string, inbound_mensagem_id: string): Promise<void> {
  const tasksList = await tasksRepo.byOccurrence(occ.id);
  const awaitTask = tasksList.find((t) => t.kind === 'await_response');
  if (awaitTask) {
    await tasksRepo.setStatus(awaitTask.id, 'completed', {
      response_text: text,
      inbound_mensagem_id,
    });
  }
  // Move occurrence from awaiting_third_party → in_progress so engine
  // executes the forward step on next tick.
  await occurrencesRepo.setStatus(occ.id, 'in_progress');
  await audit({
    acao: 'outreach_response_captured',
    alvo_id: occ.id,
    occurrence_id: occ.id,
    mensagem_id: inbound_mensagem_id,
    metadata: { response_chars: text.length },
  });
}

/** Called by pending-resolver when owner answers an outreach_disambiguation. */
export async function applyDisambiguationDecision(input: {
  pending_question_id: string;
  chosen_key: string;
  acao_proposta: {
    candidates: Array<{ key: string; occurrence_id: string }>;
    inbound_mensagem_id: string;
    response_text: string;
  };
}): Promise<{ routed_to: string | null }> {
  const chosen = input.acao_proposta.candidates.find((c) => c.key === input.chosen_key);
  if (!chosen) return { routed_to: null };
  const occ = await occurrencesRepo.byId(chosen.occurrence_id);
  if (!occ) return { routed_to: null };
  await attachResponse(occ, input.acao_proposta.response_text, input.acao_proposta.inbound_mensagem_id);
  return { routed_to: chosen.occurrence_id };
}

function jidFromPhone(tel: string): string {
  return tel.replace('+', '') + '@s.whatsapp.net';
}

function shortLabel(o: Occurrence): string {
  const snap = (o.contexto_snapshot as RecurringOutreachContexto | undefined) ?? null;
  if (snap?.message_template) {
    return snap.message_template.slice(0, 40).replace(/\s+/g, ' ');
  }
  return `agendado em ${o.scheduled_for.toISOString().slice(0, 10)}`;
}

// Re-export so the scheduling tick can also call attachResponse if needed.
export { attachResponse };
// Avoid unused import warnings on db/eq/tasksTable in builds where this
// module imports them but doesn't surface them (kept for future use in
// per-tx mutations).
void db;
void eq;
void tasksTable;
