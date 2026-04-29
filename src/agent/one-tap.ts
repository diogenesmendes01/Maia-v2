import type { proto } from '@whiskeysockets/baileys';
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
