import { mensagensRepo, conversasRepo, pessoasRepo, pendingQuestionsRepo } from '@/db/repositories.js';
import { resolveScope } from '@/governance/permissions.js';
import { checkPendingFirst } from '@/agent/pending-gate.js';
import { checkRateLimit, formatPoliteReply } from '@/gateway/rate-limit.js';
import { resolveIdentity } from '@/identity/resolver.js';
import { handleQuarantineFirstContact, handleOwnerIdentityReply } from '@/identity/quarantine.js';
import { config } from '@/config/env.js';
import { buildPrompt } from './prompt-builder.js';
import { callLLM, type LLMMessage } from '@/lib/claude.js';
import { logger } from '@/lib/logger.js';
import { sendOutboundText, sendOutboundDocument, sendOutboundVoice } from '@/gateway/baileys.js';
import { synthesizeSpeech, OUTBOUND_VOICE_MAX_CHARS } from '@/lib/tts.js';
import { audit } from '@/governance/audit.js';
import { dispatchTool } from '@/tools/_dispatcher.js';
import { getToolSchemas, REGISTRY } from '@/tools/_registry.js';
import { startTyping, sendReaction, quotedReplyContext } from '@/gateway/presence.js';
import { getActivePending } from '@/workflows/pending-questions.js';
import { uuid } from '@/lib/utils.js';
import {
  detectCorrection,
  reflectOnCorrection,
  findPreviousAssistantMessage,
} from './reflection.js';
import { stat, unlink } from 'node:fs/promises';

const MAX_REACT_ITERATIONS = 5;
const TYPING_DEBOUNCE_MS = 1500;

/**
 * Returns a stopper. The stopper either cancels the pending start (if called
 * within TYPING_DEBOUNCE_MS) or calls handle.stop() (if typing already started).
 */
function scheduleTypingDebounce(jid: string, mensagem_id: string): () => void {
  let handle: ReturnType<typeof startTyping> | null = null;
  const timer = setTimeout(() => {
    handle = startTyping(jid, mensagem_id);
  }, TYPING_DEBOUNCE_MS);
  return () => {
    clearTimeout(timer);
    handle?.stop();
  };
}

export const _internal = { scheduleTypingDebounce, sendOutbound };

