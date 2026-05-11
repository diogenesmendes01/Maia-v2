import { stat } from 'node:fs/promises';
import { mensagensRepo, pessoasRepo, pendingQuestionsRepo } from '@/db/repositories.js';
import type { Pessoa, Conversa, Mensagem } from '@/db/schema.js';
import { audit } from '@/governance/audit.js';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { sendOutboundText, sendOutboundDocument, sendOutboundVoice } from '@/gateway/baileys.js';
import { synthesizeSpeech, OUTBOUND_VOICE_MAX_CHARS } from '@/lib/tts.js';
import { quotedReplyContext } from '@/gateway/presence.js';
import type { WAQuotedContext } from '@/gateway/presence.js';
import { detectCorrection } from './reflection.js';
import { cleanupPDF } from './pdf-cleanup.js';

/**
 * Returns the JID the outbound reply should target. Looks up the inbound
 * message's original `metadata.remote_jid` so that replies stay on whatever
 * thread (incl. `@lid` privacy IDs) the user contacted us through. Falls
 * back to building the JID from the pessoa's phone — the legacy behaviour
 * for cases where the inbound row is missing or doesn't have `remote_jid`.
 */
async function resolveOutboundJid(pessoa: Pessoa, in_reply_to: string): Promise<string> {
  try {
    const inbound = await mensagensRepo.findById(in_reply_to);
    const inboundRemoteJid = (inbound?.metadata as Record<string, unknown> | null)?.['remote_jid'];
    if (typeof inboundRemoteJid === 'string' && inboundRemoteJid.length > 0) {
      return inboundRemoteJid;
    }
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, in_reply_to },
      'outbound.jid_lookup_failed_falling_back',
    );
  }
  return pessoa.telefone_whatsapp.replace('+', '') + '@s.whatsapp.net';
}

export type LatestPending = {
  id: string;
  opcoes_validas: Array<{ key: string; label: string }>;
};

export type LatestReportPdf = {
  path: string;
  fileName: string;
  mimetype: string;
  tipo: 'extrato' | 'comparativo';
};

export type DispatchOutputCtx = {
  pessoa: Pessoa;
  conversa: Conversa;
  inbound: Mensagem;
  jid: string;
  text: string;
  latestPending: LatestPending | null;
  latestReportPdf: LatestReportPdf | null;
  turnHasSensitive: boolean;
  sensitiveTools: string[];
};

/**
 * Branches the outbound delivery into one of four modes (PDF / voice / text /
 * poll) preserving the exact precedence and side-effect ordering of the
 * original monolithic agent loop:
 *   1. If a `generate_report` ran in this turn → send as document with text
 *      as caption (truncated to 1024). Tmp file is unlinked in `finally`.
 *   2. Else if voice-in + voice-out feature is enabled and length fits and
 *      the turn isn't sensitive → send TTS voice; on TTS failure fall back
 *      to text.
 *   3. Else if a fresh pending question with 3-12 options exists and
 *      `FEATURE_ONE_TAP` is on → send as poll (with text fallback inside
 *      `sendOutboundPoll` when secrets are missing).
 *   4. Else → send plain text, applying view-once when sensitive tools were
 *      dispatched in this turn (unless the user disabled it).
 */
