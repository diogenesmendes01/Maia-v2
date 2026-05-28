import { stat } from 'node:fs/promises';
import {
  mensagensRepo,
  pessoasRepo,
  pendingQuestionsRepo,
  outboundMessagesRepo,
  type OutboundChannel,
} from '@/db/repositories.js';
import type { Pessoa, Conversa, Mensagem } from '@/db/schema.js';
import { audit } from '@/governance/audit.js';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { sendOutboundText, sendOutboundDocument, sendOutboundVoice, isBaileysConnected } from '@/gateway/baileys.js';
import { synthesizeSpeech, OUTBOUND_VOICE_MAX_CHARS } from '@/lib/tts.js';
import { quotedReplyContext } from '@/gateway/presence.js';
import type { WAQuotedContext } from '@/gateway/presence.js';
import { detectCorrection } from './reflection.js';
import { cleanupPDF } from './pdf-cleanup.js';
import type { ToolExecutionSummary } from './tool-execution-summary.js';

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
  /**
   * Issue #73: structured per-tool outcomes from this turn's react loop.
   * Persisted on the outbound assistant message in `ferramentas_chamadas`
   * so the NEXT turn's prompt-builder can reidrate the "## Eventos
   * confirmados pelo backend" block from authoritative backend state.
   */
  toolSummaries?: ToolExecutionSummary[];
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
/**
 * Thrown by `sendOutbound` (and surfaced through `dispatchOutput`) to tell a
 * caller WHICH phase of delivery failed (Codex #216 review HIGH-A / HIGH-1):
 *   - `delivered: false` — NOTHING reached the user. Either a pre-send step
 *     failed (recipient/JID lookup, quote lookup), the channel send threw, or
 *     the gateway was DISCONNECTED (baileys returns `null` instead of throwing —
 *     we convert that `null` to delivered:false here so it isn't a silent drop).
 *     The caller may safely recover (fall through to ReAct / retry) without
 *     risking a duplicate.
 *   - `delivered: true`  — the message WAS sent but the DB persist failed; the
 *     user already received it, so the caller must NOT re-send (double-send).
 * Tagged across EVERY branch of `dispatchOutput`/`sendOutbound`: pre-send
 * (recipient + quote lookup), text, voice, the PDF document send+persist, and
 * the poll send+persist. Callers should go through `safeDispatchOutput`, which
 * centralises this classification + records the failed attempt; an untyped throw
 * is still treated conservatively as delivered (no re-send).
 * Extends Error (carries the cause message) so existing generic
 * `catch (e) { (e as Error).message }` callers are unaffected.
 */
export class OutboundDeliveryError extends Error {
  readonly delivered: boolean;
  constructor(delivered: boolean, message: string) {
    super(message);
    this.name = 'OutboundDeliveryError';
    this.delivered = delivered;
  }
}

// ---------------------------------------------------------------------------
// #227 outbound idempotency ledger (gated by FEATURE_OUTBOUND_DEDUP). The
// helpers no-op when the flag is off so the dispatch paths are wiring-safe
// before the migration backfills + the flag flips on. When on:
//   - claimOutboundLedger: pre-send optimistic upsert. skip=true ⇒ a prior
//     attempt is already 'sent' or 'unknown' for this (conversa,in_reply_to);
//     caller MUST NOT send again.
//   - recordLedgerSent: gateway acked (or sent-without-id) — mark 'sent'.
//   - recordLedgerFailed(ambiguous=false): definitely not sent (pre-send wrap
//     throw, disconnected null) — 'failed' so a later attempt may retry.
//   - recordLedgerFailed(ambiguous=true): transport throw — could be delivered-
//     but-threw; record 'unknown' so the boundary guard blocks any re-attempt
//     (the crux trade: a sliver of silence risk for zero double-send).
// ---------------------------------------------------------------------------
function outboundIdempotencyKey(conversa_id: string, in_reply_to: string): string {
  return `${conversa_id}:${in_reply_to}`;
}

