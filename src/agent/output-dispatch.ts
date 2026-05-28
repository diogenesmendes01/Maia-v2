import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { mensagensRepo, pessoasRepo, pendingQuestionsRepo } from '@/db/repositories.js';
import { outboundMessagesRepo } from '@/db/repositories/outbound-messages-repo.js';
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
 * Issue #227 — derive the per-turn idempotency key from
 * `(conversa_id, in_reply_to, modality, sha256(payload-hash))`.
 *
 * The hash uses a modality-specific payload (text for text replies,
 * filename+caption for documents, text for voice, text for polls) so a
 * content change between retries reserves a fresh row (different
 * idempotency_key) and never collides with a prior attempt's status. A
 * retry that sends the SAME content re-resolves to the same key and
 * gets the prior row back, letting `upsertPending` short-circuit when
 * status='sent'.
 *
 * Exported so future guard callers can compute the same key for
 * diagnostics — but the production per-turn lookup uses
 * `findByConversaTurn` (conversa + in_reply_to), not the key.
 */
export function computeOutboundIdempotencyKey(args: {
  conversa_id: string;
  in_reply_to: string;
  text: string;
  modality?: 'text' | 'document' | 'voice' | 'poll';
}): string {
  const modality = args.modality ?? 'text';
  const h = createHash('sha256').update(args.text).digest('hex');
  // Prepend modality so the same text via different channels claims
  // distinct rows — the 4 modalities are independent dedupe units.
  return `${args.conversa_id}:${args.in_reply_to}:${modality}:${h}`;
}

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
 *   - `ambiguous: true`  — the provider call threw mid-flight. Per #227 §Design,
 *     this is the `unknown` boundary: treat as TERMINAL-SKIP (no ReAct
 *     fall-through, no double-send) — owner's "rare silence > zero double-send"
 *     trade-off.
 * Tagged across EVERY branch of `dispatchOutput`/`sendOutbound`: pre-send
 * (recipient + quote lookup), text, voice, the PDF document send+persist, and
 * the poll send+persist. Callers should go through `safeDispatchOutput`, which
 * centralises this classification + records the failed attempt; an untyped throw
 * is still treated conservatively as ambiguous (TERMINAL-SKIP).
 * Extends Error (carries the cause message) so existing generic
 * `catch (e) { (e as Error).message }` callers are unaffected.
 */
export class OutboundDeliveryError extends Error {
  readonly delivered: boolean;
  /**
   * #227 — ambiguous boundary: the provider call started but its
   * outcome is unknown (relayed-then-errored, post-persist failure
   * with user already seeing the message, etc.). When true the
   * caller must treat the turn as TERMINAL-SKIP (no ReAct
   * fall-through, no retry). `delivered` is still set conservatively
   * for legacy callers that only look at the boolean.
   */
  readonly ambiguous: boolean;
  constructor(delivered: boolean, message: string, opts?: { ambiguous?: boolean }) {
    super(message);
    this.name = 'OutboundDeliveryError';
    this.delivered = delivered;
    this.ambiguous = opts?.ambiguous ?? false;
  }
}

/**
 * The baileys send fns return `null` in TWO distinct cases: (a) the socket was
 * DISCONNECTED so the send never happened, and (b) `sendMessage` resolved but
 * returned no `key.id` — the send most likely HAPPENED, we just have no id.
 * Disambiguate by connection state so we NEVER fall through (→ re-send) on a
 * possibly-delivered message (Codex #216 round-3, item 3):
 *   - connected + null ⇒ ambiguous (sent-but-unconfirmed → terminal-skip).
 *   - disconnected      ⇒ delivered:false (nothing sent → safe to recover).
 * The residual TOCTOU (sent, then the socket drops before this check) is the
 * #227 "entregou-mas-lançou" window, handled by the ledger's unknown status.
 */
function throwForNullSend(channel: string): never {
  if (isBaileysConnected()) {
    throw new OutboundDeliveryError(true, `${channel}_sent_without_id`, { ambiguous: true });
  }
  throw new OutboundDeliveryError(false, `${channel}_disconnected`);
}

// ===========================================================================
// Ledger wrapping helper — Issue #227 (Item 6: 4 modalities through ledger).
// ===========================================================================

/**
 * Result of a successful ledger-wrapped send. The provider response is
 * passed through verbatim so the caller can persist whatever metadata
 * makes sense for the modality (e.g., `whatsapp_id`, `message_secret`).
 */
export type WrappedSendResult<R> =
  | { kind: 'sent'; response: R; idempotency_key: string }
  | { kind: 'skipped_prior_sent'; idempotency_key: string; provider_message_id: string | null };