export async function dispatchOutput(ctx: DispatchOutputCtx): Promise<void> {
  const { pessoa, conversa: c, inbound, jid, text, latestPending, latestReportPdf, turnHasSensitive, sensitiveTools } = ctx;

  // Quoting decision is shared across PDF / voice / text branches —
  // computed once so the rule (correction-detected OR pending active)
  // can't drift between copies.
  // Pending check via canonical repo (post-B0). `||` short-circuits
  // on detected correction so the DB hit only happens when needed.
  const shouldQuote =
    (inbound.conteudo && detectCorrection(inbound.conteudo)) ||
    (await pendingQuestionsRepo.findActiveSnapshot(c.id)) !== null;
  const quotedContext = shouldQuote
    ? quotedReplyContext(
        inbound.metadata as Record<string, unknown> | null,
        inbound.conteudo,
      )
    : undefined;

  // B3b: PDF report path — takes precedence over poll/text. The LLM's
  // text becomes the document caption (truncated to WhatsApp's 1024-
  // char limit). The unlink-in-finally guarantees the tmp PDF is
  // removed even when send fails; boot sweeper is the safety net for
  // crash-mid-send.
  if (latestReportPdf) {
    const pdf = latestReportPdf;
    try {
      const captionText = text.slice(0, 1024);
      const wid = await sendOutboundDocument(jid, pdf.path, {
        mimetype: pdf.mimetype,
        fileName: pdf.fileName,
        caption: captionText,
        quoted: quotedContext,
      });
      if (wid) {
        const file_size_bytes = await stat(pdf.path)
          .then((s) => s.size)
          .catch((err) => {
            logger.warn(
              { err, path: pdf.path },
              'pdf.stat_failed_audit_size_zero',
            );
            return 0;
          });
        await audit({
          acao: 'outbound_sent_document',
          pessoa_id: pessoa.id,
          conversa_id: c.id,
          mensagem_id: inbound.id,
          metadata: {
            whatsapp_id: wid,
            tipo: pdf.tipo,
            file_size_bytes,
          },
        });
        await mensagensRepo.create({
          conversa_id: c.id,
          direcao: 'out',
          tipo: 'documento',
          conteudo: captionText,
          midia_url: null,
          metadata: {
            whatsapp_id: wid,
            in_reply_to: inbound.id,
            document_tipo: pdf.tipo,
            document_filename: pdf.fileName,
          },
          processada_em: new Date(),
          ferramentas_chamadas: [],
          tokens_usados: null,
        });
      }
    } finally {
      await cleanupPDF(pdf.path);
    }
    return;
  }

  if (
    config.FEATURE_OUTBOUND_VOICE &&
    inbound.tipo === 'audio' &&
    text.length <= OUTBOUND_VOICE_MAX_CHARS &&
    !(config.FEATURE_VIEW_ONCE_SENSITIVE && turnHasSensitive)
  ) {
    // B4: voice reply for symmetric voice-in/voice-out channel.
    // Sensitive turns (query_balance / compare_entities) are excluded
    // from the voice branch so the B3a view-once path (and its
    // skipped-by-preference audit) keeps protecting saldos. Voice
    // bubbles can't be view-once, so going text-first is the only way
    // to honour the sensitive-turn contract from B3a.
    let voiceBuf: Buffer | null = null;
    try {
      voiceBuf = await synthesizeSpeech(text);
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, mensagem_id: inbound.id },
        'b4.tts_failed_fallback_text',
      );
    }
    if (voiceBuf) {
      const wid = await sendOutboundVoice(jid, voiceBuf, {
        quoted: quotedContext,
      });
      if (wid) {
        await audit({
          acao: 'outbound_sent_voice',
          pessoa_id: pessoa.id,
          conversa_id: c.id,
          mensagem_id: inbound.id,
          metadata: {
            whatsapp_id: wid,
            char_count: text.length,
            byte_size: voiceBuf.length,
          },
        });
        await mensagensRepo.create({
          conversa_id: c.id,
          direcao: 'out',
          tipo: 'audio',
          conteudo: text,
          midia_url: null,
          metadata: {
            whatsapp_id: wid,
            remote_jid: jid,
            in_reply_to: inbound.id,
            voice: 'nova',
          },
          processada_em: new Date(),
          ferramentas_chamadas: [],
          tokens_usados: null,
        });
      }
    } else {
      // TTS failed — fall back to text path (re-uses existing sendOutbound).
      await sendOutbound(pessoa.id, c.id, text, inbound.id, {
        pending_question_id: latestPending?.id ?? null,
        quoted: quotedContext,
      });
    }
    return;
  }

  const usePoll =
    latestPending &&
    config.FEATURE_ONE_TAP &&
    latestPending.opcoes_validas.length >= 3 &&
    latestPending.opcoes_validas.length <= 12;
  if (usePoll && latestPending) {
    await sendOutboundPoll(pessoa.id, c.id, text, inbound.id, latestPending);
    return;
  }

  const prefDisabled =
    (pessoa.preferencias as { balance_view_once?: boolean } | null)
      ?.balance_view_once === false;
  const view_once =
    config.FEATURE_VIEW_ONCE_SENSITIVE && turnHasSensitive && !prefDisabled;
  if (config.FEATURE_VIEW_ONCE_SENSITIVE && turnHasSensitive && prefDisabled) {
    await audit({
      acao: 'outbound_view_once_skipped_by_preference',
      pessoa_id: pessoa.id,
      conversa_id: c.id,
      mensagem_id: inbound.id,
      metadata: { sensitive_tools: sensitiveTools },
    });
  }
  const wid = await sendOutbound(pessoa.id, c.id, text, inbound.id, {
    pending_question_id: latestPending?.id ?? null,
    quoted: quotedContext,
    view_once,
  });
  if (wid && view_once) {
    await audit({
      acao: 'outbound_sent_view_once',
      pessoa_id: pessoa.id,
      conversa_id: c.id,
      mensagem_id: inbound.id,
      metadata: { whatsapp_id: wid, sensitive_tools: sensitiveTools },
    });
  }
}

