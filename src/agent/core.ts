import {
  mensagensRepo,
  conversasRepo,
  procedureExecutionsRepo,
  procedureDefinitionsRepo,
  procedureSelectorDecisionsRepo,
  channelPoliciesRepo,
  rolesRepo,
  agentAudienceProfilesRepo,
} from '@/db/repositories.js';
import { resolveScope } from '@/governance/permissions.js';
import { buildAudienceContext } from '@/identity/audience-context.js';
import { allowedDataScopesForAudience } from '@/skills/usage-policy.js';
import type { AudienceContext } from '@/identity/audience-context.js';
import { checkPendingFirst } from '@/agent/pending-gate.js';
import {
  parseApprovalReply,
  recordApprovalDecision,
  formatDecisionOutcome,
} from '@/governance/approval-requests.js';
import { checkRateLimit, formatPoliteReply } from '@/gateway/rate-limit.js';
import { resolveIdentity } from '@/identity/resolver.js';
import { handleQuarantineFirstContact, handleOwnerIdentityReply } from '@/identity/quarantine.js';
import { config } from '@/config/env.js';
import { clearDebounceState as clearDebounceStateRaw } from '@/gateway/debouncer.js';
import { buildPrompt } from './prompt-builder.js';
import { hashScope } from './scope-hash.js';
import { logger } from '@/lib/logger.js';
import { TypedError } from '@/lib/utils.js';
import type { Mensagem, ProcedureExecution, Role } from '@/db/schema.js';
import { resolveChannel } from '@/gateway/channel-resolver.js';
import { audit } from '@/governance/audit.js';
import { computeRuntimeVisibleTools } from '@/tools/runtime-filter.js';
import { mcpVisibleToolSchemas } from '@/tools/mcp-bridge.js';
import { forCurrentAgentChannel } from '@/gateway/line-output.js';
import type { TypingHandle } from '@/gateway/presence.js';
// NOTE (issue #412): procedure-selector / role-selector / step-evaluator and
// the reflection helpers (detectSuccess/detectCorrection/reflect/classify/
// persistCandidate/recordSuccess/reflectOnCorrection/findPreviousAssistantMessage)
// are no longer invoked directly from core.ts — the cognitive graph nodes call
// them. Only the SelectorDecision type survives here (used to type the
// procedure-selector node output below).
import { type SelectorDecision } from '@/cognition/procedure-selector.js';
import * as procedureEngine from '@/procedures/engine.js';
import { sendOutbound, safeDispatchOutput } from './output-dispatch.js';
import { executeSelectedSkill } from './execute-skill.js';
import { runSkill } from '@/skills/index.js';
import { skillsRepo, outboundMessagesRepo } from '@/db/repositories.js';
import { runReActLoop } from './react-loop.js';
import {
  runWithTenantContext,
  getCurrentTenant,
  getCurrentAgent,
  PRIMARY_TENANT_ID,
  PRIMARY_AGENT_ID,
  isPrimaryContext,
} from '@/db/tenant-context.js';
import { db } from '@/db/client.js';
import { mensagens } from '@/db/schema.js';
import { eq } from 'drizzle-orm';
import { runNodes } from '@/cognitive-graph/orchestrator.js';
import { buildPreturnNodes, type PreturnContext } from '@/cognitive-graph/preturn-graph.js';
import { buildPostturnNodes } from '@/cognitive-graph/postturn-graph.js';
// P9b — Decision Engine hot-path wiring
import {
  runDecisionEngineForTurn,
  DecisionEngineFailClosedError,
} from '@/runtime/decision/integration.js';
import {
  buildBaseContextPacketFromTurn,
  applyToolReductions,
} from '@/runtime/decision/build-base-context.js';

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
 * job per user (instead of enqueueing each message immediately), so
 * chunked typing arrives at the LLM as a single coherent turn. The job's
 * `mensagem_id` always points to the LATEST message at scheduling time;
 * when the worker fires, this function pulls older unprocessed siblings
 * for the same telefone and concatenates them in chronological order.
 *
 * **Two correctness gates — both required**:
 *
 * 1. **Feature flag**: when `FEATURE_MESSAGE_DEBOUNCE` is off, baileys
 *    enqueues one job per inbound. The first job's target is the FIRST
 *    chunk, not the last; aggregating here would (a) put the prompt in
 *    reverse order ("M2\nM1") and (b) mark M2 processed before its own
 *    job runs, causing the M2 job to early-return and never produce a
 *    turn. Off-flag must mean "one inbound, one turn" — period.
 *
 * 2. **`created_at <= target.created_at`**: even on-flag, never aggregate
 *    siblings that are NEWER than the target. This protects against:
 *      - `message-recovery` requeueing an old-stuck message: target is
 *        ancient, but younger siblings shouldn't get folded in.
 *      - DLQ replay of an old job: same shape.
 *      - Race with a brand-new inbound that arrived in the window
 *        between job dispatch and worker pickup.
 *
 * Sibling lookup is keyed by **telefone** (`metadata->>'telefone'`), not
 * conversa_id: baileys persists every inbound with `conversa_id = NULL`
 * and resolution happens here in `runAgentForMensagem`. Earlier chunks
 * from the same burst are still NULL-attached when this runs, so a
 * conversa_id query would silently miss them.
 *
 * We accept orphans (conversa_id NULL — caller adopts them) OR already-
 * attached siblings whose conversa_id matches. Cross-conversation
 * leakage isn't a real concern (telefone ↔ pessoa ↔ conversa is 1:1)
 * but the filter documents the intent.
 *
 * Only `tipo = 'texto'` is merged. Media bypasses the debouncer
 * upstream (see `baileys.handleIncoming`).
 */