/**
 * #227 — wrap any modality's send + persist with the idempotency ledger.
 *
 * Behaviour:
 *  1. Claim a `pending` row for `(tenant, agent, conversa, turn, modality, hash)`.
 *     - If a prior attempt already reached `sent`: skip and return early
 *       (caller does NOT invoke the provider). The legacy provider_message_id
 *       is surfaced for logging/metrics.
 *     - If the row reclaim says "we did NOT insert" and it is at `pending`
 *       (recent, not stale) / `unknown`: skip the send conservatively. The
 *       caller does not re-send.
 *     - Otherwise we hold the claim and proceed.
 *  2. Invoke `sendFn`. Any throw is classified:
 *       - pre-send (OutboundDeliveryError delivered:false, ambiguous:false)
 *         → markFailed → safe for ReAct fall-through.
 *       - ambiguous (delivered:true OR ambiguous:true OR untyped)
 *         → markUnknown → TERMINAL-SKIP per owner's "zero double-send".
 *  3. On success, invoke `persistFn`. If THAT throws, the user already
 *     received the message → markUnknown (terminal-skip).
 *  4. On full success → markSent.
 *
 * Returns `{ kind: 'sent', response }` on success or
 * `{ kind: 'skipped_prior_sent' }` on the dedupe early-return.
 * Throws (`OutboundDeliveryError`) on failure — the caller's
 * `safeDispatchOutput`/`handleDispatchError` classifies and maps to a
 * `DispatchOutcome`.
 *
 * The whole helper is best-effort on the ledger interactions: if the
 * ledger itself is unavailable (DB down, migration unapplied), we log
 * loudly and proceed WITHOUT the dedupe guard — silencing the user
 * because the ledger is down would be a worse failure mode than the
 * narrow double-send window we already tolerated pre-#227.
 */