async function claimOutboundLedger(
  conversa_id: string,
  in_reply_to: string,
  channel: OutboundChannel,
): Promise<{ skip: boolean; existing_provider_message_id: string | null }> {
  if (!config.FEATURE_OUTBOUND_DEDUP) {
    return { skip: false, existing_provider_message_id: null };
  }
  const result = await outboundMessagesRepo.upsertPending({
    idempotency_key: outboundIdempotencyKey(conversa_id, in_reply_to),
    conversa_id,
    in_reply_to,
    channel,
  });
  return {
    skip: result.skip,
    existing_provider_message_id: result.row.provider_message_id,
  };
}

/**
 * Fail-open wrapper around `claimOutboundLedger` (#227 review blocker 6).
 *
 * If the ledger claim itself throws (DB hiccup, advisory-lock backend down,
 * etc.) we MUST NOT block the legitimate send — otherwise a DB issue turns
 * into user-visible silence. The review prescribes liveness > strict dedupe:
 * log the issue and proceed as if there's no prior row. The narrow window
 * where this happens AND a true double-send would result is far smaller than
 * the everyday risk of dropping live messages on transient DB blips.
 *
 * Note: `claimOutboundLedger` already no-ops when the flag is off, so this
 * wrapper only adds value when the flag is on. We still wrap unconditionally —
 * the cost is negligible and it keeps the call-sites uniform.
 */
async function claimOutboundLedgerOrFailOpen(
  conversa_id: string,
  in_reply_to: string,
  channel: OutboundChannel,
): Promise<{ skip: boolean; existing_provider_message_id: string | null }> {
  try {
    return await claimOutboundLedger(conversa_id, in_reply_to, channel);
  } catch (err) {
    logger.warn(
      {
        err: (err as Error).message,
        conversa_id,
        in_reply_to,
        channel,
      },
      'outbound_ledger.claim_failed',
    );
    return { skip: false, existing_provider_message_id: null };
  }
}

/**
 * Discriminator for sendOutboundDocument throws (#227 review blocker 4).
 *
 * sendOutboundDocument throws BOTH from:
 *   1. readFile failure — DEFINITELY pre-send, nothing reached the wire.
 *      Tagged with `code: 'DOC_READ_FAILED'` (see src/gateway/baileys.ts).
 *   2. socket.sendMessage failure — transport throw, COULD be delivered-but-threw.
 *
 * Without this discriminator the dispatch records 'unknown' for case (1) too,
 * which the boundary guard treats as "do not retry" → silent drop. That's the
 * exact HIGH-1 failure mode #216 closed for documents.
 *
 * Returns `ambiguous` matching outboundMessagesRepo.markFailed semantics:
 *   - false → record 'failed' (retry safe, nothing was sent).
 *   - true  → record 'unknown' (could be sent, block retry).
 */
function classifyDocumentThrow(e: unknown): boolean {
  return (e as Error & { code?: string })?.code !== 'DOC_READ_FAILED';
}

async function recordLedgerSent(
  conversa_id: string,
  in_reply_to: string,
  provider_message_id: string | null,
): Promise<void> {
  if (!config.FEATURE_OUTBOUND_DEDUP) return;
  await outboundMessagesRepo.markSent(
    outboundIdempotencyKey(conversa_id, in_reply_to),
    provider_message_id,
  );
}

async function recordLedgerFailed(
  conversa_id: string,
  in_reply_to: string,
  error: string,
  ambiguous: boolean,
): Promise<void> {
  if (!config.FEATURE_OUTBOUND_DEDUP) return;
  await outboundMessagesRepo.markFailed(
    outboundIdempotencyKey(conversa_id, in_reply_to),
    error,
    ambiguous,
  );
}