async function aggregateUnprocessedTexts(target: Mensagem): Promise<{
  text: string;
  merged_ids: string[];
}> {
  const targetText = target.conteudo ?? '';

  // Gate 1: off-flag → no aggregation. Each inbound is its own turn.
  if (!config.FEATURE_MESSAGE_DEBOUNCE) return { text: targetText, merged_ids: [] };

  const tel = (target.metadata as Record<string, unknown> | null)?.['telefone'];
  if (typeof tel !== 'string' || tel.length === 0) {
    return { text: targetText, merged_ids: [] };
  }

  const siblings = await mensagensRepo.listUnprocessedByTelefone(tel, {
    excludeId: target.id,
  });

  // Gate 2: only siblings strictly older than (or equal to) the target.
  // `created_at` is timestamptz; getTime() gives ms epoch. Falsy guard
  // covers the rare null path (db rows always have created_at, but TS
  // sees it as Date | null on some inferred shapes).
  const targetMs = target.created_at?.getTime() ?? Date.now();

  const textSiblings = siblings.filter(
    (m) =>
      m.tipo === 'texto' &&
      (m.conteudo ?? '').length > 0 &&
      (m.created_at?.getTime() ?? 0) <= targetMs &&
      (m.conversa_id === null || m.conversa_id === target.conversa_id),
  );
  if (textSiblings.length === 0) return { text: targetText, merged_ids: [] };

  // Chronological order: oldest sibling first, target last.
  const parts = textSiblings.map((m) => m.conteudo ?? '');
  const merged = [...parts, targetText].filter((s) => s.length > 0).join(AGGREGATE_SEPARATOR);
  return { text: merged, merged_ids: textSiblings.map((m) => m.id) };
}

/**
 * Returns a stopper. The stopper either cancels the pending start (if called
 * within TYPING_DEBOUNCE_MS) or calls handle.stop() (if typing already started).
 *
 * Fase 0 (spec roteamento v4 §1.6): o typing (efêmero) sai pela fronteira
 * `LineOutput` do canal da conversa. A resolução é assíncrona dentro do timer
 * (ALS propaga por setTimeout); falha de resolução só suprime o typing —
 * nunca derruba o turno (best-effort, como sempre foi).
 */
function scheduleTypingDebounce(
  jid: string,
  mensagem_id: string,
  channel_id: string | null = null,
): () => void {
  let handle: TypingHandle | null = null;
  let stopped = false;
  const timer = setTimeout(() => {
    forCurrentAgentChannel(channel_id)
      .then((line) => {
        if (stopped) return;
        handle = line.startTyping(jid, mensagem_id);
      })
      .catch((err) =>
        logger.debug({ err: (err as Error).message }, 'agent.typing_line_unresolved'),
      );
  }, TYPING_DEBOUNCE_MS);
  return () => {
    stopped = true;
    clearTimeout(timer);
    handle?.stop();
  };
}

export const _internal = { scheduleTypingDebounce, sendOutbound, aggregateUnprocessedTexts };

/**
 * Probe-only cross-tenant read of `mensagens.metadata` for the channel resolver.
 *
 * P6 Task 9: roda ANTES de `runWithTenantContext`, portanto bypassa
 * `applyTenantGuard` deliberadamente (mesma justificativa do
 * `channelsRepo.findByExternalCrossTenant` — entry point precisa descobrir
 * qual tenant antes de poder operar dentro dele).
 *
 * Retorna apenas o suficiente para chamar `resolveChannel`.
 *
 * ── [🔴 HIGH fix #417] distinguir "sem telefone" de "erro de DB" ───────────
 * `null` significa EXCLUSIVAMENTE "não há telefone para resolver" (linha
 * ausente ou `metadata.telefone` vazio). Esse é o ÚNICO caso que legitimamente
 * preserva o legacy `default/default` (o inner retorna cedo para mensagens sem
 * telefone, sem nunca resolver tenant nenhum).
 *
 * Um ERRO DE DB no probe NÃO pode colapsar para `null` — antes deste fix, o
 * blanket `catch { return null }` mapeava uma falha transitória de leitura para
 * o mesmo `null` de "sem telefone". Como o caller só roda o resolver quando o
 * probe é truthy, uma falha de DB pulava resolver+adoção e roteava uma mensagem
 * POSSIVELMENTE multi-tenant para o bucket `default/default` — silenciosamente
 * violando o fail-closed (#268). Agora um erro de DB é re-lançado como
 * `TypedError('channel_probe_failed')`: o caller audita `channel_resolution_failed`
 * e re-lança → BullMQ aplica retry/DLQ (fail-closed).
 */
async function probeMessageForChannel(
  mensagem_id: string,
): Promise<{
  channel_type: 'whatsapp';
  external_id: string;
  bot_line_external_id: string | null;
} | null> {
  let rows: Array<{ metadata: unknown }>;
  try {
    rows = await db
      .select({ metadata: mensagens.metadata })
      .from(mensagens)
      .where(eq(mensagens.id, mensagem_id))
      .limit(1);
  } catch (err) {
    // DB read failure — fail-closed. Do NOT collapse to the "no telefone" null;
    // that would route a possibly-multi-tenant message to default/default.
    throw new TypedError(
      'channel_probe_failed',
      'failed to read mensagens.metadata for channel probe (DB error) — failing closed',
      {
        mensagem_id,
        resolver_path: 'probe_db_error',
        cause: (err as Error).message,
      },
    );
  }
  // Below this point: a successful read. `null` now means strictly "no telefone
  // to resolve" → caller keeps legacy default/default (inner returns early).
  if (rows.length === 0) return null;
  const md = (rows[0]!.metadata ?? {}) as Record<string, unknown>;
  const tel = typeof md['telefone'] === 'string' ? (md['telefone'] as string) : null;
  if (!tel) return null;
  // §1.1 (spec roteamento v4) — a LINHA que recebeu (carimbada pelo ingress).
  // Rows antigas não a têm ⇒ null ⇒ resolução legada (shadow sem comparação).
  const botLine =
    typeof md['bot_line_external_id'] === 'string'
      ? (md['bot_line_external_id'] as string)
      : null;
  return { channel_type: 'whatsapp', external_id: tel, bot_line_external_id: botLine };
}