async function wrapWithLedger<R>(args: {
  conversa_id: string;
  in_reply_to: string;
  text: string;
  modality: 'text' | 'document' | 'voice' | 'poll';
  sendFn: () => Promise<R>;
  /**
   * Called AFTER the provider send returned. Should persist whatever
   * `mensagens`/audit rows the modality requires. A throw HERE means
   * the user got the message but the DB row is missing → terminal-skip.
   */
  persistFn: (response: R) => Promise<void>;
  /**
   * Extract the provider message id from the send response for the
   * ledger row's `markSent`. Return null if the response carries no id
   * (poll fallback path, etc.) — the row is still marked sent.
   */
  extractProviderId: (response: R) => string | null;
}): Promise<WrappedSendResult<R>> {
  const idempotency_key = computeOutboundIdempotencyKey({
    conversa_id: args.conversa_id,
    in_reply_to: args.in_reply_to,
    text: args.text,
    modality: args.modality,
  });

  let ledgerActive = true;
  try {
    const claimedRow = await outboundMessagesRepo.upsertPending({
      idempotency_key,
      conversa_id: args.conversa_id,
      in_reply_to: args.in_reply_to,
    });

    // Prior attempt already succeeded → skip the provider call. The
    // caller sees `skipped_prior_sent` and returns early.
    if (claimedRow.skip) {
      logger.info(
        {
          conversa_id: args.conversa_id,
          in_reply_to: args.in_reply_to,
          modality: args.modality,
          provider_message_id: claimedRow.row.provider_message_id,
          sent_at: claimedRow.row.sent_at,
        },
        'outbound.dedupe_skip_already_sent',
      );
      return {
        kind: 'skipped_prior_sent',
        idempotency_key,
        provider_message_id: claimedRow.row.provider_message_id,
      };
    }

    // We did not insert AND the prior row is not sent: this means the
    // ON CONFLICT WHERE filtered the UPDATE out (recent pending /
    // unknown). Conservatively skip the send — another worker holds
    // the claim, or an ambiguous prior attempt blocks us.
    if (!claimedRow.inserted && claimedRow.row.status !== 'failed') {
      logger.warn(
        {
          conversa_id: args.conversa_id,
          in_reply_to: args.in_reply_to,
          modality: args.modality,
          prior_status: claimedRow.row.status,
        },
        'outbound.dedupe_skip_concurrent_claim',
      );
      // No provider call. Surface as "skipped" — caller behaves the
      // same as on a `skip=true` (no re-send, no error).
      return {
        kind: 'skipped_prior_sent',
        idempotency_key,
        provider_message_id: claimedRow.row.provider_message_id,
      };
    }
  } catch (err) {
    // Ledger unavailable (DB down, migration not applied). Log loudly
    // and proceed WITHOUT the ledger so the user still gets a reply —
    // the double-send window is narrow + low-harm; total silence is
    // worse.
    ledgerActive = false;
    logger.warn(
      {
        conversa_id: args.conversa_id,
        in_reply_to: args.in_reply_to,
        modality: args.modality,
        err: (err as Error).message,
      },
      'outbound.ledger_unavailable_proceeding_unguarded',
    );
  }

  // Ledger transition helpers — never throw (their own errors are logged
  // and swallowed so the user-facing reply path is never broken by an
  // ops-side DB hiccup).
  const markLedgerFailed = async (error: string): Promise<void> => {
    if (!ledgerActive) return;
    try {
      await outboundMessagesRepo.markFailed({ idempotency_key, error });
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, idempotency_key },
        'outbound.ledger_mark_failed_failed',
      );
    }
  };
  const markLedgerUnknown = async (error: string): Promise<void> => {
    if (!ledgerActive) return;
    try {
      await outboundMessagesRepo.markUnknown({ idempotency_key, error });
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, idempotency_key },
        'outbound.ledger_mark_unknown_failed',
      );
    }
  };
  const markLedgerSent = async (provider_message_id: string | null): Promise<void> => {
    if (!ledgerActive) return;
    try {
      await outboundMessagesRepo.markSent({
        idempotency_key,
        provider_message_id,
        sent_at: new Date(),
      });
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, idempotency_key },
        'outbound.ledger_mark_sent_failed',
      );
    }
  };

  // PROVIDER CALL. Any throw is classified into the ledger status.
  let response: R;
  try {
    response = await args.sendFn();
  } catch (e) {
    if (e instanceof OutboundDeliveryError && e.delivered === false && !e.ambiguous) {
      // Pre-send (typed) → safe to retry via ReAct. `failed` keeps the
      // ledger row in a recoverable state.
      await markLedgerFailed(e.message);
      throw e;
    }
    // Ambiguous (typed ambiguous, delivered:true, or untyped throw) →
    // TERMINAL-SKIP. The caller's `safeDispatchOutput` will map this
    // to `sent_no_persist` (allowReact:false).
    const msg = (e as Error).message;
    await markLedgerUnknown(msg);
    // Re-wrap untyped throws so the classifier downstream treats them
    // as ambiguous (not "pre-send").
    if (e instanceof OutboundDeliveryError) throw e;
    throw new OutboundDeliveryError(true, msg, { ambiguous: true });
  }

  // PERSIST. A throw here means the user got the message → terminal-skip.
  try {
    await args.persistFn(response);
  } catch (e) {
    const msg = (e as Error).message;
    await markLedgerUnknown(`persist_failed: ${msg}`);
    throw new OutboundDeliveryError(true, msg, { ambiguous: true });
  }

  await markLedgerSent(args.extractProviderId(response));
  return { kind: 'sent', response, idempotency_key };
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
    const captionText = text.slice(0, 1024);
    try {
      // Document modality — claim the ledger row keyed by
      // (conversa, turn, 'document', hash(filename + caption)) so a
      // text path with the same caption doesn't collide.
      const result = await wrapWithLedger({
        conversa_id: c.id,
        in_reply_to: inbound.id,
        text: `${pdf.fileName}|${captionText}`,
        modality: 'document',
        sendFn: async () => {
          let wid: string | null;
          try {
            wid = await sendOutboundDocument(jid, pdf.path, {
              mimetype: pdf.mimetype,
              fileName: pdf.fileName,
              caption: captionText,
              quoted: quotedContext,
            });
          } catch (e) {
            throw new OutboundDeliveryError(false, (e as Error).message);
          }
          if (!wid) {
            throwForNullSend('document_channel');
          }
          return wid;
        },
        persistFn: async (wid) => {
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
        },
        extractProviderId: (wid) => wid,
      });
      // `skipped_prior_sent` → the document was already delivered in a
      // prior attempt for this exact (turn, filename, caption). Nothing
      // to persist; the previous attempt's mensagens row is the record.
      if (result.kind === 'skipped_prior_sent') {
        logger.info(
          { conversa_id: c.id, in_reply_to: inbound.id, modality: 'document' },
          'outbound.dedupe_skipped_document_send',
        );
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
      const voiceBufLocal = voiceBuf;
      const result = await wrapWithLedger({
        conversa_id: c.id,
        in_reply_to: inbound.id,
        text,
        modality: 'voice',
        sendFn: async () => {
          let wid: string | null;
          try {
            wid = await sendOutboundVoice(jid, voiceBufLocal, {
              quoted: quotedContext,
            });
          } catch (e) {
            throw new OutboundDeliveryError(false, (e as Error).message);
          }
          if (!wid) {
            throwForNullSend('voice_channel');
          }
          return wid;
        },
        persistFn: async (wid) => {
          await audit({
            acao: 'outbound_sent_voice',
            pessoa_id: pessoa.id,
            conversa_id: c.id,
            mensagem_id: inbound.id,
            metadata: {
              whatsapp_id: wid,
              char_count: text.length,
              byte_size: voiceBufLocal.length,
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
        },
        extractProviderId: (wid) => wid,
      });
      if (result.kind === 'skipped_prior_sent') {
        logger.info(
          { conversa_id: c.id, in_reply_to: inbound.id, modality: 'voice' },
          'outbound.dedupe_skipped_voice_send',
        );
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
 *                         `allowReact: true` is the explicit signal.
 *   - `sent_no_persist` — the message reached the user OR delivery is ambiguous
 *                         (post-relay throw, post-persist failure, untyped
 *                         throw). Caller must NOT re-send (double-send risk).
 *                         `allowReact: false` is the explicit signal — this is
 *                         the #227 TERMINAL-SKIP semantics for `unknown`.
 *
 * The `allowReact` flag is the canonical decision input for callers:
 *   - true  → may fall through to ReAct for a retry.
 *   - false → terminal-skip; do NOT cascade to ReAct in this turn.
 * The owner's "rare silence > zero double-send" trade-off makes the
 * ambiguous (delivered:true, ambiguous:true, or untyped) case ALWAYS
 * `allowReact:false`.
 */
export type DispatchOutcome =
  | { status: 'delivered'; allowReact: false }
  | { status: 'not_sent'; allowReact: true; error: string }
  | { status: 'sent_no_persist'; allowReact: false; error: string };

/**
 * Centralised, resilient entry point for outbound delivery (Codex #216 HIGH-1).
 * Wraps `dispatchOutput`, classifies any failure by phase, records the failed
 * attempt and returns a `DispatchOutcome` the caller maps to its own recovery.
 * NEVER throws — so every caller (skill execution, ReAct loop) is guaranteed a
 * decision and the user is never silently dropped.
 */
export async function safeDispatchOutput(ctx: DispatchOutputCtx): Promise<DispatchOutcome> {
  try {
    await dispatchOutput(ctx);
    return { status: 'delivered', allowReact: false };
  } catch (e) {
    return handleDispatchError(e, ctx);
  }
}

/**
 * Classify a dispatch failure by phase, record it, and map it to a
 * `DispatchOutcome`.
 *
 * Pre-send (delivered:false AND !ambiguous) ⇒ nothing reached the user, so
 * recovery is safe → `allowReact:true`. Anything else (delivered:true,
 * ambiguous, untyped) ⇒ TERMINAL-SKIP (the #227 unknown semantics):
 * `allowReact:false`, the caller does NOT cascade to ReAct in this turn.
 */
async function handleDispatchError(
  e: unknown,
  ctx: DispatchOutputCtx,
): Promise<DispatchOutcome> {
  const error = (e as Error).message;
  const isOutbound = e instanceof OutboundDeliveryError;
  const ambiguous = isOutbound ? e.ambiguous : true;
  const delivered = isOutbound ? e.delivered : undefined;

  // Pre-send (typed, NOT ambiguous, delivered:false) → safe to retry.
  if (isOutbound && delivered === false && !ambiguous) {
    await recordOutboundAttempt(ctx, 'pre_send', error);
    return { status: 'not_sent', allowReact: true, error };
  }
  // Everything else → terminal-skip (#227 owner choice: zero double-send).
  const phase: 'post_send' | 'unknown' = delivered === true ? 'post_send' : 'unknown';
  await recordOutboundAttempt(ctx, phase, error);
  return { status: 'sent_no_persist', allowReact: false, error };
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
  // PRE-SEND (recipient + JID resolution). If any of this throws, or there's no
  // recipient to resolve a JID for, NOTHING reached the user → tag
  // delivered:false (NOT ambiguous) so callers recover (fall through / retry)
  // without a double-send.
  let jid: string;
  try {
    const pessoa = await pessoasRepo.findById(pessoa_id);
    if (!pessoa) throw new OutboundDeliveryError(false, 'pessoa_not_found');
    jid = await resolveOutboundJid(pessoa, in_reply_to);
  } catch (e) {
    if (e instanceof OutboundDeliveryError) throw e;
    throw new OutboundDeliveryError(false, (e as Error).message);
  }
  const sendOpts: { quoted?: WAQuotedContext; view_once?: boolean } = {};
  if (opts?.quoted) sendOpts.quoted = opts.quoted;
  if (opts?.view_once) sendOpts.view_once = true;

  // Text modality goes through the shared ledger wrapper. Pre-send /
  // ambiguous / persist failure classification lives in `wrapWithLedger`.
  const result = await wrapWithLedger({
    conversa_id,
    in_reply_to,
    text,
    modality: 'text',
    sendFn: async () => {
      let wid: string | null;
      try {
        wid = await sendOutboundText(
          jid,
          text,
          Object.keys(sendOpts).length ? sendOpts : undefined,
        );
      } catch (e) {
        // Provider call boundary. The transport doesn't distinguish
        // relayed-then-acked-late from never-sent; per #227 §Design
        // nuance, classify as ambiguous so the ledger records `unknown`
        // and the per-turn guard blocks ReAct.
        throw new OutboundDeliveryError(true, (e as Error).message, { ambiguous: true });
      }
      if (wid === null) {
        // null ⇒ ambiguous (sent-without-id) when connected, or
        // not-sent when disconnected. throwForNullSend disambiguates.
        throwForNullSend('text_channel');
      }
      return wid;
    },
    persistFn: async (wid) => {
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
        ferramentas_chamadas: opts?.tool_summaries ?? [],
        tokens_usados: null,
      });
    },
    extractProviderId: (wid) => wid,
  });

  if (result.kind === 'skipped_prior_sent') {
    return result.provider_message_id;
  }
  return result.response;
}

export async function sendOutboundPoll(
  pessoa_id: string,
  conversa_id: string,
  text: string,
  in_reply_to: string,
  pending: { id: string; opcoes_validas: Array<{ key: string; label: string }> },
  opts?: { tool_summaries?: ToolExecutionSummary[] },
): Promise<{ fell_back: boolean }> {
  // PRE-SEND (recipient + JID): a throw or missing recipient means nothing was
  // sent → delivered:false so the caller can recover (Codex #216 round-3).
  let jid: string;
  try {
    const pessoa = await pessoasRepo.findById(pessoa_id);
    if (!pessoa) throw new OutboundDeliveryError(false, 'pessoa_not_found');
    jid = await resolveOutboundJid(pessoa, in_reply_to);
  } catch (e) {
    if (e instanceof OutboundDeliveryError) throw e;
    throw new OutboundDeliveryError(false, (e as Error).message);
  }
  const { sendPoll } = await import('@/gateway/presence.js');

  // Poll modality through the ledger. The poll content for the
  // idempotency hash is the question text + the option keys (so a
  // recolour of option labels with the same keys/text still hashes
  // identically — desirable for retries).
  const optionsKey = pending.opcoes_validas.map((o) => o.key).join('|');
  const hashPayload = `${text}|${optionsKey}`;

  type PollResp = { sent: Awaited<ReturnType<typeof sendPoll>>; fellBack: boolean };
  const result = await wrapWithLedger<PollResp>({
    conversa_id,
    in_reply_to,
    text: hashPayload,
    modality: 'poll',
    sendFn: async () => {
      let sent: Awaited<ReturnType<typeof sendPoll>>;
      try {
        sent = await sendPoll(jid, text, pending.opcoes_validas);
      } catch (e) {
        throw new OutboundDeliveryError(false, (e as Error).message);
      }
      const fellBack =
        !sent.whatsapp_id || !sent.message_secret || !sent.creator_jid;
      return { sent, fellBack };
    },
    persistFn: async ({ sent, fellBack }) => {
      if (fellBack) {
        // Poll secrets missing — fall back to text via sendOutbound
        // (which itself goes through the text-modality ledger).
        const numbered = pending.opcoes_validas
          .map((o, i) => `${i + 1}. ${o.label}`)
          .join('\n');
        await sendOutbound(pessoa_id, conversa_id, `${text}\n\n${numbered}`, in_reply_to, {
          pending_question_id: pending.id,
          tool_summaries: opts?.tool_summaries,
        });
        return;
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
        ferramentas_chamadas: opts?.tool_summaries ?? [],
        tokens_usados: null,
      });
    },
    extractProviderId: ({ sent }) => sent.whatsapp_id ?? null,
  });

  if (result.kind === 'skipped_prior_sent') {
    return { fell_back: false };
  }
  return { fell_back: result.response.fellBack };
}
