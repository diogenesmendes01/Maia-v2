import { createHash } from 'node:crypto';
import { decryptPollVote, type proto } from '@whiskeysockets/baileys';
import { logger } from '@/lib/logger.js';
import {
  mensagensRepo,
  conversasRepo,
  pessoasRepo,
  pendingQuestionsRepo,
} from '@/db/repositories.js';
import { audit } from '@/governance/audit.js';
import { resolveAndDispatch } from './pending-resolver.js';

const AFFIRMATIVE_REACTIONS = new Set(['✅', '👍']);
const NEGATIVE_REACTIONS = new Set(['❌', '👎']);

export async function dispatchReactionAsAnswer(msg: proto.IWebMessageInfo): Promise<void> {
  const reaction = msg.message?.reactionMessage;
  if (!reaction || !reaction.key?.id || !reaction.text) return;
  const emoji = reaction.text;
  const parent_wid = reaction.key.id;

  const parent = await mensagensRepo.findByWhatsappId(parent_wid);
  if (!parent) return; // unknown parent
  const meta = (parent.metadata ?? {}) as Record<string, unknown>;
  const pending_id = meta.pending_question_id;
  if (typeof pending_id !== 'string') {
    await audit({
      acao: 'one_tap_no_pending_anchor',
      metadata: { source: 'reaction', parent_wid },
    });
    return;
  }

  if (!AFFIRMATIVE_REACTIONS.has(emoji) && !NEGATIVE_REACTIONS.has(emoji)) {
    await audit({
      acao: 'reaction_ignored_unmapped_emoji',
      metadata: { emoji, pending_question_id: pending_id },
    });
    return;
  }

  if (!parent.conversa_id) return;
  const conversa = await conversasRepo.byId(parent.conversa_id);
  if (!conversa) return;
  const pessoa = await pessoasRepo.findById(conversa.pessoa_id);
  if (!pessoa) return;

  // Reactions only resolve binary pendings; 3+ use polls.
  const active = await pendingQuestionsRepo.findActiveSnapshot(conversa.id);
  if (!active) return;
  const opcoes = active.opcoes_validas as Array<{ key: string; label: string }>;
  if (!opcoes || opcoes.length !== 2) {
    logger.debug(
      { pending_question_id: active.id, opcoes_count: opcoes?.length },
      'one_tap.reaction_on_non_binary_skipped',
    );
    return;
  }

  const option_chosen = AFFIRMATIVE_REACTIONS.has(emoji) ? opcoes[0]!.key : opcoes[1]!.key;

  try {
    await resolveAndDispatch({
      pessoa,
      conversa,
      mensagem_id: parent.id,
      expected_pending_id: pending_id,
      option_chosen,
      confidence: 1,
      source: 'reaction',
    });
  } catch (err) {
    await audit({
      acao: 'one_tap_dispatch_error',
      metadata: { source: 'reaction', err: (err as Error).message },
    });
  }
}

export async function dispatchPollVote(msg: proto.IWebMessageInfo): Promise<void> {
  const pollUpdate = msg.message?.pollUpdateMessage;
  if (!pollUpdate?.pollCreationMessageKey?.id) return;
  const parent_wid = pollUpdate.pollCreationMessageKey.id;

  const parent = await mensagensRepo.findByWhatsappId(parent_wid);
  if (!parent) return;
  const meta = (parent.metadata ?? {}) as Record<string, unknown>;
  const pending_id = meta.pending_question_id;
  if (typeof pending_id !== 'string') {
    await audit({
      acao: 'one_tap_no_pending_anchor',
      metadata: { source: 'poll_vote', parent_wid },
    });
    return;
  }
  const opts = meta.poll_options as Array<{ key: string; label: string }> | undefined;
  const secretB64 = meta.poll_message_secret as string | undefined;
  if (!opts || !secretB64) {
    await audit({
      acao: 'one_tap_dispatch_error',
      metadata: { source: 'poll_vote', reason: 'missing_poll_metadata', parent_wid },
    });
    return;
  }

  let chosenKey: string | null = null;
  try {
    // Baileys v6.7.0 decryptPollVote signature (verified against
    // node_modules/@whiskeysockets/baileys/lib/Utils/messages-media.d.ts):
    //   decryptPollVote({ encPayload, encIv },
    //                   { pollCreatorJid, pollMsgId, pollEncKey, voterJid })
    const secret = Buffer.from(secretB64, 'base64');
    const decoded = decryptPollVote(
      {
        encPayload: pollUpdate.vote!.encPayload!,
        encIv: pollUpdate.vote!.encIv!,
      },
      {
        pollCreatorJid: msg.key.remoteJid ?? '',
        pollMsgId: parent_wid,
        pollEncKey: secret,
        voterJid: msg.key.participant ?? msg.key.remoteJid ?? '',
      },
    );
    const selected = (decoded as { selectedOptions?: Uint8Array[] }).selectedOptions ?? [];
    if (selected.length === 0) return;
    const target = Buffer.from(selected[0]!).toString('hex');
    for (const o of opts) {
      const labelHash = createHash('sha256').update(o.label).digest('hex');
      if (labelHash === target) {
        chosenKey = o.key;
        break;
      }
    }
  } catch (err) {
    await audit({
      acao: 'one_tap_dispatch_error',
      metadata: { source: 'poll_vote', reason: 'decrypt_failed', err: (err as Error).message },
    });
    return;
  }

  if (!chosenKey) {
    await audit({
      acao: 'one_tap_dispatch_error',
      metadata: { source: 'poll_vote', reason: 'no_label_match', pending_question_id: pending_id },
    });
    return;
  }

  if (!parent.conversa_id) return;
  const conversa = await conversasRepo.byId(parent.conversa_id);
  if (!conversa) return;
  const pessoa = await pessoasRepo.findById(conversa.pessoa_id);
  if (!pessoa) return;

  await resolveAndDispatch({
    pessoa,
    conversa,
    mensagem_id: parent.id,
    expected_pending_id: pending_id,
    option_chosen: chosenKey,
    confidence: 1,
    source: 'poll_vote',
  }).catch(async (err) => {
    await audit({
      acao: 'one_tap_dispatch_error',
      metadata: { source: 'poll_vote', err: (err as Error).message },
    });
  });
}
