import { mensagensRepo, conversasRepo } from '@/db/repositories.js';
import { resolveScope } from '@/governance/permissions.js';
import { checkPendingFirst } from '@/agent/pending-gate.js';
import { checkRateLimit, formatPoliteReply } from '@/gateway/rate-limit.js';
import { resolveIdentity } from '@/identity/resolver.js';
import { handleQuarantineFirstContact, handleOwnerIdentityReply } from '@/identity/quarantine.js';
import { config } from '@/config/env.js';
import { clearDebounceState } from '@/gateway/debouncer.js';
import { buildPrompt } from './prompt-builder.js';
import { logger } from '@/lib/logger.js';
import type { Mensagem } from '@/db/schema.js';
import { audit } from '@/governance/audit.js';
import { getToolSchemas } from '@/tools/_registry.js';
import { startTyping } from '@/gateway/presence.js';
import {
  detectCorrection,
  reflectOnCorrection,
  findPreviousAssistantMessage,
} from './reflection.js';
import { sendOutbound } from './output-dispatch.js';
import { runReActLoop } from './react-loop.js';

const TYPING_DEBOUNCE_MS = 1500;

/** Separator between aggregated chunks. Plain newline keeps the LLM's
 * tokenizer happy while letting it see the chunk boundaries the user
 * originally created — sometimes meaningful (e.g., "ok" / "espera" /
 * "deixa eu pensar"). */
const AGGREGATE_SEPARATOR = '\n';

/**
 * Inbound-text aggregation for the message-debounce path.
 *
 * When FEATURE_MESSAGE_DEBOUNCE is on, baileys schedules a delayed BullMQ
 * job per user instead of enqueueing immediately, so chunked typing
 * arrives at the LLM as a single coherent turn. By the time this worker
 * fires, one or more older inbound text messages may exist for the same
 * telefone with `processada_em IS NULL`.
 *
 * Sibling lookup is keyed by **telefone** (`metadata->>'telefone'`), not
 * conversa_id: baileys persists every inbound with `conversa_id = NULL`
 * and resolution happens here in `runAgentForMensagem`. Earlier chunks
 * from the same burst are still NULL-attached when this runs, so a
 * conversa_id query would silently miss them — only the target chunk
 * would reach the LLM and the rest would limp through `message-recovery`
 * 2 minutes later as separate turns. Keying by telefone catches them.
 *
 * Defense-in-depth: we also accept already-attached siblings whose
 * conversa_id matches the target's, in case the target was resolved
 * mid-burst and adopted a sibling synchronously somewhere else.
 * Cross-conversation leakage isn't a concern in this codebase
 * (telefone ↔ pessoa ↔ conversa is 1:1) but the explicit filter
 * documents the intent.
 *
 * Only `tipo = 'texto'` siblings are merged. Media bypasses the buffer
 * upstream (see baileys.handleIncoming).
 *
 * Returns the aggregated text and the ids of merged siblings; the
 * caller is responsible for adopting any orphans (conversa_id NULL) into
 * the target's conversa and marking them processed.
 */
async function aggregateUnprocessedTexts(target: Mensagem): Promise<{
  text: string;
  merged_ids: string[];
}> {
  const targetText = target.conteudo ?? '';
  const tel = (target.metadata as Record<string, unknown> | null)?.['telefone'];
  if (typeof tel !== 'string' || tel.length === 0) {
    return { text: targetText, merged_ids: [] };
  }

  const siblings = await mensagensRepo.listUnprocessedByTelefone(tel, {
    excludeId: target.id,
  });
  const textSiblings = siblings.filter(
    (m) =>
      m.tipo === 'texto' &&
      (m.conteudo ?? '').length > 0 &&
      // Accept orphans (will be adopted by caller) OR already-attached
      // siblings whose conversa_id matches. Reject cross-conversation
      // siblings as a defensive guard.
      (m.conversa_id === null || m.conversa_id === target.conversa_id),
  );
  if (textSiblings.length === 0) return { text: targetText, merged_ids: [] };

  // Chronological order: oldest sibling first, target last (it IS the
  // newest, since baileys schedules the debounced job pointing at the
  // most-recent inbound).
  const parts = textSiblings.map((m) => m.conteudo ?? '');
  const merged = [...parts, targetText].filter((s) => s.length > 0).join(AGGREGATE_SEPARATOR);
  return { text: merged, merged_ids: textSiblings.map((m) => m.id) };
}

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