export async function dispatchOutput(ctx: DispatchOutputCtx): Promise<void> {
  const { pessoa, conversa: c, inbound, jid, text, latestPending, latestReportPdf, turnHasSensitive, sensitiveTools } = ctx;
  const toolSummaries = ctx.toolSummaries ?? [];

  // Quoting decision is shared across PDF / voice / text branches —
  // computed once so the rule (correction-detected OR pending active)
  // can't drift between copies.
  // Pending check via canonical repo (post-B0). `||` short-circuits
  // on detected correction so the DB hit only happens when needed.
  // Everything up to the first channel send is PRE-send work: if it throws,
  // NOTHING reached the user. Tag it delivered:false (Codex #216 HIGH-1) so the
  // skill-execution caller falls through to ReAct (never silence) with no
  // double-send risk (nothing was dispatched).
  let quotedContext: WAQuotedContext | undefined;
  try {
    const shouldQuote =
      !!(inbound.conteudo && detectCorrection(inbound.conteudo)) ||
      (await pendingQuestionsRepo.findActiveSnapshot(c.id)) !== null;
    quotedContext = shouldQuote
      ? quotedReplyContext(
          inbound.metadata as Record<string, unknown> | null,
          inbound.conteudo,
        )
      : undefined;
  } catch (e) {
    if (e instanceof OutboundDeliveryError) throw e;
    throw new OutboundDeliveryError(false, (e as Error).message);
  }

  // B3b: PDF report path — takes precedence over poll/text. The LLM's
  // text becomes the document caption (truncated to WhatsApp's 1024-
  // char limit). The unlink-in-finally guarantees the tmp PDF is
  // removed even when send fails; boot sweeper is the safety net for
  // crash-mid-send.
  if (latestReportPdf) {
    const pdf = latestReportPdf;
    try {
      // #227: claim the turn before the send (no-op when flag off, fail-open on
      // DB throws — see claimOutboundLedgerOrFailOpen). cleanupPDF still runs
      // in the `finally` even when we short-circuit on skip.
      const ledger = await claimOutboundLedgerOrFailOpen(c.id, inbound.id, 'document');
      if (ledger.skip) return;
      const captionText = text.slice(0, 1024);
      let wid: string | null;
      try {
        wid = await sendOutboundDocument(jid, pdf.path, {
          mimetype: pdf.mimetype,
          fileName: pdf.fileName,
          caption: captionText,
          quoted: quotedContext,
        });
      } catch (e) {
        // sendOutboundDocument throws on either readFile failure (definitely
        // pre-send → 'failed', retryable) or socket.sendMessage failure
        // (transport, could be delivered-but-threw → 'unknown', not retryable).
        // The discriminator is the `code: 'DOC_READ_FAILED'` tag set on the
        // wrapped throw in baileys.send_document. Without it, a readFile fail
        // would record 'unknown' and the boundary guard would block retry —
        // reviving the HIGH-1 silent-drop #216 closed for documents.
        const ambiguous = classifyDocumentThrow(e);
        await recordLedgerFailed(c.id, inbound.id, (e as Error).message, ambiguous);
        throw new OutboundDeliveryError(false, (e as Error).message);
      }
      if (!wid) {
        // null ⇒ disconnected (not sent → ledger 'failed') OR sent-without-id
        // (→ ledger 'sent'); disambiguate by connection state (Codex #216
        // HIGH-1 + round-3 item 3). The tmp PDF is still removed by the
        // `finally` below either way.
        if (isBaileysConnected()) {
          await recordLedgerSent(c.id, inbound.id, null);
          throw new OutboundDeliveryError(true, 'document_channel_sent_without_id');
        }
        await recordLedgerFailed(c.id, inbound.id, 'document_channel_disconnected', false);
        throw new OutboundDeliveryError(false, 'document_channel_disconnected');
      }
      // Document acked — record 'sent' BEFORE the persist block so a persist
      // throw doesn't leave the ledger 'pending' while the user has the file.
      await recordLedgerSent(c.id, inbound.id, wid);
      try {
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
          ferramentas_chamadas: toolSummaries,
          tokens_usados: null,
        });
      } catch (e) {
        // Sent but not persisted → user already has the document; must NOT re-send.
        throw new OutboundDeliveryError(true, (e as Error).message);
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
      // #227: claim the turn before the voice send (no-op when flag off,
      // fail-open on DB throws — see claimOutboundLedgerOrFailOpen).
      const ledger = await claimOutboundLedgerOrFailOpen(c.id, inbound.id, 'voice');
      if (ledger.skip) return; // already attempted; do NOT re-send
      let wid: string | null;
      try {
        wid = await sendOutboundVoice(jid, voiceBuf, {
          quoted: quotedContext,
        });
      } catch (e) {
        // Transport throw is ambiguous (could be delivered-but-threw) →
        // ledger 'unknown' blocks any re-attempt; outer error still carries
        // delivered:false for the safeDispatchOutput contract.
        await recordLedgerFailed(c.id, inbound.id, (e as Error).message, true);
        throw new OutboundDeliveryError(false, (e as Error).message);
      }
      // null ⇒ disconnected (not sent → ledger 'failed') OR sent-without-id
      // (→ ledger 'sent'); disambiguate by connection state so a sent voice
      // note is never re-sent (Codex #216 HIGH-1 + round-3 item 3).
      if (!wid) {
        if (isBaileysConnected()) {
          await recordLedgerSent(c.id, inbound.id, null);
          throw new OutboundDeliveryError(true, 'voice_channel_sent_without_id');
        }
        await recordLedgerFailed(c.id, inbound.id, 'voice_channel_disconnected', false);
        throw new OutboundDeliveryError(false, 'voice_channel_disconnected');
      }
      // Voice acked — record 'sent' BEFORE persist so a persist throw can't
      // leave the ledger 'pending' while the user already heard the note.
      await recordLedgerSent(c.id, inbound.id, wid);
      try {
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
          ferramentas_chamadas: toolSummaries,
          tokens_usados: null,
        });
      } catch (e) {
        // Sent but not persisted → user already heard it; must NOT re-send.
        throw new OutboundDeliveryError(true, (e as Error).message);
      }
    } else {
      // TTS failed — fall back to text path (re-uses existing sendOutbound).
      await sendOutbound(pessoa.id, c.id, text, inbound.id, {
        pending_question_id: latestPending?.id ?? null,
        quoted: quotedContext,
        tool_summaries: toolSummaries,
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
    await sendOutboundPoll(pessoa.id, c.id, text, inbound.id, latestPending, {
      tool_summaries: toolSummaries,
    });
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
    tool_summaries: toolSummaries,
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

/**
 * Outcome of a `safeDispatchOutput` call. Lets the caller pick its own recovery
 * WITHOUT having to know the `OutboundDeliveryError` phase taxonomy:
 *   - `delivered`       — sent AND persisted. Caller: done.
 *   - `not_sent`        — NOTHING reached the user (pre-send / disconnected
 *                         gateway / channel threw). Caller MAY recover (fall
 *                         through to ReAct, retry) — no double-send risk.
 *   - `sent_no_persist` — the message reached the user but a later step failed
 *                         (DB persist), OR an untyped error left delivery
 *                         ambiguous. Caller must NOT re-send (double-send risk).
 */
export type DispatchOutcome =
  | { status: 'delivered' }
  | { status: 'not_sent'; error: string }
  | { status: 'sent_no_persist'; error: string };

/**
 * Centralised, resilient entry point for outbound delivery (Codex #216 HIGH-1).
 * Wraps `dispatchOutput`, classifies any failure by phase, records the failed
 * attempt and returns a `DispatchOutcome` the caller maps to its own recovery.
 * NEVER throws — so every caller (skill execution, ReAct loop) is guaranteed a
 * decision and the user is never silently dropped.
 */
export async function safeDispatchOutput(ctx: DispatchOutputCtx): Promise<DispatchOutcome> {
  // #227 boundary guard: if the ledger already records this turn as 'sent' or
  // 'unknown', a prior attempt (this skill caller's first try, or a previous
  // dispatch that fell through to ReAct) either delivered or might have
  // delivered. Do NOT dispatch — return an outcome the caller treats as
  // handled. 'failed' or stale 'pending' rows fall through; the inner
  // upsertPending atomically takes them over.
  //
  // Fail-open: if findByKey throws (DB hiccup), we proceed to dispatch as if
  // there's no prior row. Liveness > strict dedupe — a DB blip must NOT block
  // a legitimate send. The inner upsertPending will likely also fail and is
  // handled by claimOutboundLedgerOrFailOpen with the same fail-open contract.
  // safeDispatchOutput's never-throw guarantee depends on this: a raw throw
  // from findByKey before the try{} below would escape the contract.
  if (config.FEATURE_OUTBOUND_DEDUP) {
    const key = outboundIdempotencyKey(ctx.conversa.id, ctx.inbound.id);
    try {
      const existing = await outboundMessagesRepo.findByKey(key);
      if (existing?.status === 'sent') {
        return { status: 'delivered' };
      }
      if (existing?.status === 'unknown') {
        return {
          status: 'sent_no_persist',
          error: existing.error ?? 'prior_attempt_unknown',
        };
      }
    } catch (err) {
      logger.warn(
        {
          err: (err as Error).message,
          conversa_id: ctx.conversa.id,
          in_reply_to: ctx.inbound.id,
        },
        'outbound_ledger.findByKey_failed',
      );
      // Fall through to dispatch — the inner claim will fail-open too if the
      // DB is genuinely down.
    }
  }
  try {
    await dispatchOutput(ctx);
    return { status: 'delivered' };
  } catch (e) {
    return handleDispatchError(e, ctx);
  }
}

/**
 * Classify a dispatch failure by phase, record it, and map it to a
 * `DispatchOutcome`. Pre-send (delivered:false) ⇒ nothing reached the user, so
 * recovery is safe. Post-send (delivered:true) OR an untyped/unknown throw ⇒
 * the message may have reached the user, so we conservatively forbid a re-send.
 */
async function handleDispatchError(
  e: unknown,
  ctx: DispatchOutputCtx,
): Promise<DispatchOutcome> {
  const delivered = e instanceof OutboundDeliveryError ? e.delivered : undefined;
  const phase: 'pre_send' | 'post_send' | 'unknown' =
    delivered === false ? 'pre_send' : delivered === true ? 'post_send' : 'unknown';
  const error = (e as Error).message;
  await recordOutboundAttempt(ctx, phase, error);
  return phase === 'pre_send'
    ? { status: 'not_sent', error }
    : { status: 'sent_no_persist', error };
}

/**
 * Record a FAILED outbound attempt for ops visibility + as a breadcrumb for the
 * #227 idempotency ledger. Only failures are recorded — a successful send is
 * already captured by the persisted `mensagens` row (+ `outbound_sent_*`
 * audits), so auditing successes here would only double hot-path audit volume.
 * `audit` swallows its own errors, so this never breaks the caller.
 */
async function recordOutboundAttempt(
  ctx: DispatchOutputCtx,
  phase: 'pre_send' | 'post_send' | 'unknown',
  error: string,
): Promise<void> {
  await audit({
    acao: 'outbound_dispatch_failed',
    pessoa_id: ctx.pessoa.id,
    conversa_id: ctx.conversa.id,
    mensagem_id: ctx.inbound.id,
    metadata: {
      phase,
      delivered: phase === 'post_send',
      // Turn-scoped dedupe unit (one reply per inbound turn, any channel) — the
      // #227 ledger keys its pre-send optimistic insert on this.
      idempotency_key: `${ctx.conversa.id}:${ctx.inbound.id}`,
      error,
    },
  });
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
    /**
     * Issue #73: structured tool outcomes for this turn — persisted on the
     * outbound message so next-turn prompt-builder can reidrate them in the
     * "## Eventos confirmados pelo backend" block.
     */
    tool_summaries?: ToolExecutionSummary[];
  },
): Promise<string | null> {
  // #227: claim the turn in the ledger BEFORE any work. If a prior attempt
  // already marked this turn 'sent' / 'unknown' / 'pending' (in-flight),
  // short-circuit (the user got — or might have got — that reply; do NOT
  // re-send). No-op when the flag is off. Fail-open on DB throws so a DB
  // hiccup never blocks a legitimate send (liveness > strict dedupe).
  const ledger = await claimOutboundLedgerOrFailOpen(conversa_id, in_reply_to, 'text');
  if (ledger.skip) return ledger.existing_provider_message_id;

  // PRE-SEND (recipient + JID resolution). If any of this throws, or there's no
  // recipient to resolve a JID for, NOTHING reached the user → tag
  // delivered:false so callers recover (fall through / retry) without a
  // double-send. Ledger: 'failed' (ambiguous=false) — definitely not sent yet,
  // so a later attempt may retry.
  let jid: string;
  try {
    const pessoa = await pessoasRepo.findById(pessoa_id);
    if (!pessoa) throw new OutboundDeliveryError(false, 'pessoa_not_found');
    // Reply to whatever JID the inbound used (handles `@lid` privacy IDs that
    // wouldn't survive the round-trip through `phone + @s.whatsapp.net`).
    // Falls back to the phone-derived JID for non-reply outbounds.
    jid = await resolveOutboundJid(pessoa, in_reply_to);
  } catch (e) {
    const err =
      e instanceof OutboundDeliveryError
        ? e
        : new OutboundDeliveryError(false, (e as Error).message);
    await recordLedgerFailed(conversa_id, in_reply_to, err.message, false);
    throw err;
  }
  const sendOpts: { quoted?: WAQuotedContext; view_once?: boolean } = {};
  if (opts?.quoted) sendOpts.quoted = opts.quoted;
  if (opts?.view_once) sendOpts.view_once = true;
  // Delivery happens in two phases: send to the channel, THEN persist. Tag
  // failures by phase so callers can tell "nothing sent" from "sent but not
  // persisted" (Codex #216 HIGH-A). Ledger: a TRANSPORT throw is ambiguous —
  // could be delivered-but-threw — so record 'unknown' (ambiguous=true) and
  // the boundary guard blocks the ReAct re-attempt. The outer error still
  // carries delivered:false for the safeDispatchOutput phase contract.
  let wid: string | null;
  try {
    wid = await sendOutboundText(
      jid,
      text,
      Object.keys(sendOpts).length ? sendOpts : undefined,
    );
  } catch (e) {
    await recordLedgerFailed(conversa_id, in_reply_to, (e as Error).message, true);
    throw new OutboundDeliveryError(false, (e as Error).message);
  }
  // A null id means the gateway did NOT confirm a send. Disambiguate
  // disconnected (not sent → delivered:false, ledger 'failed' allowing retry)
  // from sent-without-id (→ delivered:true, ledger 'sent' to block any re-send)
  // so we don't drop silently NOR risk a double-send, and never persist a
  // phantom whatsapp_id:null row (Codex #216 HIGH-1 + round-3 item 3).
  if (wid === null) {
    if (isBaileysConnected()) {
      await recordLedgerSent(conversa_id, in_reply_to, null);
      throw new OutboundDeliveryError(true, 'channel_sent_without_id');
    }
    await recordLedgerFailed(conversa_id, in_reply_to, 'channel_disconnected', false);
    throw new OutboundDeliveryError(false, 'channel_disconnected');
  }
  // Channel acked — record 'sent' BEFORE the persist so a later persist throw
  // doesn't leave the ledger 'pending' while the user already has the message.
  await recordLedgerSent(conversa_id, in_reply_to, wid);
  const metadata: Record<string, unknown> = { whatsapp_id: wid, remote_jid: jid, in_reply_to };
  if (opts?.pending_question_id) metadata.pending_question_id = opts.pending_question_id;
  if (opts?.view_once) metadata.view_once = true;
  try {
    await mensagensRepo.create({
      conversa_id,
      direcao: 'out',
      tipo: 'texto',
      conteudo: text,
      midia_url: null,
      metadata,
      processada_em: new Date(),
      ferramentas_chamadas: opts?.tool_summaries ?? [],
      tokens_usados: null,
    });
  } catch (e) {
    // Ledger already 'sent'; persist failure is post-send — must NOT re-send.
    throw new OutboundDeliveryError(true, (e as Error).message);
  }
  return wid;
}

export async function sendOutboundPoll(
  pessoa_id: string,
  conversa_id: string,
  text: string,
  in_reply_to: string,
  pending: { id: string; opcoes_validas: Array<{ key: string; label: string }> },
  opts?: { tool_summaries?: ToolExecutionSummary[] },
): Promise<{ fell_back: boolean }> {
  // #227: claim the turn before any work (no-op when flag off, fail-open on
  // DB throws). The same-row reclaim during a poll→text fallback (below) is
  // handled by markFailed-then-claim — see the fallback comment.
  const ledger = await claimOutboundLedgerOrFailOpen(conversa_id, in_reply_to, 'poll');
  if (ledger.skip) return { fell_back: false };

  // PRE-SEND (recipient + JID): a throw or missing recipient means nothing was
  // sent → delivered:false so the caller can recover (Codex #216 round-3).
  // Ledger: 'failed' (ambiguous=false) — definitely not sent, retry allowed.
  let jid: string;
  try {
    const pessoa = await pessoasRepo.findById(pessoa_id);
    if (!pessoa) throw new OutboundDeliveryError(false, 'pessoa_not_found');
    jid = await resolveOutboundJid(pessoa, in_reply_to);
  } catch (e) {
    const err =
      e instanceof OutboundDeliveryError
        ? e
        : new OutboundDeliveryError(false, (e as Error).message);
    await recordLedgerFailed(conversa_id, in_reply_to, err.message, false);
    throw err;
  }
  const { sendPoll } = await import('@/gateway/presence.js');
  let sent: Awaited<ReturnType<typeof sendPoll>>;
  try {
    sent = await sendPoll(jid, text, pending.opcoes_validas);
  } catch (e) {
    // The poll never left the channel → delivered:false. (The text fallback
    // below only covers missing decryption secrets, not a hard send failure.)
    // Transport throw is ambiguous (could be delivered-but-threw) → 'unknown'.
    await recordLedgerFailed(conversa_id, in_reply_to, (e as Error).message, true);
    throw new OutboundDeliveryError(false, (e as Error).message);
  }
  // Without all three (whatsapp_id, message_secret, creator_jid) the inbound
  // vote can't be decrypted (creator_jid feeds the HMAC in decryptPollVote),
  // so the user would see a poll they can't actually answer. Fall back to text
  // (sendOutbound is itself phase-tagged AND claims/updates the same ledger
  // row, so its failures propagate correctly and the ledger reflects 'text').
  if (!sent.whatsapp_id || !sent.message_secret || !sent.creator_jid) {
    // #227 strict-pending: with the new semantic, our 'pending' poll row would
    // make sendOutbound's inner claim see "in-flight by another worker" and
    // skip — silent drop on fallback. Release the row to 'failed' first so the
    // text claim can reclaim it. ambiguous=false because the poll was
    // configuration-incomplete (missing secrets) — nothing was sent.
    await recordLedgerFailed(
      conversa_id,
      in_reply_to,
      'poll_missing_secrets_fallback_to_text',
      false,
    );
    const numbered = pending.opcoes_validas.map((o, i) => `${i + 1}. ${o.label}`).join('\n');
    await sendOutbound(pessoa_id, conversa_id, `${text}\n\n${numbered}`, in_reply_to, {
      pending_question_id: pending.id,
      tool_summaries: opts?.tool_summaries,
    });
    return { fell_back: true };
  }
  // Poll acked — record 'sent' BEFORE persist so a persist throw doesn't leave
  // the ledger 'pending' while the user already sees the poll.
  await recordLedgerSent(conversa_id, in_reply_to, sent.whatsapp_id);
  try {
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
      ferramentas_chamadas: opts?.tool_summaries ?? [],
      tokens_usados: null,
    });
  } catch (e) {
    // Sent but not persisted → user already saw the poll; must NOT re-send.
    throw new OutboundDeliveryError(true, (e as Error).message);
  }
  return { fell_back: false };
}