/**
 * Best-effort `clearDebounceState` wrapper for the post-turn cleanup
 * callsites in this file. The debouncer's fail-closed contract (PR #259
 * review) means `clearDebounceState` THROWS on a Redis blip — exactly
 * the right behavior at the SCHEDULE entry-point (caller in
 * `baileys.ts` must stop, not silently bypass the tenant-scoped
 * debounce). At the CLEAR-after-turn callsites in core.ts, however, the
 * agent has already done its work: dispatched the reply, persisted state,
 * audited the turn. Propagating the throw here would only cause BullMQ
 * to retry the entire turn (idempotent thanks to the dispatched-message
 * dedup, but wasteful) and the next debounce window self-heals via the
 * 10-minute Redis TTL on the state key.
 *
 * Swallow the throw + log it, so a Redis outage during cleanup is
 * visible to operators (via `agent.clear_debounce_failed`) without
 * cratering the turn. Schedule-path callers (`scheduleDebouncedAgent`)
 * must NOT use this wrapper.
 */
async function clearDebounceState(phone: string): Promise<void> {
  try {
    await clearDebounceStateRaw(phone);
  } catch (err) {
    logger.warn(
      {
        err: (err as Error).message,
        err_code: (err as { code?: string }).code,
        phone: '[REDACTED]',
      },
      'agent.clear_debounce_failed',
    );
  }
}

export async function runAgentForMensagem(mensagem_id: string): Promise<void> {
  // P6 Task 9 + issue #268 (fail-loud) + issue #411 (single-tenant catch-all):
  // roteamento via channel resolver. O resolver SEMPRE roda (MULTI_CHANNEL
  // removido — sempre ON após #411).
  //
  // Probe lê `metadata.telefone` (o remetente). Dois desfechos:
  //   - probe OK → `resolveChannel`:
  //       · single-tenant (nenhum canal de outro tenant) → o resolver mapeia
  //         qualquer remetente para o canal catch-all `default/default` semeado
  //         (issue #411 — o bot volta a responder a TODOS).
  //       · multi-tenant: exact-match casa → tenant/agent reais; miss/inativo/
  //         ambíguo → o resolver LANÇA TypedError. Auditamos
  //         `channel_resolution_failed` e re-lançamos. BullMQ trata como job
  //         failure → retry → DLQ. Preserva o #268 (sem colapso no bucket
  //         compartilhado `maia:ratelimit:default:default:*`).
  //   - probe null (mensagem sem telefone) → mantemos `default/default` e
  //     seguimos: o inner (`runAgentForMensagemInner`) já trata o caso "sem
  //     telefone" retornando cedo. Mesmo comportamento do path legacy
  //     single-tenant pré-#411 para mensagens sem telefone.
  //   - probe LANÇA (erro de DB → `TypedError('channel_probe_failed')`)
  //     [🔴 HIGH fix #417]: NÃO colapsa para default/default. Cai no catch
  //     abaixo → audita `channel_resolution_failed` (error_code:
  //     channel_probe_failed) → re-lança → BullMQ retry/DLQ (fail-closed). Antes
  //     deste fix uma falha transitória de DB no probe virava `null` e roteava
  //     uma mensagem possivelmente multi-tenant para o bucket default/default.
  let resolved: { tenant_id: string; agent_id: string; channel_id: string | null } = {
    tenant_id: PRIMARY_TENANT_ID,
    agent_id: PRIMARY_AGENT_ID,
    channel_id: null,
  };

  {
    let probe: {
      channel_type: 'whatsapp';
      external_id: string;
      bot_line_external_id: string | null;
    } | null = null;
    try {
      probe = await probeMessageForChannel(mensagem_id);
      // probe null → no telefone metadata. Keep default/default and let the
      // inner function handle the missing-telefone case (it returns early).
      // This matches the legacy single-tenant behavior for telefone-less rows
      // and never reaches the resolver, so it cannot collapse cross-tenant
      // buckets (no tenant was resolved).
      if (probe) {
        resolved = await resolveChannel(probe);
      }
    } catch (err) {
      const typed = err as { code?: string; details?: unknown };
      // Audit emitted at the caller level so the row carries `mensagem_id` +
      // whatever probe context we collected. `audit()` wraps in synthetic
      // `system` tenant context when none is active (we don't have one yet —
      // we ARE the entry point).
      await audit({
        acao: 'channel_resolution_failed',
        mensagem_id,
        metadata: {
          error_code: typed?.code ?? 'unknown',
          error_message: (err as Error).message,
          probe_external_id: probe?.external_id ?? null,
          probe_channel_type: probe?.channel_type ?? null,
          resolver_details: typed?.details ?? null,
        },
      });
      logger.warn(
        { mensagem_id, err: (err as Error).message },
        'agent.channel_resolution_failed_throw',
      );
      // Propagate: the agent worker (BullMQ) will mark the job failed and
      // apply the configured retry/DLQ policy. We do NOT fall back to
      // default/default — that's exactly the bypass issue #268 closed (and the
      // resolver only throws here in a genuine multi-tenant deployment).
      throw err;
    }

    // [Codex review #277] Adoption helper — bridge the baileys/resolver gap.
    //
    // The gateway persists each inbound under the RESOLVED scope; in the
    // single-tenant runtime that is the `primary/primary` baseline (issue #323).
    // If a row is still under that unclaimed baseline while a REAL tenant was
    // resolved here, the inner findById (tenant-scoped) would return null and
    // the turn would silently drop — functionally identical to the bug issue
    // #268 closed. Adoption re-homes the row to the resolved triplet first.
    //
    // Adoption bypasses the tenant guard via `adoptToResolvedTenantCrossTenant`
    // — same sanctioned pattern as `channelsRepo.findByExternalCrossTenant`:
    // the entry point legitimately operates without a tenant context (it is
    // the one DISCOVERING which tenant owns the row). Once adopted, all
    // downstream reads inside `runWithTenantContext` see the resolved triplet.
    //
    // [Codex review #311 — CRITICAL P0 cross-tenant adoption race]
    // Adoption is a COMPARE-AND-SWAP: the repo UPDATE only matches a row still
    // in the `primary/primary` baseline, and reports whether THIS call won.
    //   - won === true  → we moved the row out of primary/primary into the
    //                     resolved triplet. Proceed.
    //   - won === false → the row was NOT `primary/primary` when we tried.
    //                     Either (a) WE already adopted it on a prior BullMQ
    //                     retry (idempotent — owner == resolved), or (b) a
    //                     CONCURRENT worker adopted it into a DIFFERENT tenant
    //                     (the race this review closed). We re-check the owner
    //                     cross-tenant and ONLY proceed when it matches the
    //                     tenant we resolved. If it belongs to another tenant
    //                     we abort + audit and do NOT run the turn under our
    //                     context — processing it would be the exact
    //                     cross-tenant leak the inviolable isolation contract
    //                     forbids. (Throwing lets BullMQ apply retry/DLQ; the
    //                     retry will simply re-observe the foreign owner and
    //                     abort again — it never leaks.)
    if (!isPrimaryContext(resolved)) {
      const won = await mensagensRepo.adoptToResolvedTenantCrossTenant({
        id: mensagem_id,
        tenant_id: resolved.tenant_id,
        agent_id: resolved.agent_id,
        channel_id: resolved.channel_id,
      });
      if (!won) {
        const owner = await mensagensRepo.findOwnerByIdCrossTenant(mensagem_id);
        const ownsResolved =
          owner !== null &&
          owner.tenant_id === resolved.tenant_id &&
          owner.agent_id === resolved.agent_id;
        if (!ownsResolved) {
          // Cross-tenant adoption race (or vanished row). Fail-closed: audit
          // under the synthetic system context (we hold no ALS yet) and
          // re-throw so the worker does NOT process the row under a tenant it
          // does not own. We deliberately do not surface the foreign owner's
          // tenant/agent in logs beyond the audit row to keep the leak
          // surface minimal.
          await audit({
            acao: 'channel_resolution_failed',
            mensagem_id,
            metadata: {
              error_code: 'cross_tenant_adoption_conflict',
              error_message:
                'inbound row was not adopted into the resolved tenant (already owned by a different tenant or missing) — refusing to process cross-tenant',
              resolved_tenant_id: resolved.tenant_id,
              resolved_agent_id: resolved.agent_id,
              owner_present: owner !== null,
            },
          });
          logger.error(
            { mensagem_id },
            'agent.cross_tenant_adoption_conflict',
          );
          throw new TypedError(
            'channel_resolution_failed',
            'cross_tenant_adoption_conflict',
            { mensagem_id, resolver_path: 'adoption_conflict' },
          );
        }
        // owner == resolved → idempotent re-run (we adopted it earlier).
        logger.debug(
          { mensagem_id },
          'agent.adoption_noop_already_owned',
        );
      }
    }
  }

  await runWithTenantContext(
    { tenant_id: resolved.tenant_id, agent_id: resolved.agent_id },
    () => runAgentForMensagemInner(mensagem_id, resolved.channel_id),
  );
}