export async function runAgentForMensagem(mensagem_id: string): Promise<void> {
  const inbound = await mensagensRepo.findById(mensagem_id);
  if (!inbound) {
    logger.warn({ mensagem_id }, 'agent.message_not_found');
    return;
  }
  if (inbound.processada_em) {
    logger.debug({ mensagem_id }, 'agent.already_processed');
    return;
  }
  if (!inbound.conversa_id) {
    const tel = (inbound.metadata as Record<string, unknown>)?.['telefone'] as string | undefined;
    if (!tel) return;
    const resolved = await resolveIdentity({ telefone_whatsapp: tel });
    if (resolved.kind === 'unknown') {
      // Mark processed so the recovery worker doesn't requeue forever.
      await mensagensRepo.markProcessed(inbound.id, 0);
      return;
    }
    if (resolved.kind === 'blocked') {
      logger.info({ pessoa_id: resolved.pessoa.id, reason: resolved.reason }, 'agent.blocked_drop');
      await mensagensRepo.markProcessed(inbound.id, 0);
      return;
    }
    if (resolved.kind === 'quarantined') {
      await handleQuarantineFirstContact({ pessoa: resolved.pessoa, inbound });
      await mensagensRepo.markProcessed(inbound.id, 0);
      return;
    }
    // Owner reply on a pending identity_confirmation? handled before the LLM
    // ever sees the message — deterministic confirmation flow per spec 05 §6.
    if (
      resolved.pessoa.telefone_whatsapp === config.OWNER_TELEFONE_WHATSAPP &&
      typeof inbound.conteudo === 'string'
    ) {
      const consumed = await handleOwnerIdentityReply({
        ownerPessoa: resolved.pessoa,
        reply: inbound.conteudo,
      });
      if (consumed) {
        await mensagensRepo.setConversaId(inbound.id, resolved.conversa.id);
        await mensagensRepo.markProcessed(inbound.id, 0);
        return;
      }
    }
    await mensagensRepo.setConversaId(inbound.id, resolved.conversa.id);
    inbound.conversa_id = resolved.conversa.id;
  }

  const conv = await loadConversaWithPessoa(inbound.conversa_id!);
  if (!conv) {
    logger.warn({ mensagem_id }, 'agent.conversa_missing');
    return;
  }
  const { conversa: c, pessoa } = conv;

  // Spec 03 §9 — sliding-hour rate limit. Owners exempt; others get one
  // polite reply per hour, then 60s of silence after each warning.
  const decision = await checkRateLimit(pessoa);
  if (decision.kind !== 'allow') {
    if (decision.kind === 'warn') {
      await audit({
        acao: 'rate_limit_exceeded',
        pessoa_id: pessoa.id,
        conversa_id: c.id,
        mensagem_id: inbound.id,
        metadata: { count: decision.count, threshold: decision.threshold },
      });
      const reply = formatPoliteReply(decision.threshold);
      await sendOutbound(pessoa.id, c.id, reply, inbound.id).catch((err) =>
        logger.warn({ err: (err as Error).message }, 'agent.rate_limit_reply_failed'),
      );
    }
    await mensagensRepo.markProcessed(inbound.id, 0);
    await conversasRepo.touch(c.id);
    return;
  }

  // B0: pre-LLM gate. If the user's reply resolves a pending question,
  // the gate (via resolveAndDispatch) has already executed the proposed
  // action and audited it; we just close the loop and skip the ReAct turn.
  const gate = await checkPendingFirst({ pessoa, conversa: c, inbound });
  if (gate.kind === 'resolved') {
    await mensagensRepo.markProcessed(inbound.id, 0);
    await conversasRepo.touch(c.id);
    return;
  }
  // 'unresolved' and 'no_pending' fall through to the existing ReAct flow.

  const scope = await resolveScope(pessoa);

  const { system, messages } = await buildPrompt({
    pessoa,
    conversa: c,
    scope,
    inbound,
  });

  const tools = getToolSchemas(scope.byEntity);
  let totalTokens = 0;
  const conversation: LLMMessage[] = messages;
  let latestPending: {
    id: string;
    opcoes_validas: Array<{ key: string; label: string }>;
  } | null = null;
  let turnHasSensitive = false;
  const sensitiveTools: string[] = [];
  let latestReportPdf: {
    path: string;
    fileName: string;
    mimetype: string;
    tipo: 'extrato' | 'comparativo';
  } | null = null;

  const jid = pessoa.telefone_whatsapp.replace('+', '') + '@s.whatsapp.net';
  const stopTyping = scheduleTypingDebounce(jid, inbound.id);
  try {
    for (let i = 0; i < MAX_REACT_ITERATIONS; i++) {
      const res = await callLLM({ system, messages: conversation, tools, max_tokens: 1024 });
      totalTokens += res.usage.input_tokens + res.usage.output_tokens;

      if (res.tool_uses.length === 0) {
        const text = res.content?.trim() ?? '';
        if (text) {
          // B3b: PDF report path — takes precedence over poll/text. The LLM's
          // text becomes the document caption (truncated to WhatsApp's 1024-
          // char limit). The unlink-in-finally guarantees the tmp PDF is
          // removed even when send fails; boot sweeper is the safety net for
          // crash-mid-send.
          if (latestReportPdf) {
            const pdf = latestReportPdf;
            try {
              const captionText = text.slice(0, 1024);
              const shouldQuote =
                (inbound.conteudo && detectCorrection(inbound.conteudo)) ||
                getActivePending(c) !== null;
              const wid = await sendOutboundDocument(jid, pdf.path, {
                mimetype: pdf.mimetype,
                fileName: pdf.fileName,
                caption: captionText,
                quoted: shouldQuote
                  ? quotedReplyContext(
                      inbound.metadata as Record<string, unknown> | null,
                      inbound.conteudo,
                    )
                  : undefined,
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
              await unlink(pdf.path).catch((err) => {
                logger.warn({ err, path: pdf.path }, 'pdf.unlink_failed_will_be_swept');
              });
            }
          } else if (
            config.FEATURE_OUTBOUND_VOICE &&
            inbound.tipo === 'audio' &&
            text.length <= OUTBOUND_VOICE_MAX_CHARS
          ) {
            // B4: voice reply for symmetric voice-in/voice-out channel.
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
              const shouldQuote =
                (inbound.conteudo && detectCorrection(inbound.conteudo)) ||
                getActivePending(c) !== null;
              const wid = await sendOutboundVoice(jid, voiceBuf, {
                quoted: shouldQuote
                  ? quotedReplyContext(
                      inbound.metadata as Record<string, unknown> | null,
                      inbound.conteudo,
                    )
                  : undefined,
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
              const shouldQuote =
                (inbound.conteudo && detectCorrection(inbound.conteudo)) ||
                getActivePending(c) !== null;
              await sendOutbound(pessoa.id, c.id, text, inbound.id, {
                pending_question_id: latestPending?.id ?? null,
                quoted: shouldQuote
                  ? quotedReplyContext(
                      inbound.metadata as Record<string, unknown> | null,
                      inbound.conteudo,
                    )
                  : undefined,
              });
            }
          } else {
            const usePoll =
              latestPending &&
              config.FEATURE_ONE_TAP &&
              latestPending.opcoes_validas.length >= 3 &&
              latestPending.opcoes_validas.length <= 12;
            if (usePoll && latestPending) {
              await sendOutboundPoll(pessoa.id, c.id, text, inbound.id, latestPending);
            } else {
              const shouldQuote =
                (inbound.conteudo && detectCorrection(inbound.conteudo)) ||
                getActivePending(c) !== null;
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
                quoted: shouldQuote
                  ? quotedReplyContext(
                      inbound.metadata as Record<string, unknown> | null,
                      inbound.conteudo,
                    )
                  : undefined,
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
          }
        }
        break;
      }

      // Append assistant turn with tool uses
      conversation.push({
        role: 'assistant',
        content: res.tool_uses.map((tu) => ({
          type: 'tool_use' as const,
          id: tu.id,
          name: tu.tool,
          input: tu.args,
        })),
      });

      // Execute tools and add results
      const results = [];
      for (const tu of res.tool_uses) {
        const out = await dispatchTool({
          tool: tu.tool,
          args: tu.args,
          ctx: {
            pessoa,
            scope,
            conversa: c,
            mensagem_id: inbound.id,
            request_id: uuid(),
          },
        });
        const isError = typeof out === 'object' && out !== null && 'error' in out;

        // B0: capture the freshly-created pending id, with re-validation against
        // the dispatcher's 5-min idempotency cache.
        if (
          tu.tool === 'ask_pending_question' &&
          typeof out === 'object' &&
          out !== null &&
          'pending_question_id' in out &&
          typeof (out as { pending_question_id: string }).pending_question_id === 'string'
        ) {
          const candidate = out as {
            pending_question_id: string;
            opcoes_validas: Array<{ key: string; label: string }>;
          };
          // Re-validate that the candidate is still 'aberta'. Defends against
          // dispatcher-cache returning a stale id from a prior retry within the
          // 5-min idempotency bucket.
          const stillActive = await pendingQuestionsRepo
            .findActiveSnapshot(c.id)
            .catch(() => null);
          if (stillActive && stillActive.id === candidate.pending_question_id) {
            latestPending = {
              id: candidate.pending_question_id,
              opcoes_validas: candidate.opcoes_validas,
            };
          } else {
            logger.warn(
              { tool: tu.tool, candidate: candidate.pending_question_id, conversa_id: c.id },
              'agent.stale_pending_id_dropped',
            );
          }
        }

        // Sub-A: silent ack via reaction on side-effect tool outcomes.
        const tool = REGISTRY[tu.tool];
        // B3a: track sensitive tools dispatched in this turn. The dedup guard
        // (`!sensitiveTools.includes`) keeps the audit's `sensitive_tools`
        // list as a unique set even when the LLM dispatches the same tool
        // multiple times (e.g., balance for two entidade_ids).
        if (tool?.sensitive && !sensitiveTools.includes(tu.tool)) {
          turnHasSensitive = true;
          sensitiveTools.push(tu.tool);
        }

        // B3b: capture PDF report result for outbound document send.
        if (
          tu.tool === 'generate_report' &&
          !isError &&
          typeof out === 'object' &&
          out !== null &&
          'path' in out &&
          'fileName' in out &&
          'mimetype' in out &&
          'tipo' in out
        ) {
          const r = out as {
            path: string;
            fileName: string;
            mimetype: string;
            tipo: 'extrato' | 'comparativo';
          };
          latestReportPdf = {
            path: r.path,
            fileName: r.fileName,
            mimetype: r.mimetype,
            tipo: r.tipo,
          };
        }
        const isSideEffect =
          tool && (tool.side_effect === 'write' || tool.side_effect === 'communication');
        if (isSideEffect) {
          const wid = (inbound.metadata as Record<string, unknown> | null)?.['whatsapp_id'];
          if (typeof wid === 'string') {
            if (!isError) {
              sendReaction(jid, wid, '✅');
            } else {
              const errKind = (out as { error: string }).error;
              if (errKind === 'forbidden' || errKind === 'requires_dual_approval') {
                sendReaction(jid, wid, '❌');
              }
            }
          }
        }

        results.push({
          type: 'tool_result' as const,
          tool_use_id: tu.id,
          content: JSON.stringify(out),
          is_error: isError,
        });
        await audit({
          acao: (isError ? 'unauthorized_access_attempt' : 'classification_suggested') as never,
          pessoa_id: pessoa.id,
          conversa_id: c.id,
          mensagem_id: inbound.id,
          metadata: { tool: tu.tool },
        });
      }
      conversation.push({ role: 'user', content: results });
    }
  } finally {
    stopTyping();
  }

  await mensagensRepo.markProcessed(inbound.id, totalTokens);
  await conversasRepo.touch(c.id);

  // Reflection trigger: correction detection (real-time)
  if (inbound.conteudo && detectCorrection(inbound.conteudo)) {
    const prev = await findPreviousAssistantMessage(c.id, inbound.id);
    if (prev) {
      await reflectOnCorrection({
        pessoa,
        conversa: c,
        inbound,
        previousAssistant: prev,
      });
    }
  }
}

async function sendOutbound(
  pessoa_id: string,
  conversa_id: string,
  text: string,
  in_reply_to: string,
  opts?: {
    pending_question_id?: string | null;
    quoted?: import('@/gateway/presence.js').WAQuotedContext;
    view_once?: boolean;
  },
): Promise<string | null> {
  const pessoa = await pessoasRepo.findById(pessoa_id);
  if (!pessoa) return null;
  const jid = pessoa.telefone_whatsapp.replace('+', '') + '@s.whatsapp.net';
  const sendOpts: { quoted?: import('@/gateway/presence.js').WAQuotedContext; view_once?: boolean } = {};
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

async function sendOutboundPoll(
  pessoa_id: string,
  conversa_id: string,
  text: string,
  in_reply_to: string,
  pending: { id: string; opcoes_validas: Array<{ key: string; label: string }> },
): Promise<{ fell_back: boolean }> {
  const pessoa = await pessoasRepo.findById(pessoa_id);
  if (!pessoa) return { fell_back: false };
  const jid = pessoa.telefone_whatsapp.replace('+', '') + '@s.whatsapp.net';
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

async function loadConversaWithPessoa(conversa_id: string) {
  const all = await import('@/db/client.js').then((m) => m.db);
  const { conversas, pessoas } = await import('@/db/schema.js');
  const { eq } = await import('drizzle-orm');
  const rows = await all
    .select()
    .from(conversas)
    .innerJoin(pessoas, eq(conversas.pessoa_id, pessoas.id))
    .where(eq(conversas.id, conversa_id))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return { conversa: r.conversas, pessoa: r.pessoas };
}
