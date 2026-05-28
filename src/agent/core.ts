import {
  mensagensRepo,
  conversasRepo,
  procedureExecutionsRepo,
  procedureDefinitionsRepo,
  procedureSelectorDecisionsRepo,
  channelPoliciesRepo,
  rolesRepo,
} from '@/db/repositories.js';
import { resolveScope } from '@/governance/permissions.js';
import { checkPendingFirst } from '@/agent/pending-gate.js';
import { checkRateLimit, formatPoliteReply } from '@/gateway/rate-limit.js';
import { resolveIdentity } from '@/identity/resolver.js';
import { handleQuarantineFirstContact, handleOwnerIdentityReply } from '@/identity/quarantine.js';
import { config } from '@/config/env.js';
import { featureFlags } from '@/config/feature-flags.js';
import { FeatureFlagName } from '@/types/enums.js';
import { clearDebounceState } from '@/gateway/debouncer.js';
import { buildPrompt } from './prompt-builder.js';
import { hashScope } from './scope-hash.js';
import { logger } from '@/lib/logger.js';
import { TypedError } from '@/lib/utils.js';
import type { Mensagem, ProcedureExecution, Role } from '@/db/schema.js';
import { resolveChannel } from '@/gateway/channel-resolver.js';
import { selectRole } from '@/cognition/role-selector/engine.js';
import { audit } from '@/governance/audit.js';
import { getToolSchemas } from '@/tools/_registry.js';
import { startTyping } from '@/gateway/presence.js';
import {
  detectCorrection,
  reflectOnCorrection,
  findPreviousAssistantMessage,
} from './reflection.js';
import { detectSuccess } from './success-detector.js';
import { reflect } from '@/cognition/reflector.js';
import { classify } from '@/cognition/classifier.js';
import { persistCandidate } from '@/cognition/persister.js';
import { recordSuccess } from '@/cognition/capability-tracker.js';
import { selectProcedure, type SelectorDecision } from '@/cognition/procedure-selector.js';
import { evaluateCurrentStep } from '@/cognition/step-evaluator.js';
import * as procedureEngine from '@/procedures/engine.js';
import { CognitiveEventType } from '@/types/enums.js';
import { sendOutbound, safeDispatchOutput } from './output-dispatch.js';
import { executeSelectedSkill } from './execute-skill.js';
import { runSkill } from '@/skills/index.js';
import { skillsRepo } from '@/db/repositories.js';
import { runReActLoop } from './react-loop.js';
import { runWithTenantContext, getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';
import { db } from '@/db/client.js';
import { mensagens } from '@/db/schema.js';
import { eq } from 'drizzle-orm';
import { runNodes } from '@/cognitive-graph/orchestrator.js';
import { buildPreturnNodes, type PreturnContext } from '@/cognitive-graph/preturn-graph.js';
import { buildPostturnNodes } from '@/cognitive-graph/postturn-graph.js';
// P8a context-packet dual-path (FEATURE_CONTEXT_PACKET_V1)
import { isContextPacketV1Enabled } from '@/runtime/feature-flags/context-packet-flag.js';
import { buildContextPacket } from '@/runtime/context-packet/build-context-packet.js';
import { buildPromptFromPacket } from '@/runtime/prompt/build-prompt-from-packet.js';
import { createDecisionPacketStub } from '@/runtime/context-packet/decision-packet-stub.js';
import { getProductionBuilderSet } from '@/runtime/context-packet/production-builder-set.js';
import type { BaseContextPacket } from '@/runtime/context-packet/types.js';
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

/**
 * Probe-only cross-tenant read of `mensagens.metadata` for the channel resolver.
 *
 * P6 Task 9: roda ANTES de `runWithTenantContext`, portanto bypassa
 * `applyTenantGuard` deliberadamente (mesma justificativa do
 * `channelsRepo.findByExternalCrossTenant` — entry point precisa descobrir
 * qual tenant antes de poder operar dentro dele).
 *
 * Retorna apenas o suficiente para chamar `resolveChannel`. Qualquer falha
 * (mensagem ausente, sem `metadata.telefone`, erro de DB) devolve null —
 * o caller cai em legacy default/default.
 */
async function probeMessageForChannel(
  mensagem_id: string,
): Promise<{ channel_type: 'whatsapp'; external_id: string } | null> {
  try {
    const rows = await db
      .select({ metadata: mensagens.metadata })
      .from(mensagens)
      .where(eq(mensagens.id, mensagem_id))
      .limit(1);
    if (rows.length === 0) return null;
    const md = (rows[0]!.metadata ?? {}) as Record<string, unknown>;
    const tel = typeof md['telefone'] === 'string' ? (md['telefone'] as string) : null;
    if (!tel) return null;
    return { channel_type: 'whatsapp', external_id: tel };
  } catch {
    return null;
  }
}

export async function runAgentForMensagem(mensagem_id: string): Promise<void> {
  // P6 Task 9 + issue #268 (fail-loud): roteamento via channel resolver.
  //
  // Quando MULTI_CHANNEL está OFF, opera direto em `default/default` (modo
  // legacy single-tenant — preservado de P0..P5). O resolver NÃO é chamado
  // nesse caminho.
  //
  // Quando MULTI_CHANNEL está ON, qualquer falha de resolução (probe sem
  // telefone, canal não registrado, canal inativo) AGORA é fatal: o resolver
  // levanta TypedError, este caller emite um audit `channel_resolution_failed`
  // (com contexto suficiente pra triagem) e re-lança. BullMQ trata como job
  // failure → retry policy → DLQ. Isso elimina o bypass do issue #268, em que
  // tenants distintos colapsavam no bucket compartilhado
  // `maia:ratelimit:default:default:*`.
  let resolved: { tenant_id: string; agent_id: string; channel_id: string | null } = {
    tenant_id: 'default',
    agent_id: 'default',
    channel_id: null,
  };

  if (featureFlags.isEnabled(FeatureFlagName.MULTI_CHANNEL)) {
    let probe: { channel_type: 'whatsapp'; external_id: string } | null = null;
    try {
      probe = await probeMessageForChannel(mensagem_id);
      if (!probe) {
        // Probe missing/incomplete metadata is also a resolution failure when
        // MULTI_CHANNEL is ON — without (channel_type, external_id) we can't
        // identify the tenant, and falling back to default/default would
        // collapse buckets cross-tenant.
        throw new TypedError(
          'channel_resolution_failed',
          'probe returned null — missing telefone metadata on inbound mensagem',
          { mensagem_id, resolver_path: 'probe_missing_metadata' },
        );
      }
      resolved = await resolveChannel(probe);
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
      // default/default — that's exactly the bypass issue #268 closed.
      throw err;
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

  // P1 reflection trigger: success detection (fire-and-forget, runs in
  // parallel with response generation). Sees the post-aggregation
  // `inbound.conteudo` so signals across chunked turns are captured.
  // Errors are swallowed — reflection MUST never block the user-facing reply.
  //
  // P7 Task 8 — quando FEATURE_COGNITIVE_GRAPH ON, este trigger é executado
  // pelo postturn-graph (mais abaixo) com semântica fire-and-forget equivalente.
  // Shift de timing: legacy roda ANTES do ReAct, graph roda APÓS o ReAct. Ambos
  // são fire-and-forget e não afetam o output user-facing — apenas a ordering
  // de gravação em DB muda, aceitável por não-regressão de comportamento.
  if (
    !featureFlags.isEnabled(FeatureFlagName.COGNITIVE_GRAPH) &&
    inbound.conteudo &&
    detectSuccess(inbound.conteudo)
  ) {
    const signal = inbound.conteudo;
    void (async () => {
      try {
        const event = {
          type: CognitiveEventType.SUCCESS_EXPLICIT,
          conversa_id: c.id,
          inbound_mensagem_id: inbound.id,
          signal,
          context_summary: '',
        } as const;
        const reflected = await reflect(event, { pessoa_id: pessoa.id });
        if (!reflected || !reflected.insight) return;
        const classified = await classify(reflected.insight);
        if (!classified) return;
        await persistCandidate(classified, event);
        // P2 Task 14: update self-model on explicit success. Domain extraction
        // is naive in P2 (default 'general'); P3+ refines via procedure context
        // or topic detection. recordSuccess swallows its own errors.
        await recordSuccess({ domain: 'general' });
      } catch (err) {
        logger.warn(
          { err: (err as Error).message, mensagem_id: inbound.id },
          'success.reflection.failed',
        );
      }
    })();
  }

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
  if (config.FEATURE_SCHEDULING_V2 && inbound.tipo === 'texto' && inbound.conteudo) {
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

  // P3b Task 9 / P6 Task 9 / P7 Task 8 — PRE-TURN cognitive modules:
  // resolve procedure-selector + role-selector (when MULTI_CHANNEL on).
  //
  // Dual-path: quando FEATURE_COGNITIVE_GRAPH ON, orquestração é declarativa
  // via `runNodes(buildPreturnNodes(...))`; OFF mantém path legacy intacto
  // (try/catch ad-hoc por módulo). Side effects de DB (record decision,
  // start/abort execution, etc.) acontecem APÓS o grafo retornar, lendo
  // `result.nodes[name].output` — mantém paridade byte-por-byte com legacy.
  //
  // Procedure runtime nunca pode derrubar o baseline ReAct turn. Failures
  // só deixam `activeExecution=null` / `activeRole=null`.
  let activeExecution: ProcedureExecution | null = null;
  let activeRole: Role | null = null;
  // [P88-C4] Mensagem opcional anunciando troca de role (lida pela react-loop
  // como outboundPrefix). Permanece null quando não há troca ou quando a
  // policy do canal pede silêncio (announce_mode=never). Ver path legacy
  // abaixo onde é populada.
  let roleAnnouncement: string | null = null;

  if (featureFlags.isEnabled(FeatureFlagName.COGNITIVE_GRAPH)) {
    // P7 path — orquestração via grafo declarativo.
    try {
      activeExecution = await procedureExecutionsRepo.findActiveForConversa(c.id);
      const role_inputs = await buildRoleInputs(channel_id);
      const nodes = buildPreturnNodes({
        multi_channel_on: featureFlags.isEnabled(FeatureFlagName.MULTI_CHANNEL),
      });
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

      // Side effects POST-graph — mesma semântica do path legacy.
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
      }

      const roleResult = result.nodes['role-selector']?.output as
        | { decided_role: Role }
        | null;
      if (roleResult) activeRole = roleResult.decided_role;
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, conversa_id: c.id },
        'preturn.graph_failed',
      );
    }
  } else {
    // LEGACY path (P0..P6) — intacto. NÃO REMOVER.
    try {
      activeExecution = await procedureExecutionsRepo.findActiveForConversa(c.id);
      const selectorResult = await selectProcedure({
        conversa_id: c.id,
        current_message: inbound.conteudo ?? '',
        current_execution: activeExecution
          ? {
              id: activeExecution.id,
              definition_id: activeExecution.definition_id,
              status: activeExecution.status,
            }
          : null,
      });

      await procedureSelectorDecisionsRepo
        .record({
          conversa_id: c.id,
          turno_id: inbound.id,
          current_execution_id: activeExecution?.id ?? null,
          candidates: selectorResult.candidates as unknown,
          conflicts: selectorResult.conflicts as unknown,
          decision: selectorResult.decision,
          selected_procedure_id: selectorResult.selected_procedure_id ?? null,
          decided_by: 'selector_llm',
          reason: selectorResult.reason,
        } as never)
        .catch((err) =>
          logger.warn(
            { err: (err as Error).message },
            'procedure.selector_decision.persist_failed',
          ),
        );

      if (
        selectorResult.decision === 'start' &&
        selectorResult.selected_procedure_id
      ) {
        const def = await procedureDefinitionsRepo.findById(
          selectorResult.selected_procedure_id,
        );
        if (def) {
          const steps = def.steps as unknown as Array<{ id: string }>;
          const firstStep = steps[0]?.id ?? null;
          const { execution: started } = await procedureEngine.startExecution({
            definition_id: def.id,
            definition_version: def.version_number,
            conversa_id: c.id,
            first_step_id: firstStep,
          });
          activeExecution = started;
        }
      } else if (
        selectorResult.decision === 'switch' &&
        selectorResult.selected_procedure_id &&
        activeExecution
      ) {
        await procedureEngine.abortExecution({
          execution_id: activeExecution.id,
          reason: 'switched_by_selector',
        });
        const def = await procedureDefinitionsRepo.findById(
          selectorResult.selected_procedure_id,
        );
        if (def) {
          const steps = def.steps as unknown as Array<{ id: string }>;
          const firstStep = steps[0]?.id ?? null;
          const { execution: started } = await procedureEngine.startExecution({
            definition_id: def.id,
            definition_version: def.version_number,
            conversa_id: c.id,
            first_step_id: firstStep,
          });
          activeExecution = started;
        }
      }
      // 'continue', 'escalate', 'none' → no engine action here. continue
      // keeps the existing activeExecution; escalate/none leave it null
      // (or unchanged) and the turn proceeds without a procedure.
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, conversa_id: c.id },
        'procedure.preturn.failed',
      );
    }

    // P6 Task 9: Resolve active role for this turn — only when flag ON AND
    // channel resolver returned a real channel_id. Failures degrade silently
    // to "no role section in prompt" — role injection is non-essential.
    if (featureFlags.isEnabled(FeatureFlagName.MULTI_CHANNEL) && channel_id) {
      try {
        const policy = await channelPoliciesRepo.getByChannelId(channel_id);
        if (policy) {
          const [availableRoles, currentRole] = await Promise.all([
            rolesRepo.listActive(),
            rolesRepo.getById(policy.default_role_id),
          ]);
          if (currentRole && availableRoles.length > 0) {
            const result = await selectRole({
              inbound_text: inbound.conteudo ?? '',
              current_role: currentRole,
              available_roles: availableRoles,
              policy,
              conversa_id: c.id,
              channel_id,
              turno_id: inbound.id,
            });
            activeRole = result.decided_role;
            // [P88-C4] Compute the optional switch announcement. Only
            // emit when the policy says so AND the role actually changed
            // AND the new role brings a user-facing addendum.
            if (
              result.action === 'switch' &&
              result.decided_role.id !== currentRole.id
            ) {
              const announceMode = policy.announce_mode;
              const affectsUser =
                result.decided_role.display_name !== currentRole.display_name &&
                !!(result.decided_role.prompt_addendum ?? '').trim();
              const shouldAnnounce =
                announceMode === 'always' ||
                (announceMode === 'affects_user' && affectsUser);
              if (shouldAnnounce) {
                roleAnnouncement = `_(Mudando para o modo ${result.decided_role.display_name}.)_`;
              }
            }
          }
        }
      } catch (err) {
        logger.warn(
          { channel_id, err: (err as Error).message },
          'agent.role_selection_failed_continuing_without_role',
        );
      }
    }
  }

  // P8a dual-path — FEATURE_CONTEXT_PACKET_V1 routes here when enabled.
  // When disabled (default) or when the packet path throws, falls back to
  // the legacy buildPrompt. This makes the flag operational in production
  // so the runbook kill-switch actually controls which builder fires.
  let system: string;
  let messages: import('@/lib/claude.js').LLMMessage[];

  const tenantId = getCurrentTenant();
  const usePacketPath = await isContextPacketV1Enabled(tenantId).catch(() => false);

  if (usePacketPath) {
    try {
      const agentId = getCurrentAgent();
      const base: BaseContextPacket = {
        trace_id: inbound.id,
        tenant_id: tenantId,
        agent_id: agentId,
        session_id: c.id,
        conversation_id: c.id,
        channel: {
          id: channel_id ?? 'default',
          kind: 'whatsapp',
          is_locked_down: false,
        },
        actor: {
          user_id: null,
          pessoa_id: pessoa.id,
          role: 'end_user',
          is_authenticated: true,
        },
        input: {
          kind: 'text',
          content_ref: inbound.id,
          content_hmac: '',
          received_at: inbound.created_at?.toISOString() ?? new Date().toISOString(),
        },
        active_procedure_execution_id: activeExecution?.id ?? null,
        feature_flags_snapshot: { FEATURE_CONTEXT_PACKET_V1: true },
        entered_at_ms: Date.now(),
        // P9c: sensitive-memory risk floor. The legacy hot-path here doesn't
        // have async DB access at this point — the real BaseContextBuilder
        // (used by the packet path) populates this via countActiveSensitive.
        // Conservative default: 0 (no false floor in this legacy branch).
        active_sensitive_memory_count: 0,
      };
      const decision = createDecisionPacketStub(base);
      const { builders, cache } = getProductionBuilderSet();
      // P8a stub history loader — no DB call yet; history surfaced via legacy
      // messages array.  Real loader wired when P9b integrates context packet.
      const historyLoader = async (): Promise<import('@/runtime/context-packet/types.js').HistorySlice> => ({
        turns: [],
        truncated: false,
      });
      const packet = await buildContextPacket({ base, decision }, { builders, cache, historyLoader });
      const rendered = buildPromptFromPacket(packet);
      system = rendered.system;
      messages = rendered.messages as import('@/lib/claude.js').LLMMessage[];
      logger.debug(
        {
          tenant_id: tenantId,
          duration_ms: packet.assembly_meta.duration_ms,
          fallbacks: Object.keys(packet.assembly_meta.fallback_depths_applied),
        },
        'agent.context_packet_path',
      );
    } catch (err) {
      // Packet path failed — degrade to legacy builder so the turn succeeds.
      logger.warn(
        { tenant_id: tenantId, err: (err as Error).message },
        'agent.context_packet_path_failed_fallback_legacy',
      );
      const legacy = await buildPrompt({ pessoa, conversa: c, scope, inbound, activeRole, activeExecution });
      system = legacy.system;
      messages = legacy.messages;
    }
  } else {
    const legacy = await buildPrompt({ pessoa, conversa: c, scope, inbound, activeRole, activeExecution });
    system = legacy.system;
    messages = legacy.messages;
  }

  let tools = getToolSchemas(scope.byEntity);

  // P9b — Decision Engine gate: runs BEFORE the LLM call.
  // Flag OFF (default) → zero behaviour change.
  // Flag ON → engine gates the turn; tool_reductions applied to toolSet.
  try {
    const baseCtx = buildBaseContextPacketFromTurn({
      inbound,
      conversa: c,
      pessoa,
      tenant_id: tenantId,
      agent_id: getCurrentAgent(),
      channel_id,
      active_procedure_execution_id: activeExecution?.id ?? null,
    });
    const deResult = await runDecisionEngineForTurn(baseCtx);
    if (deResult.engine_ran && deResult.result) {
      const { packet, block } = deResult.result;

      // Honor decision outcome: block and approval flows short-circuit the turn.
      if (block) {
        // 'block' or 'escalate' from a PEP → reply to user and skip LLM
        const blockMsg =
          block.user_facing_message ??
          'Esta ação não está disponível no momento. Em caso de dúvidas, entre em contato.';
        await sendOutbound(pessoa.id, c.id, blockMsg, inbound.id).catch((err) =>
          logger.warn({ err: (err as Error).message }, 'agent.decision_engine.blocked_reply_failed'),
        );
        await markAllProcessed(0);
        await conversasRepo.touch(c.id);
        await clearDebounceState(pessoa.telefone_whatsapp);
        return;
      }

      // action_mode='escalate' without a hard block → still escalate (dual-approval path)
      if (packet.action_mode === 'escalate') {
        const escalateMsg =
          'Esta ação requer aprovação adicional. O responsável será notificado.';
        await sendOutbound(pessoa.id, c.id, escalateMsg, inbound.id).catch((err) =>
          logger.warn({ err: (err as Error).message }, 'agent.decision_engine.escalate_reply_failed'),
        );
        await markAllProcessed(0);
        await conversasRepo.touch(c.id);
        await clearDebounceState(pessoa.telefone_whatsapp);
        return;
      }

      // action_mode='ask_clarification' → surface as user-facing message and skip LLM
      // This covers budget-fallback and skill-not-found paths.
      if (packet.action_mode === 'ask_clarification') {
        const clarifyMsg = 'Pode me dar mais detalhes sobre o que você precisa?';
        await sendOutbound(pessoa.id, c.id, clarifyMsg, inbound.id).catch((err) =>
          logger.warn({ err: (err as Error).message }, 'agent.decision_engine.clarify_reply_failed'),
        );
        await markAllProcessed(0);
        await conversasRepo.touch(c.id);
        await clearDebounceState(pessoa.telefone_whatsapp);
        return;
      }

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
      // fail-closed: engine errored and FEATURE_DECISION_ENGINE_ERROR_FALLBACK='fail-closed'
      // → block the turn, reply to user, skip LLM
      const failMsg = 'Sistema indisponível temporariamente. Tente novamente em alguns instantes.';
      await sendOutbound(pessoa.id, c.id, failMsg, inbound.id).catch((e) =>
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
  const stopTyping = scheduleTypingDebounce(jid, inbound.id);
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

  // P3b/P7 — POST-TURN cognitive modules (fire-and-forget):
  // step-evaluator + correction-reflection + success-reflection.
  //
  // Dual-path: quando FEATURE_COGNITIVE_GRAPH ON, todos os 3 triggers
  // rodam dentro do postturn-graph (camada ASYNC). OFF mantém legacy
  // intacto. Critério: errors NUNCA bloqueiam ack do turn.
  if (featureFlags.isEnabled(FeatureFlagName.COGNITIVE_GRAPH)) {
    // P7 path — fire-and-forget via runNodes (postturn nodes são ASYNC).
    // Inclui step-evaluator + correction-reflection + success-reflection.
    void runNodes(buildPostturnNodes(), {
      conversa_id: c.id,
      turno_id: inbound.id,
      pessoa,
      conversa: c,
      inbound,
      response_text: reactOutboundText,
      tools_called: reactToolsCalled,
      // P3c Task 5: nodes derive `user_message` from `inbound.conteudo`
      // themselves; we just pass the active_execution_id so the
      // step-evaluator runs only when there's something to advance.
      active_execution_id: activeExecution?.id ?? null,
    });
  } else if (activeExecution) {
    // Legacy path — direct fire-and-forget IIFE. Only enter when there's an
    // active procedure_execution to evaluate; otherwise nothing to advance.
    const execId = activeExecution.id;
    const responseContext = {
      response_text: reactOutboundText,
      tools_called: reactToolsCalled,
    };
    void (async () => {
      try {
        const exec = await procedureExecutionsRepo.findById(execId);
        if (!exec || exec.status !== 'in_progress') return;
        const def = await procedureDefinitionsRepo.findById(exec.definition_id);
        if (!def) return;

        const evalResult = await evaluateCurrentStep({
          execution: exec,
          definition: def,
          response_context: responseContext,
        });

        // P84-C4: emit a `tool_called` event for every tool the ReAct
        // loop invoked this turn. We emit unconditionally (rather than
        // only when the tool intersects a criterion) so the audit trail
        // can answer "what tools did this procedure trigger?" without
        // joining against criterion shapes. Truncation is handled inside
        // the engine helper.
        for (const tc of responseContext.tools_called ?? []) {
          await procedureEngine.recordToolCalled({
            execution_id: exec.id,
            step_id: exec.current_step_id,
            tool_name: tc.name,
            result: tc.result,
          }).catch(() => undefined);
        }

        // P84-C4: emit `criterion_checked` for each criterion the
        // step-evaluator scored. Best-effort: if persistence fails, we
        // still proceed with the advance/complete decision below.
        for (const cr of evalResult.criterion_results) {
          await procedureEngine.recordCriterionChecked({
            execution_id: exec.id,
            step_id: exec.current_step_id ?? '',
            criterion_id: cr.id,
            criterion_type: cr.type,
            passed: cr.passed,
            evidence: cr.evidence,
          }).catch(() => undefined);
        }

        // P84-C3: stall handling. When the evaluator reports a stall
        // reason (`no_criteria_defined` — step has no criteria,
        // `unsupported_criterion_only` — all criteria are P3c types
        // not yet evaluated), we record a `step_failed` event so the
        // future P3c reaper can sweep the execution. We do NOT abort
        // here — operators may still want to manually advance via SQL,
        // and the kill switch handles the worst case.
        if (evalResult.stall_reason) {
          await procedureEngine.recordEvent({
            execution_id: exec.id,
            step_id: exec.current_step_id,
            event_type: 'step_failed',
            payload: {
              reason: evalResult.stall_reason,
              step_id: exec.current_step_id,
            },
            confidence: null,
          }).catch(() => undefined);
        }

        if (!evalResult.step_completed) return;

        // P84-C3: when the DAG-aware picker linearized parallel
        // branches, record a `branch_taken` event with the chosen
        // step + the alternates so P3c can use it to drive proper
        // branch resolution. Today the picker is deterministic (first
        // in array order); the event makes the choice auditable.
        if (evalResult.branch_alternates.length > 0 && evalResult.next_step_id) {
          await procedureEngine.recordEvent({
            execution_id: exec.id,
            step_id: evalResult.next_step_id,
            event_type: 'branch_taken',
            payload: {
              chosen_step_id: evalResult.next_step_id,
              alternates: evalResult.branch_alternates,
              picker: 'deterministic_array_order',
            },
            confidence: null,
          }).catch(() => undefined);
        }

        if (evalResult.next_step_id) {
          await procedureEngine.advanceStep({
            execution_id: exec.id,
            next_step_id: evalResult.next_step_id,
            completed_step_id: exec.current_step_id!,
          });
        } else {
          await procedureEngine.completeExecution({
            execution_id: exec.id,
            outcome: 'success',
          });
        }
      } catch (err) {
        logger.warn(
          { err: (err as Error).message, execId },
          'procedure.postturn.failed',
        );
      }
    })();
  }

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
/**
 * P7 Task 8 — helper file-local para montar `role_inputs` do PreturnContext.
 *
 * Mirror do bloco legacy de role-selection: só retorna inputs quando
 * MULTI_CHANNEL on E channel_id presente E policy + roles disponíveis.
 * Caso contrário retorna undefined, e o node role-selector é omitido do
 * grafo (`buildPreturnNodes(multi_channel_on: false)`) ou skipado via
 * `runWhen=ctx.role_inputs !== undefined`.
 */
async function buildRoleInputs(
  channel_id: string | null,
): Promise<PreturnContext['role_inputs']> {
  if (!channel_id) return undefined;
  if (!featureFlags.isEnabled(FeatureFlagName.MULTI_CHANNEL)) return undefined;
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