export async function sendOutbound(
  pessoa_id: string,
  conversa_id: string,
  text: string,
  in_reply_to: string,
  opts?: {
    pending_question_id?: string | null;
    quoted?: WAQuotedContext;
    view_once?: boolean;
  },
): Promise<string | null> {
  const pessoa = await pessoasRepo.findById(pessoa_id);
  if (!pessoa) return null;
  // Reply to whatever JID the inbound used (handles `@lid` privacy IDs that
  // wouldn't survive the round-trip through `phone + @s.whatsapp.net`).
  // Falls back to the phone-derived JID for non-reply outbounds.
  const jid = await resolveOutboundJid(pessoa, in_reply_to);
  const sendOpts: { quoted?: WAQuotedContext; view_once?: boolean } = {};
  if (opts?.quoted) sendOpts.quoted = opts.quoted;
  if (opts?.view_once) sendOpts.view_once = true;
  const wid = await sendOutboundText(
    jid,
    text,
    Object.keys(sendOpts).length ? sendOpts : undefined,
  );
  const metadata: Record<string, unknown> = { whatsapp_id: wid, remote_jid: jid, in_reply_to };
  if (opts?.pending_question_id) metadata.pending_question_id = opts.pending_question_id;
  if (opts?.view_once) metadata.view_once = true;
  await mensagensRepo.create({
    conversa_id,
    direcao: 'out',
    tipo: 'texto',
    conteudo: text,
    midia_url: null,
    metadata,
    processada_em: new Date(),
    ferramentas_chamadas: [],
    tokens_usados: null,
  });
  return wid;
}

export async function sendOutboundPoll(
  pessoa_id: string,
  conversa_id: string,
  text: string,
  in_reply_to: string,
  pending: { id: string; opcoes_validas: Array<{ key: string; label: string }> },
): Promise<{ fell_back: boolean }> {
  const pessoa = await pessoasRepo.findById(pessoa_id);
  if (!pessoa) return { fell_back: false };
  const jid = await resolveOutboundJid(pessoa, in_reply_to);
  const { sendPoll } = await import('@/gateway/presence.js');
  const sent = await sendPoll(jid, text, pending.opcoes_validas);
  // Without all three (whatsapp_id, message_secret, creator_jid) the inbound
  // vote can't be decrypted (creator_jid feeds the HMAC in decryptPollVote),
  // so the user would see a poll they can't actually answer. Fall back.
  if (!sent.whatsapp_id || !sent.message_secret || !sent.creator_jid) {
    const numbered = pending.opcoes_validas.map((o, i) => `${i + 1}. ${o.label}`).join('\n');
    await sendOutbound(pessoa_id, conversa_id, `${text}\n\n${numbered}`, in_reply_to, {
      pending_question_id: pending.id,
    });
    return { fell_back: true };
  }
  await mensagensRepo.create({
    conversa_id,
    direcao: 'out',
    tipo: 'texto',
    conteudo: text,
    midia_url: null,
    metadata: {
      whatsapp_id: sent.whatsapp_id,
      remote_jid: jid,
      in_reply_to,
      pending_question_id: pending.id,
      poll_options: pending.opcoes_validas,
      poll_message_secret: sent.message_secret,
      poll_creator_jid: sent.creator_jid,
    },
    processada_em: new Date(),
    ferramentas_chamadas: [],
    tokens_usados: null,
  });
  return { fell_back: false };
}