async function runAgentForMensagemInner(
  mensagem_id: string,
  channel_id: string | null = null,
): Promise<void> {
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
    // Fase 0 (spec roteamento v4 §1.6): a identidade da conversa inclui o
    // canal — o resolver casa/cria a conversa DO canal que recebeu o inbound.
    const resolved = await resolveIdentity({ telefone_whatsapp: tel, channel_id });
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

  // P1 reflection trigger: success detection now runs exclusively in the
  // post-turn `success-reflection` graph node (fire-and-forget, ASYNC layer).
  // The pre-turn imperative trigger was removed with FEATURE_COGNITIVE_GRAPH
  // (issue #412). Timing shifted from before-ReAct to after-ReAct, but both
  // are fire-and-forget over the same post-aggregation `inbound.conteudo` and
  // neither touches the user-facing reply — only DB write ordering changed.
  // See src/cognitive-graph/postturn-graph.ts.

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
      await sendOutbound(pessoa.id, c.id, reply, inbound.id, {
        channel_id: c.channel_id,
      }).catch((err) =>
        logger.warn({ err: (err as Error).message }, 'agent.rate_limit_reply_failed'),
      );
    }
    await markAllProcessed(0);
    await conversasRepo.touch(c.id);
    await clearDebounceState(pessoa.telefone_whatsapp);
    return;
  }

  // Fase 0 cap. 3 — respostas de aprovação ("aprova AP-xxxxxxxx") são
  // governança DETERMINÍSTICA: o humano é identificado pela linha WhatsApp
  // autenticada e a decisão vai direto ao store backend (migration 095). O
  // LLM nunca vê nem intermedeia a decisão — prompt injection não alcança.
  if (typeof inbound.conteudo === 'string') {
    const approvalReply = parseApprovalReply(inbound.conteudo);
    if (approvalReply) {
      const outcome = await recordApprovalDecision({
        refPrefix: approvalReply.refPrefix,
        approver: pessoa,
        decision: approvalReply.decision,
      });
      await sendOutbound(pessoa.id, c.id, formatDecisionOutcome(outcome), inbound.id, {
        channel_id: c.channel_id,
      }).catch((err) =>
        logger.warn({ err: (err as Error).message }, 'agent.approval_reply_send_failed'),
      );
      await markAllProcessed(0);
      await conversasRepo.touch(c.id);
      await clearDebounceState(pessoa.telefone_whatsapp);
      return;
    }
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
  // 'unresolved' and 'no_pending' fall through.

  // Blocker 9 — Scheduling inbound hook (spec 18 §7.4). When the inbound
  // is a text from someone who has at least one `recurring_outreach`
  // occurrence in `awaiting_third_party`, try to attach the response.
  // Three outcomes:
  //  - routed: response captured, occurrence advances; we DON'T short-
  //    circuit the LLM turn (the LLM can still acknowledge to the sender).
  //  - disambiguation_requested: owner was prompted; we still let the LLM
  //    answer the sender so they don't get silence.
  //  - no_match: no scheduling state cares about this inbound; continue.
  // PR #406: Scheduling V2 collapsed to always-on (FEATURE_SCHEDULING_V2 removed).
  if (inbound.tipo === 'texto' && inbound.conteudo) {
    try {
      const { captureInboundForOutreach } = await import('@/scheduling/disambiguation.js');
      const ownerId = config.OWNER_TELEFONE_WHATSAPP;
      const owner = await (await import('@/db/repositories.js')).pessoasRepo.findByPhone(ownerId);
      if (owner) {
        await captureInboundForOutreach({
          sender: pessoa,
          inbound,
          owner_pessoa_id: owner.id,
        });
      }
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, mensagem_id: inbound.id },
        'agent.scheduling_inbound_hook_failed',
      );
    }
  }

  const scope = await resolveScope(pessoa);

  // Issue #407/#409 — resolve the per-agent AudienceContext for this turn so the
  // SkillUsagePolicy gates (SkillSelector candidate filter + SkillRunner gate
  // 4.6) can admit/remove skills by audience. Governance-derived (invariant #3),
  // never LLM-declared. Best-effort: a lookup failure leaves `audienceContext`
  // null — the early filter is then skipped (no audience to admit against) and
  // the runner gate 4.6 (also audience-gated) is skipped too, so the turn is NOT
  // broken by a transient audience-store hiccup; the conservative defaults still
  // apply once an audience is present.
  let audienceContext: AudienceContext | null = null;
  try {
    const audienceProfile = await agentAudienceProfilesRepo.findByPessoa(pessoa.id);
    audienceContext = buildAudienceContext({
      pessoa,
      profile: audienceProfile,
      allowed_entity_ids: scope.entidades ?? [],
    });
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, pessoa_id: pessoa.id },
      'agent.audience_resolution_failed_proceeding',
    );
  }

  // P3b Task 9 / P6 Task 9 / P7 Task 8 — PRE-TURN cognitive modules:
  // resolve procedure-selector + role-selector (role-selector runs whenever a
  // channel_id is present — MULTI_CHANNEL removed / always on after #411).
  //
  // Orquestração SEMPRE declarativa via `runNodes(buildPreturnNodes(...))`
  // (FEATURE_COGNITIVE_GRAPH removida em #412 — o grafo é o único caminho).
  // Side effects de DB (record decision, start/abort execution, etc.) acontecem
  // APÓS o grafo retornar, lendo `result.nodes[name].output` — mantém paridade
  // byte-por-byte com o path imperativo legacy pré-#412.
  //
  // Procedure runtime nunca pode derrubar o baseline ReAct turn. Failures
  // só deixam `activeExecution=null` / `activeRole=null`.
  let activeExecution: ProcedureExecution | null = null;
  let activeRole: Role | null = null;
  // [P88-C4] Mensagem opcional anunciando troca de role (lida pela react-loop
  // como outboundPrefix). Permanece null quando não há troca ou quando a
  // policy do canal pede silêncio (announce_mode=never). Populada abaixo a
  // partir do output do node role-selector (só roda sob MULTI_CHANNEL).
  let roleAnnouncement: string | null = null;

  // #411 (MULTI_CHANNEL removed / always on): `multi_channel_on` é passado como
  // `true`; o node role-selector é gated downstream por `ctx.role_inputs !==
  // undefined` (que por sua vez exige channel_id resolvido + policy), então
  // passar true aqui apenas mantém o node disponível e deixa `buildRoleInputs`
  // decidir por turno.
  try {
    activeExecution = await procedureExecutionsRepo.findActiveForConversa(c.id);
    const role_inputs = await buildRoleInputs(channel_id);
    const nodes = buildPreturnNodes({ multi_channel_on: true });
    const ctx: PreturnContext = {
      conversa_id: c.id,
      turno_id: inbound.id,
      inbound_text: inbound.conteudo ?? '',
      current_execution: activeExecution
        ? {
            id: activeExecution.id,
            definition_id: activeExecution.definition_id,
            status: activeExecution.status,
          }
        : null,
      ...(role_inputs ? { role_inputs } : {}),
    };
    const result = await runNodes(nodes, ctx);

    // Side effects POST-graph — procedure-selector decision + start/switch.
    const selectorOutput = result.nodes['procedure-selector']?.output as
      | SelectorDecision
      | null;
    if (selectorOutput) {
      await procedureSelectorDecisionsRepo
        .record({
          conversa_id: c.id,
          turno_id: inbound.id,
          current_execution_id: activeExecution?.id ?? null,
          candidates: selectorOutput.candidates as unknown,
          conflicts: selectorOutput.conflicts as unknown,
          decision: selectorOutput.decision,
          selected_procedure_id: selectorOutput.selected_procedure_id ?? null,
          decided_by: 'selector_llm',
          reason: selectorOutput.reason,
        } as never)
        .catch((err) =>
          logger.warn(
            { err: (err as Error).message },
            'procedure.selector_decision.persist_failed',
          ),
        );

      // P7 parity (issue #412): the procedure start/switch side-effects get
      // their OWN try/catch so a procedureEngine failure (startExecution /
      // abortExecution throw) does NOT skip the role-selector block below.
      // The legacy imperative path (pre-#412) isolated these: procedure
      // side-effects ran in a `try` that logged `procedure.preturn.failed`,
      // and role resolution ran in a SEPARATE `try` afterwards. Collapsing
      // them into the single outer `try` regressed that isolation — a
      // procedure-engine throw dropped activeRole + roleAnnouncement
      // (user-facing). Restore the boundary here.
      try {
        if (
          selectorOutput.decision === 'start' &&
          selectorOutput.selected_procedure_id
        ) {
          const def = await procedureDefinitionsRepo.findById(
            selectorOutput.selected_procedure_id,
          );
          if (def) {
            const steps = def.steps as unknown as Array<{ id: string }>;
            const { execution: started } = await procedureEngine.startExecution({
              definition_id: def.id,
              definition_version: def.version_number,
              conversa_id: c.id,
              first_step_id: steps[0]?.id ?? null,
            });
            activeExecution = started;
          }
        } else if (
          selectorOutput.decision === 'switch' &&
          selectorOutput.selected_procedure_id &&
          activeExecution
        ) {
          await procedureEngine.abortExecution({
            execution_id: activeExecution.id,
            reason: 'switched_by_selector',
          });
          const def = await procedureDefinitionsRepo.findById(
            selectorOutput.selected_procedure_id,
          );
          if (def) {
            const steps = def.steps as unknown as Array<{ id: string }>;
            const { execution: started } = await procedureEngine.startExecution({
              definition_id: def.id,
              definition_version: def.version_number,
              conversa_id: c.id,
              first_step_id: steps[0]?.id ?? null,
            });
            activeExecution = started;
          }
        }
      } catch (err) {
        logger.warn(
          { err: (err as Error).message, conversa_id: c.id },
          'procedure.start_failed',
        );
      }
    }

    // Role-selector output (só presente quando MULTI_CHANNEL on E role_inputs
    // existe — ver buildPreturnNodes/buildRoleInputs). Mirror do path legacy:
    // seta activeRole e computa o anúncio de troca quando a policy pede.
    const roleResult = result.nodes['role-selector']?.output as
      | import('@/cognition/role-selector/engine.js').RoleSelectorResult
      | null;
    if (roleResult && role_inputs) {
      activeRole = roleResult.decided_role;
      // [P88-C4] Compute the optional switch announcement. Only emit when the
      // policy says so AND the role actually changed AND the new role brings a
      // user-facing addendum.
      if (
        roleResult.action === 'switch' &&
        roleResult.decided_role.id !== role_inputs.current_role.id
      ) {
        const announceMode = role_inputs.policy.announce_mode;
        const affectsUser =
          roleResult.decided_role.display_name !== role_inputs.current_role.display_name &&
          !!(roleResult.decided_role.prompt_addendum ?? '').trim();
        const shouldAnnounce =
          announceMode === 'always' ||
          (announceMode === 'affects_user' && affectsUser);
        if (shouldAnnounce) {
          roleAnnouncement = `_(Mudando para o modo ${roleResult.decided_role.display_name}.)_`;
        }
      }
    }
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, conversa_id: c.id },
      'preturn.graph_failed',
    );
  }

  // Prompt assembly via the prompt-builder. The FEATURE_CONTEXT_PACKET_V1
  // "context packet" path was an unwired stub — its history loader returned
  // zero turns, which would have dropped ALL conversation history — so the hot
  // path always uses buildPrompt.
  const tenantId = getCurrentTenant();
  const { system, messages } = await buildPrompt({
    pessoa,
    conversa: c,
    scope,
    inbound,
    activeRole,
    activeExecution,
  });

  // Issue #408 — Runtime Tool Filter. Composes the AGENT grant
  // (agent_tool_grants: baseline.core ∪ packs ∪ tools − denied) with the HUMAN
  // permission view + feature flags, and audits the provenance
  // (`tool_visibility_resolved`). An agent without a domain pack sees only the
  // baseline floor; a denied tool is invisible (and the dispatcher refuses it).
  // The SKILL scope is applied below via the decision packet's tool_permissions
  // (`applyToolReductions`); the audience/data_scope/risk layer is #409.
  const visibility = await computeRuntimeVisibleTools({
    byEntity: scope.byEntity,
    // Issue #437 — thread the resolved active operational role so its
    // `granted_packs` (roles.granted_packs) narrow the LLM-visible tool set
    // (capability-taxonomy §2 step 7: agent grant ∩ active-role packs ∩ skill
    // scope). Absent ⇒ no role narrowing (role-agnostic / legacy turn).
    ...(activeRole ? { activeRoleKey: activeRole.role_key } : {}),
    audit_context: { pessoa_id: pessoa.id, conversa_id: c.id, mensagem_id: inbound.id },
  });
  let tools = visibility.tools;

  // Issue #478 — anexa tools MCP aprovadas+concedidas (flag MCP_TOOLS,
  // default OFF). Fail-soft: erro na visibilidade MCP nunca derruba o turno
  // (o helper retorna [] e loga). O dispatcher revalida tudo na execução.
  const mcpTools = await mcpVisibleToolSchemas();
  if (mcpTools.length > 0) tools = [...tools, ...mcpTools];

  // P11 — Decision Engine gate: always runs BEFORE the LLM call. The engine
  // gates the turn (block/escalate short-circuit) and tool_reductions are
  // applied to the toolSet; an engine error fails closed (see catch below).
  try {
    const baseCtx = buildBaseContextPacketFromTurn({
      inbound,
      conversa: c,
      pessoa,
      tenant_id: tenantId,
      agent_id: getCurrentAgent(),
      channel_id,
      active_procedure_execution_id: activeExecution?.id ?? null,
      // Issue #415/#416 — thread the resolved active operational role key
      // (`decided_role.role_key`, set above from the role-selector chain) so the
      // Decision Engine's SkillSelector applies the role → skill scope
      // (`applicable_to_role`). No role resolved ⇒ omitted (role-agnostic turn;
      // role-bound skills are not selected — fail-closed).
      ...(activeRole ? { active_role_key: activeRole.role_key } : {}),
      // Issue #409 — feed the resolved audience so the Decision Engine's
      // SkillSelector candidate filter admits/removes skills by audience.
      ...(audienceContext
        ? {
            audience: {
              audience_type: audienceContext.audience_type,
              trust_level: audienceContext.trust_level,
            },
          }
        : {}),
    });
    const deResult = await runDecisionEngineForTurn(baseCtx);
    if (deResult.engine_ran && deResult.result) {
      const { packet, block } = deResult.result;

      // Honor decision outcome: block and approval flows short-circuit the turn.
      if (block) {
        // 'block' or 'escalate' from a PEP → reply to user and skip LLM.
        // Never expose internal policy text (effect.message) to the user.
        const blockMsg = 'Esta ação requer aprovação adicional antes de prosseguir.';
        await sendOutbound(pessoa.id, c.id, blockMsg, inbound.id, {
          channel_id: c.channel_id,
        }).catch((err) =>
          logger.warn({ err: (err as Error).message }, 'agent.decision_engine.blocked_reply_failed'),
        );
        await markAllProcessed(0);
        await conversasRepo.touch(c.id);
        await clearDebounceState(pessoa.telefone_whatsapp);
        return;
      }

      // action_mode='escalate' without a hard block → still escalate (dual-approval path)
      // Fase 0 cap. 3 — o texto NÃO promete notificação: este caminho apenas
      // bloqueia o turno; o request de aprovação persistido (com notificação
      // real aos aprovadores) é criado pelo dispatcher quando a tool é
      // efetivamente proposta. Prometer "o responsável será notificado" aqui
      // era mentira operacional (audit P0 cap. 3).
      if (packet.action_mode === 'escalate') {
        const escalateMsg =
          'Esta ação requer aprovação adicional antes de prosseguir.';
        await sendOutbound(pessoa.id, c.id, escalateMsg, inbound.id, {
          channel_id: c.channel_id,
        }).catch((err) =>
          logger.warn({ err: (err as Error).message }, 'agent.decision_engine.escalate_reply_failed'),
        );
        await markAllProcessed(0);
        await conversasRepo.touch(c.id);
        await clearDebounceState(pessoa.telefone_whatsapp);
        return;
      }

      // action_mode='ask_clarification' → fall through to the LLM so casual
      // conversation is not hijacked by a canned reply. The LLM produces the
      // clarifying question (or a free-form answer) from the full prompt context.

      // action_mode='execute_skill' (F1 Phase 1) → run the selected
      // prompt_only/evaluator skill via runSkill and deliver its reply through
      // dispatchOutput. The execution_mode gate lives in ActionDecider; here we
      // enforce the immutable-identity assert (re-resolve by descriptor under
      // the routed agent; pinned id+version must still match) and the safe
      // fall-through contract — a !ok / identity-mismatch / no-reply skill
      // degrades to the normal LLM/ReAct turn (prompt_only/evaluator have no
      // side effects, so this can't double-act).
      if (packet.action_mode === 'execute_skill') {
        const replyJid =
          typeof (inbound.metadata as Record<string, unknown> | null)?.['remote_jid'] === 'string' &&
          ((inbound.metadata as Record<string, unknown>)['remote_jid'] as string).length > 0
            ? ((inbound.metadata as Record<string, unknown>)['remote_jid'] as string)
            : pessoa.telefone_whatsapp.replace('+', '') + '@s.whatsapp.net';
        const routedAgentId = packet.routing.agent_id;
        const pinned =
          packet.routing.selected_skill_descriptor !== undefined &&
          packet.routing.selected_skill_version !== undefined &&
          packet.routing.selected_skill_id !== undefined
            ? {
                selected_skill_descriptor: packet.routing.selected_skill_descriptor,
                selected_skill_version: packet.routing.selected_skill_version,
                selected_skill_id: packet.routing.selected_skill_id,
              }
            : null;
        const outcome = await executeSelectedSkill(
          {
            pinned,
            routedAgentId,
            pessoa,
            conversa: c,
            inbound,
            jid: replyJid,
            aggregatedText: inbound.conteudo ?? '',
            // Issue #409 — forward the resolved audience + channel + scored risk
            // so the SkillRunner gate 4.6 re-evaluates the skill's usage_policy
            // at execution time (fail-closed TOCTOU re-check). Built from the
            // SAME AudienceContext the early candidate filter used.
            ...(audienceContext
              ? {
                  audience: {
                    audience_type: audienceContext.audience_type,
                    trust_level: audienceContext.trust_level,
                    channel_type: baseCtx.channel.kind,
                    allowed_data_scope: allowedDataScopesForAudience(
                      audienceContext.audience_type,
                      audienceContext.trust_level,
                    ),
                    risk_level: packet.risk_profile.level,
                  },
                }
              : {}),
          },
          {
            resolveActiveSkill: async (descriptor, agent_id) => {
              try {
                // findActive throws agent_scope_violation when the routed agent
                // differs from the current tenant-context agent — treat that
                // (and any lookup error) as "not the pinned skill" so we fall
                // through safely rather than executing a divergent row.
                const row = await skillsRepo.findActive(descriptor, agent_id);
                if (row) return { id: row.id, version: row.version };
                // Q3-A (Codex #216 review item 5): a tenant-wide skill
                // (agent_id IS NULL) can be SELECTED (selection unions IS NULL)
                // but is intentionally NOT executable yet — this re-resolution
                // scopes to the EXACT routed agent, which never matches IS NULL.
                // Probe explicitly so the block is a VISIBLE "deferred pending
                // #218 (tenant-wide isolation proof)" rather than a silent
                // fall-through. We still return null (do NOT execute it).
                const tenantWide = await skillsRepo.findActive(descriptor, null);
                if (tenantWide) {
                  logger.warn(
                    { skill_descriptor: descriptor, agent_id },
                    'skill.tenant_wide_not_executable_pending_218',
                  );
                }
                return null;
              } catch (e) {
                logger.warn(
                  { err: (e as Error).message, skill_descriptor: descriptor, agent_id },
                  'skill.identity_resolve_failed',
                );
                return null;
              }
            },
            runSkill,
            safeDispatchOutput,
            // #227 per-turn guard (Improvement 2). Thin wrapper over
            // outboundMessagesRepo.findByKey using the turn-scoped key the
            // ledger keys off. Tenant + agent are resolved from the current
            // context inside findByKey (no need to thread them here). The
            // skill-side guard fail-opens on throw, so we don't try/catch
            // here.
            findOutboundLedgerForTurn: ({ conversa_id, in_reply_to }) =>
              outboundMessagesRepo.findByKey(`${conversa_id}:${in_reply_to}`),
            logger,
          },
        );
        if (outcome.handled) {
          await markAllProcessed(0);
          await conversasRepo.touch(c.id);
          await clearDebounceState(pessoa.telefone_whatsapp);
          return;
        }
        // Not handled → fall through to the normal LLM/ReAct turn below. Cases:
        // identity mismatch / !ok / no reply (no side effects ran), OR
        // dispatch_send_failed — a send was ATTEMPTED but threw pre-delivery
        // (delivered:false), so nothing reached the user and ReAct can safely
        // answer without a double-send (Codex #216 HIGH-1).
      }

      // 'respond', 'call_tool', 'continue_workflow' → proceed to LLM with
      // possibly-reduced toolSet.
      if (packet.tool_permissions.blocked_tools.length > 0) {
        tools = applyToolReductions(tools, packet.tool_permissions);
      }
    }
  } catch (err) {
    if (err instanceof DecisionEngineFailClosedError) {
      // fail-closed: the always-on engine errored → block the turn, reply to
      // user, skip LLM (there is no legacy fallback path anymore)
      const failMsg = 'Sistema indisponível temporariamente. Tente novamente em alguns instantes.';
      await sendOutbound(pessoa.id, c.id, failMsg, inbound.id, {
        channel_id: c.channel_id,
      }).catch((e) =>
        logger.warn({ err: (e as Error).message }, 'agent.decision_engine.fail_closed_reply_failed'),
      );
      await markAllProcessed(0);
      await conversasRepo.touch(c.id);
      await clearDebounceState(pessoa.telefone_whatsapp);
      return;
    }
    // Unexpected error from the wiring itself (not the engine) → warn and continue
    logger.warn(
      { err: (err as Error).message },
      'agent.decision_engine.wiring_error_continuing',
    );
  }

  // Use the JID the inbound message arrived on so replies stay on the same
  // thread — critical when WhatsApp routes via `@lid` (privacy IDs) instead
  // of the raw `phone@s.whatsapp.net` form. Falls back to phone-derived JID.
  const inboundRemoteJid = (inbound.metadata as Record<string, unknown> | null)?.['remote_jid'];
  const jid =
    typeof inboundRemoteJid === 'string' && inboundRemoteJid.length > 0
      ? inboundRemoteJid
      : pessoa.telefone_whatsapp.replace('+', '') + '@s.whatsapp.net';
  const stopTyping = scheduleTypingDebounce(jid, inbound.id, c.channel_id);
  let totalTokens: number;
  let reactOutboundText: string;
  let reactToolsCalled: Array<{ name: string; result: unknown }>;
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
      // [P88-C4] Pass the precomputed role-switch announcement (if any) so
      // react-loop can prepend it to the final assistant text before dispatch.
      outboundPrefix: roleAnnouncement,
    });
    totalTokens = result.totalTokens;
    reactOutboundText = result.outboundText;
    reactToolsCalled = result.toolsCalled;
  } finally {
    stopTyping();
  }

  await markAllProcessed(totalTokens);
  await conversasRepo.touch(c.id);
  // Issue #73 — persist the scope hash for the *next* turn's sentinel check.
  // Merge (jsonb ||) instead of overwrite so concurrent writers don't clobber
  // unrelated metadata keys (e.g. pending_question). The hash itself is
  // last-writer-wins, which is fine: we want the freshest finished turn's
  // scope to be the baseline for comparison.
  try {
    await conversasRepo.mergeMetadata(c.id, {
      last_scope_hash: hashScope(scope),
      last_scope_hash_set_at: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, conversa_id: c.id },
      'agent.scope_hash_persist_failed',
    );
  }
  await clearDebounceState(pessoa.telefone_whatsapp);

  // P3b/P7 — POST-TURN cognitive modules (fire-and-forget) via the cognitive
  // graph. All three triggers — step-evaluator, correction-reflection,
  // success-reflection — run as ASYNC nodes inside the post-turn graph; each
  // has its own `runWhen` gate so a turn with no active execution / no
  // correction / no success signal does zero work. The FEATURE_COGNITIVE_GRAPH
  // dual-path (and the legacy imperative step-evaluator IIFE + standalone
  // correction trigger that double-fired with the graph) was collapsed in
  // issue #412 — the graph is now the sole path. Errors NEVER block the turn.
  // See src/cognitive-graph/postturn-graph.ts.
  void runNodes(buildPostturnNodes(), {
    conversa_id: c.id,
    turno_id: inbound.id,
    pessoa,
    conversa: c,
    inbound,
    response_text: reactOutboundText,
    tools_called: reactToolsCalled,
    // P7 parity (issue #412): the step-evaluator node passes only
    // { response_text, tools_called } to evaluateCurrentStep — matching the
    // legacy imperative IIFE exactly (it never passed `user_message`). We pass
    // active_execution_id so the step-evaluator runs only when there's
    // something to advance.
    active_execution_id: activeExecution?.id ?? null,
  });
}
/**
 * P7 Task 8 — helper file-local para montar `role_inputs` do PreturnContext.
 *
 * Mirror do bloco legacy de role-selection: só retorna inputs quando
 * channel_id presente E policy + roles disponíveis (MULTI_CHANNEL removido /
 * sempre on após #411). Caso contrário retorna undefined, e o node
 * role-selector é skipado via `runWhen=ctx.role_inputs !== undefined`.
 */
async function buildRoleInputs(
  channel_id: string | null,
): Promise<PreturnContext['role_inputs']> {
  if (!channel_id) return undefined;
  try {
    const policy = await channelPoliciesRepo.getByChannelId(channel_id);
    if (!policy) return undefined;
    const [availableRoles, currentRole] = await Promise.all([
      rolesRepo.listActive(),
      rolesRepo.getById(policy.default_role_id),
    ]);
    if (!currentRole || availableRoles.length === 0) return undefined;
    return { current_role: currentRole, available_roles: availableRoles, policy, channel_id };
  } catch (err) {
    logger.warn(
      { channel_id, err: (err as Error).message },
      'preturn.role_inputs_build_failed',
    );
    return undefined;
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
