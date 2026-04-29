import type { proto } from '@whiskeysockets/baileys';
import { logger } from '@/lib/logger.js';
import {
  mensagensRepo,
  auditRepo,
  pessoasRepo,
  conversasRepo,
  pendingQuestionsRepo,
} from '@/db/repositories.js';
import { withTx } from '@/db/client.js';
import { audit } from '@/governance/audit.js';
import { config } from '@/config/env.js';

const SIDE_EFFECT_ACTIONS = new Set([
  'transaction_created',
  'transaction_corrected',
  'transaction_cancelled',
  'pending_action_dispatched',
]);

const REVIEW_TTL_HOURS = 24;

/**
 * Single entry point for Baileys `messages.update` events. Unwraps the
 * envelope and dispatches:
 *   - editedMessage         → handleMessageEdit
 *   - protocolMessage type=0 → handleMessageRevoke (REVOKE)
 *   - anything else (read receipts, status updates) → ignored
 */
export async function routeMessageUpdate(update: proto.IWebMessageInfo): Promise<void> {
  if (!update.key?.id) return;
  const m = update.message;
  if (!m) return;

  const edited = m.editedMessage?.message;
  if (edited) {
    const new_conteudo = edited.conversation ?? edited.extendedTextMessage?.text ?? null;
    if (typeof new_conteudo === 'string') {
      await handleMessageEdit({ whatsapp_id: update.key.id, new_conteudo });
    }
    return;
  }

  const proto_msg = m.protocolMessage;
  if (proto_msg && proto_msg.type === 0 && proto_msg.key?.id) {
    await handleMessageRevoke({
      whatsapp_id: proto_msg.key.id,
      revoked_by_jid: update.key.remoteJid ?? '',
    });
    return;
  }
}

async function handleMessageEdit(input: {
  whatsapp_id: string;
  new_conteudo: string;
}): Promise<void> {
  const original = await mensagensRepo.findByWhatsappId(input.whatsapp_id);
  if (!original) {
    logger.debug({ whatsapp_id: input.whatsapp_id }, 'message_update.edit_unknown_original');
    return;
  }
  const sideEffects = await detectSideEffects(original.id);
  if (sideEffects.length === 0) {
    await audit({
      acao: 'mensagem_edited',
      mensagem_id: original.id,
      diff: { before: original.conteudo ?? null, after: input.new_conteudo },
    });
    return;
  }
  await audit({
    acao: 'mensagem_edited_after_side_effect',
    mensagem_id: original.id,
    diff: { before: original.conteudo ?? null, after: input.new_conteudo },
    metadata: { side_effect_count: sideEffects.length },
  });
  if (config.FEATURE_MESSAGE_UPDATE) {
    await createEditReviewPending({
      original,
      side_effects: sideEffects,
      source: 'edit',
      diff: { before: original.conteudo ?? null, after: input.new_conteudo },
    });
  }
}

async function handleMessageRevoke(input: {
  whatsapp_id: string;
  revoked_by_jid: string;
}): Promise<void> {
  const original = await mensagensRepo.findByWhatsappId(input.whatsapp_id);
  if (!original) {
    logger.debug({ whatsapp_id: input.whatsapp_id }, 'message_update.revoke_unknown_original');
    return;
  }
  const sideEffects = await detectSideEffects(original.id);
  if (sideEffects.length === 0) {
    await audit({
      acao: 'mensagem_revoked',
      mensagem_id: original.id,
      metadata: { revoked_by_jid: input.revoked_by_jid },
    });
    return;
  }
  await audit({
    acao: 'mensagem_revoked_after_side_effect',
    mensagem_id: original.id,
    metadata: { side_effect_count: sideEffects.length, revoked_by_jid: input.revoked_by_jid },
  });
  if (config.FEATURE_MESSAGE_UPDATE) {
    await createEditReviewPending({
      original,
      side_effects: sideEffects,
      source: 'revoke',
    });
  }
}

async function detectSideEffects(
  mensagem_id: string,
): Promise<Array<{ acao: string; alvo_id: string | null }>> {
  const rows = await auditRepo.findByMensagemId(mensagem_id);
  return rows
    .filter((r) => SIDE_EFFECT_ACTIONS.has(r.acao))
    .map((r) => ({ acao: r.acao, alvo_id: r.alvo_id }));
}

async function createEditReviewPending(input: {
  original: { id: string; conversa_id: string | null };
  side_effects: Array<{ acao: string; alvo_id: string | null }>;
  source: 'edit' | 'revoke';
  diff?: { before: string | null; after: string };
}): Promise<void> {
  const tx_audit = input.side_effects.find((e) =>
    ['transaction_created', 'transaction_corrected'].includes(e.acao),
  );
  if (!tx_audit?.alvo_id) return;

  const owner = await pessoasRepo.findByPhone(config.OWNER_TELEFONE_WHATSAPP);
  if (!owner) {
    logger.warn('message_update.no_owner_skipping_review');
    return;
  }
  const ownerConversa = await conversasRepo.findActive(owner.id);
  if (!ownerConversa) {
    logger.warn({ owner_id: owner.id }, 'message_update.no_owner_conversa_skipping_review');
    return;
  }

  const verb = input.source === 'edit' ? 'editou' : 'deletou';
  const expira_em = new Date(Date.now() + REVIEW_TTL_HOURS * 60 * 60 * 1000);

  await withTx(async (tx) => {
    const cancelled = await pendingQuestionsRepo.cancelOpenForConversaTx(
      tx,
      ownerConversa.id,
      'replaced_by_edit_review',
    );
    if (cancelled.cancelled_ids.length > 0) {
      await audit({
        acao: 'pending_substituted_by_edit_review',
        conversa_id: ownerConversa.id,
        mensagem_id: input.original.id,
        metadata: { cancelled_ids: cancelled.cancelled_ids },
      });
    }
    await pendingQuestionsRepo.createTx(tx, {
      conversa_id: ownerConversa.id,
      pessoa_id: owner.id,
      tipo: 'edit_review',
      pergunta: `Você ${verb} uma mensagem que virou transação. Quer cancelar?`,
      opcoes_validas: [
        { key: 'sim', label: 'Sim, cancela' },
        { key: 'nao', label: 'Não, mantém' },
      ],
      acao_proposta: {
        tool: 'cancel_transaction',
        args: {
          transacao_id: tx_audit.alvo_id,
          motivo: input.source === 'edit' ? 'edit_review' : 'revoke_review',
        },
      },
      expira_em,
      status: 'aberta',
      metadata: {
        source: 'edit_review',
        original_mensagem_id: input.original.id,
        original_conversa_id: input.original.conversa_id,
        original_diff: input.diff ?? null,
      },
    });
  });
}