export const _internal = { scheduleTypingDebounce, sendOutbound, aggregateUnprocessedTexts };

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

  // Debounce aggregation: concatenate any older unprocessed inbound texts
  // for this telefone into the target's content so the LLM sees one turn
  // instead of N partial chunks. No-op when there are no siblings, so
  // this is safe to run unconditionally — the recovery path also benefits
  // (a crash mid-debounce leaves siblings, this sweeps them).
  //
  // We mutate `inbound.conteudo` in memory only. Sibling DB rows are
  // adopted into the target's conversa (so history queries + recovery
  // sweeps see the right linkage) and marked processed at the end.
  const aggregated = inbound.conteudo
    ? await aggregateUnprocessedTexts(inbound).catch((err) => {
        logger.warn(
          { err: (err as Error).message, mensagem_id: inbound.id },
          'agent.aggregate_failed_continuing_solo',
        );
        return { text: inbound.conteudo ?? '', merged_ids: [] as string[] };
      })
    : { text: '', merged_ids: [] as string[] };
  if (aggregated.merged_ids.length > 0) {
    inbound.conteudo = aggregated.text;
    // Adopt orphans (conversa_id NULL) into the target's conversation.
    // setConversaIdMany is a no-op for ids already attached, so we can
    // pass the full merged set without filtering. Best-effort: a failure
    // here doesn't block the LLM turn — the rows still get processada_em
    // stamped below, so recovery won't double-process.
    try {
      await mensagensRepo.setConversaIdMany(aggregated.merged_ids, c.id);
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, count: aggregated.merged_ids.length },
        'agent.adopt_siblings_failed',
      );
    }
    logger.info(
      {
        mensagem_id: inbound.id,
        merged_count: aggregated.merged_ids.length,
        conversa_id: c.id,
      },
      'agent.debounce_aggregated',
    );
  }
  const allInboundIds = [...aggregated.merged_ids, inbound.id];
  const markAllProcessed = async (tokens: number | null): Promise<void> => {
    // Per-row update keeps the existing repo contract (single-id) and
    // mirrors the audit semantics: each row gets its own processada_em.
    // Errors on individual rows are swallowed so one failure can't block
    // the others — recovery worker will catch any stragglers.
    for (const id of allInboundIds) {
      try {
        await mensagensRepo.markProcessed(id, id === inbound.id ? tokens : 0);
      } catch (err) {
        logger.warn(
          { err: (err as Error).message, mensagem_id: id },
          'agent.mark_processed_failed',
        );
      }
    }
  };

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
    await markAllProcessed(0);
    await conversasRepo.touch(c.id);
    await clearDebounceState(pessoa.telefone_whatsapp);
    return;
  }

  // B0: pre-LLM gate. If the user's reply resolves a pending question,
  // the gate (via resolveAndDispatch) has already executed the proposed
  // action and audited it; we just close the loop and skip the ReAct turn.
  const gate = await checkPendingFirst({ pessoa, conversa: c, inbound });
  if (gate.kind === 'resolved') {
    await markAllProcessed(0);
    await conversasRepo.touch(c.id);
    await clearDebounceState(pessoa.telefone_whatsapp);
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
  const jid = pessoa.telefone_whatsapp.replace('+', '') + '@s.whatsapp.net';
  const stopTyping = scheduleTypingDebounce(jid, inbound.id);
  let totalTokens = 0;
  try {
    const result = await runReActLoop({
      pessoa,
      conversa: c,
      inbound,
      scope,
      jid,
      system,
      messages,
      tools,
    });
    totalTokens = result.totalTokens;
  } finally {
    stopTyping();
  }

  await markAllProcessed(totalTokens);
  await conversasRepo.touch(c.id);
  await clearDebounceState(pessoa.telefone_whatsapp);

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
