import {
  mensagensRepo,
  conversasRepo,
  procedureExecutionsRepo,
  procedureDefinitionsRepo,
  procedureSelectorDecisionsRepo,
} from '@/db/repositories.js';
import { resolveScope } from '@/governance/permissions.js';
import { checkPendingFirst } from '@/agent/pending-gate.js';
import { checkRateLimit, formatPoliteReply } from '@/gateway/rate-limit.js';
import { resolveIdentity } from '@/identity/resolver.js';
import { handleQuarantineFirstContact, handleOwnerIdentityReply } from '@/identity/quarantine.js';
import { config } from '@/config/env.js';
import { clearDebounceState } from '@/gateway/debouncer.js';
import { buildPrompt } from './prompt-builder.js';
import { logger } from '@/lib/logger.js';
import type { Mensagem, ProcedureExecution } from '@/db/schema.js';
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
import { selectProcedure } from '@/cognition/procedure-selector.js';
import { evaluateCurrentStep } from '@/cognition/step-evaluator.js';
import * as procedureEngine from '@/procedures/engine.js';
import { CognitiveEventType } from '@/types/enums.js';
import { sendOutbound } from './output-dispatch.js';
import { runReActLoop } from './react-loop.js';
import { runWithTenantContext } from '@/db/tenant-context.js';

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

export async function runAgentForMensagem(mensagem_id: string): Promise<void> {
  // P0: 'default' is the only tenant/agent — single-tenant deployment.
  // P6 introduces multi-channel/multi-agent and will route via channel→tenant
  // resolution before this function is invoked.
  await runWithTenantContext(
    { tenant_id: 'default', agent_id: 'default' },
    () => runAgentForMensagemInner(mensagem_id),
  );
}

async function runAgentForMensagemInner(mensagem_id: string): Promise<void> {
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
  if (inbound.conteudo && detectSuccess(inbound.conteudo)) {
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
  // 'unresolved' and 'no_pending' fall through to the existing ReAct flow.

  const scope = await resolveScope(pessoa);

  // P3b Task 9 — PRE-TURN selector:
  // Resolve whether a procedure should be active for this turn. The
  // selector consults the current active execution (if any) and the
  // assigned procedures for this agent. Its decision (start/continue/
  // switch/escalate/none) is recorded for auditability. If a new
  // procedure should start, we kick off the execution BEFORE buildPrompt
  // so the system prompt picks up the new procedure's first step.
  //
  // Fully wrapped in try/catch — procedure runtime must never break the
  // baseline ReAct turn. Failures here just leave `activeExecution=null`.
  let activeExecution: ProcedureExecution | null = null;
  // P84-Op: kill switch. When FEATURE_PROCEDURE_RUNTIME=false, the entire
  // selector/engine/evaluator wire-up no-ops so the system can be turned
  // off in prod (zombie executions piling up, runtime bug, etc.) without
  // a code revert. The baseline ReAct turn proceeds unchanged.
  if (config.FEATURE_PROCEDURE_RUNTIME) {
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
        // P84-C2: startExecution returns { execution, created }. On a
        // concurrent-start race, `created=false` and we adopt the
        // execution that the winning worker just inserted instead of
        // creating a duplicate.
        const started = await procedureEngine.startExecution({
          definition_id: def.id,
          definition_version: def.version_number,
          conversa_id: c.id,
          first_step_id: firstStep,
        });
        activeExecution = started.execution;
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
        const started = await procedureEngine.startExecution({
          definition_id: def.id,
          definition_version: def.version_number,
          conversa_id: c.id,
          first_step_id: firstStep,
        });
        activeExecution = started.execution;
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
  }

  const { system, messages } = await buildPrompt({
    pessoa,
    conversa: c,
    scope,
    inbound,
    // PR #84 Minor #7: pass the execution already loaded above so
    // buildPrompt skips its own DB roundtrip. Pass `null` (not omit) when
    // the runtime flag is off so the section is suppressed without a
    // fallback lookup.
    activeExecution: config.FEATURE_PROCEDURE_RUNTIME ? activeExecution : null,
  });

  const tools = getToolSchemas(scope.byEntity);
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
  let reactOutboundText = '';
  let reactToolsCalled: Array<{ name: string; result: unknown }> = [];
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
    reactOutboundText = result.outboundText;
    reactToolsCalled = result.toolsCalled;
  } finally {
    stopTyping();
  }

  await markAllProcessed(totalTokens);
  await conversasRepo.touch(c.id);
  await clearDebounceState(pessoa.telefone_whatsapp);

  // P3b Task 9 — POST-TURN evaluator (fire-and-forget):
  // If a procedure execution is active, re-load it (state may have
  // mutated mid-turn) and evaluate the current step's success criteria
  // against this turn's outbound text + tool results. If the step is
  // complete, advance to the next step or complete the execution.
  // Errors are swallowed — procedure runtime must NEVER block the
  // user-facing reply or post-turn cleanup.
  //
  // P84-Op: gated on FEATURE_PROCEDURE_RUNTIME — the kill switch covers
  // post-turn too, otherwise turning it off mid-execution would leave
  // executions un-advanced. We still load+evaluate when ON, no-op when OFF.
  // P84-C4: emit `criterion_checked` for every gate evaluation,
  // `tool_called` for procedure-relevant tool calls, and `step_failed`
  // when the step is stalled (zero criteria or unsupported-only) — the
  // audit trail must reconstruct "why did step X not advance?" from the
  // event log alone.
  if (activeExecution && config.FEATURE_PROCEDURE_RUNTIME) {
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

        const evalResult = evaluateCurrentStep({
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
