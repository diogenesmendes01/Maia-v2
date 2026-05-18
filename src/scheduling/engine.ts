/**
 * Spec 18 — Scheduling engine.
 *
 * Each tick, in order:
 *   1. Reclaim expired leases on `claimed` rows — they return to `pending`
 *      so the regular `claimDue` pass below picks them up. (Blocker 2: the
 *      previous version returned the reclaimed rows but never processed
 *      them; rows could sit `claimed` indefinitely after a crash.)
 *   2. Claim due `pending` occurrences via `FOR UPDATE SKIP LOCKED`. Each
 *      occurrence is advanced inside its own transaction so the outbox
 *      enqueue + task/occurrence state update commit atomically (spec 18
 *      §7.1, Blocker 4).
 *   3. Claim `in_progress` occurrences whose advance was paused waiting
 *      for an external response — `recurring_outreach` `forward` step
 *      runs here after `captureInboundForOutreach` flipped the status.
 *   4. Process `awaiting_third_party` rows whose `wait_response_hours`
 *      window expired and escalate to the owner.
 *
 * Side-effect contract: the engine NEVER calls Baileys directly. It only
 * writes DB rows. The outbox-drain worker is responsible for sending.
 */

import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Occurrence } from '@/db/schema.js';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { audit } from '@/governance/audit.js';
import { pessoasRepo, conversasRepo, pendingQuestionsRepo } from '@/db/repositories.js';
import {
  seriesRepo,
  occurrencesRepo,
  tasksRepo,
  outboxRepo,
  advanceWithTx,
} from './repos.js';
import { computeNext } from './rrule.js';
import {
  parseRRule as parseRRuleExtended,
  usesBusinessDayExtension,
  computeNextWithBusinessDays,
} from './business-day-rrule.js';
import { decideMissedRun, isOverdue } from './policies.js';
import { newCorrelationToken, appendCorrelationFooter } from './correlation.js';
import type {
  MissedRunPolicy,
  MonthEndPolicy,
  OneShotReminderContexto,
  RecurringOutreachContexto,
  RecurringPaymentContexto,
  SeriesContexto,
  SeriesTipo,
  TaskKind,
} from './types.js';

const WORKER_ID = `${hostname()}:scheduling:${process.pid}:${randomUUID().slice(0, 8)}`;

const CLAIM_LIMIT_PER_TICK = 20;
const TIMEOUT_SCAN_LIMIT = 20;

function jidFromPhone(tel: string): string {
  return tel.replace('+', '') + '@s.whatsapp.net';
}

/**
 * Codex review #105 (medium): roteia entre o computeNext legacy e a versão
 * business-day-aware. Subsequent cycles (advance + backfill) DEVEM honrar
 * BYNTHWORKDAY/BYWORKDAY=true se o RRULE original os usou — caso contrário a
 * extensão funciona só no primeiro ciclo e silenciosamente quebra depois.
 */
async function computeNextAdvance(args: {
  rrule: string;
  after: Date;
  monthEndPolicy: MonthEndPolicy;
  entidadeId?: string | null;
}): Promise<Date> {
  const extParsed = parseRRuleExtended(args.rrule);
  if (usesBusinessDayExtension(extParsed)) {
    return computeNextWithBusinessDays(extParsed, args.after, {
      monthEndPolicy: args.monthEndPolicy,
      entidadeId: args.entidadeId ?? undefined,
    });
  }
  return computeNext(args.rrule, args.after, args.monthEndPolicy);
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`);
}

function previousMonthLabel(now: Date): string {
  const prev = new Date(now);
  prev.setMonth(prev.getMonth() - 1);
  return `${String(prev.getMonth() + 1).padStart(2, '0')}/${prev.getFullYear()}`;
}

export async function runSchedulingTick(): Promise<{
  reclaimed: number;
  claimed: number;
  advanced: number;
  skipped: number;
  timed_out: number;
  in_progress_advanced: number;
}> {
  if (!config.FEATURE_SCHEDULING_V2)
    return { reclaimed: 0, claimed: 0, advanced: 0, skipped: 0, timed_out: 0, in_progress_advanced: 0 };

  // Step 1: reclaim expired leases — these go back to `pending`.
  const reclaimedIds = await occurrencesRepo
    .reclaimExpiredLeases(WORKER_ID, config.OCCURRENCE_LEASE_TTL_SECONDS, CLAIM_LIMIT_PER_TICK)
    .catch((err) => {
      logger.warn({ err: (err as Error).message }, 'scheduling.reclaim_failed');
      return [] as string[];
    });
  if (reclaimedIds.length > 0) {
    await audit({
      acao: 'occurrence_claimed',
      metadata: { count: reclaimedIds.length, kind: 'lease_reaped' },
    });
  }

  // Step 2: claim due pending. Reclaimed rows from step 1 are now `pending`
  // and become eligible here.
  const claimed = await occurrencesRepo.claimDue(WORKER_ID, CLAIM_LIMIT_PER_TICK);

  let advanced = 0;
  let skipped = 0;
  for (const occ of claimed) {
    try {
      const result = await advanceOccurrence(occ);
      if (result === 'advanced') advanced++;
      else if (result === 'skipped') skipped++;
      else if (result === 'deferred') skipped++;
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, occurrence_id: occ.id },
        'scheduling.advance_failed',
      );
      await occurrencesRepo.setStatus(occ.id, 'failed', {
        metadata_patch: { advance_error: (err as Error).message },
      });
      await audit({
        acao: 'occurrence_failed',
        alvo_id: occ.id,
        occurrence_id: occ.id,
        metadata: { error: (err as Error).message },
      });
    }
  }

  // Step 3: claim in_progress occurrences whose advance was paused waiting
  // for an external response that has now arrived. Outreach forward step.
  const inProgress = await occurrencesRepo
    .claimInProgressForAdvance(WORKER_ID, CLAIM_LIMIT_PER_TICK)
    .catch(() => [] as Occurrence[]);
  let in_progress_advanced = 0;
  for (const occ of inProgress) {
    try {
      const r = await advanceInProgressOccurrence(occ);
      if (r === 'advanced') in_progress_advanced++;
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, occurrence_id: occ.id },
        'scheduling.in_progress_advance_failed',
      );
    }
  }

  // Step 4: scan awaiting_third_party for timeouts.
  const timedOut = await occurrencesRepo
    .listAwaitingTimedOut(TIMEOUT_SCAN_LIMIT)
    .catch(() => [] as Occurrence[]);
  let timed_out = 0;
  for (const occ of timedOut) {
    try {
      await escalateOutreachTimeout(occ);
      timed_out++;
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, occurrence_id: occ.id },
        'scheduling.outreach_timeout_failed',
      );
    }
  }

  return {
    reclaimed: reclaimedIds.length,
    claimed: claimed.length,
    advanced,
    skipped,
    timed_out,
    in_progress_advanced,
  };
}

async function advanceOccurrence(occ: Occurrence): Promise<'advanced' | 'skipped' | 'deferred'> {
  const series = await seriesRepo.findById(occ.series_id);
  if (!series) {
    await occurrencesRepo.setStatus(occ.id, 'cancelled');
    return 'skipped';
  }

  // Cancellation race: series was cancelled while we held the lease.
  if (series.status !== 'active') {
    await occurrencesRepo.setStatus(occ.id, 'cancelled');
    await audit({
      acao: 'series_cancelled_during_advance',
      alvo_id: occ.id,
      occurrence_id: occ.id,
      metadata: { series_id: series.id, series_status: series.status },
    });
    return 'skipped';
  }

  // Missed-run policy gate.
  if (isOverdue(occ.scheduled_for, series.staleness_threshold_hours)) {
    const overdueSiblings = await occurrencesRepo.listOverdueForSeries(
      series.id,
      new Date(Date.now() - series.staleness_threshold_hours * 3600_000),
    );
    const all = [
      ...overdueSiblings.map((s) => ({ id: s.id, scheduled_for: s.scheduled_for })),
      { id: occ.id, scheduled_for: occ.scheduled_for },
    ];
    const policy: MissedRunPolicy = series.missed_run_policy as MissedRunPolicy;
    const decision = decideMissedRun(occ, all, policy);
    if (decision.kind === 'skip_and_audit') {
      await occurrencesRepo.setStatus(occ.id, 'aged_out', { outcome: 'aged_out' });
      await audit({
        acao: 'occurrence_aged_skipped',
        alvo_id: occ.id,
        occurrence_id: occ.id,
        metadata: { policy, scheduled_for: occ.scheduled_for.toISOString() },
      });
      return 'skipped';
    }
    if (decision.kind === 'escalate_owner') {
      await occurrencesRepo.setStatus(occ.id, 'aged_out', { outcome: 'aged_out' });
      await audit({
        acao: 'occurrence_aged_skipped',
        alvo_id: occ.id,
        occurrence_id: occ.id,
        metadata: { policy, scheduled_for: occ.scheduled_for.toISOString(), escalate: true },
      });
      const owner = await pessoasRepo.findById(series.owner_pessoa_id);
      if (owner) {
        await outboxRepo.enqueue({
          occurrence_id: occ.id,
          task_id: null,
          kind: 'whatsapp_alert',
          payload: {
            jid: jidFromPhone(owner.telefone_whatsapp),
            text: `⚠️ Ocorrência atrasada (série ${series.tipo}, agendada ${occ.scheduled_for.toISOString()}). Não disparei automaticamente. Quer que eu refaça?`,
          },
          dedup_key: `${occ.id}:aged_escalate`,
        });
      }
      return 'skipped';
    }
  }

  // Per-tipo advance.
  const tipo = series.tipo as SeriesTipo;
  if (tipo === 'one_shot_reminder') return advanceOneShotReminder(series, occ);
  if (tipo === 'recurring_outreach') return advanceRecurringOutreach(series, occ);
  if (tipo === 'recurring_payment') return advanceRecurringPayment(series, occ);

  await occurrencesRepo.setStatus(occ.id, 'failed');
  return 'skipped';
}

async function advanceOneShotReminder(
  series: Awaited<ReturnType<typeof seriesRepo.findById>>,
  occ: Occurrence,
): Promise<'advanced' | 'deferred'> {
  if (!series) throw new Error('series missing');
  const owner = await pessoasRepo.findById(series.owner_pessoa_id);
  if (!owner || owner.status !== 'ativa') {
    await occurrencesRepo.setStatus(occ.id, 'skipped', {
      metadata_patch: { skip_reason: 'owner_inactive' },
    });
    return 'advanced';
  }
  const ctx = occ.contexto_snapshot as OneShotReminderContexto;
  const tasksList = await tasksRepo.byOccurrence(occ.id);
  const fireTask = tasksList.find((t) => t.kind === 'fire_reminder');
  if (!fireTask) throw new Error('one_shot_reminder: missing fire_reminder task');

  // Transactional advance: task in_progress + occurrence in_progress +
  // outbox enqueue commit together. Spec 18 §7.1, Blocker 4.
  await advanceWithTx(async (_tx, repos) => {
    await repos.tasks.setStatus(fireTask.id, 'in_progress');
    await repos.occurrences.setStatus(occ.id, 'in_progress');
    await repos.outbox.enqueue({
      occurrence_id: occ.id,
      task_id: fireTask.id,
      kind: 'whatsapp_text',
      payload: { jid: jidFromPhone(owner.telefone_whatsapp), text: `🔔 Lembrete: ${ctx.texto}` },
      dedup_key: `${occ.id}:fire_reminder`,
    });
  });
  await audit({
    acao: 'outbox_enqueued',
    alvo_id: occ.id,
    occurrence_id: occ.id,
    metadata: { kind: 'whatsapp_text', purpose: 'reminder' },
  });
  return 'advanced';
}

async function advanceRecurringOutreach(
  series: Awaited<ReturnType<typeof seriesRepo.findById>>,
  occ: Occurrence,
): Promise<'advanced' | 'deferred'> {
  if (!series) throw new Error('series missing');
  const ctx = occ.contexto_snapshot as RecurringOutreachContexto;

  // Blocker 8 — exclusive_per_destinatario: defer if another occurrence of
  // this series already has the same destinatario open. Release the claim
  // so the next tick retries; do NOT mark the occurrence failed.
  if (series.exclusive_per_destinatario) {
    const collision = await occurrencesRepo.hasOpenForDestinatarioExcluding(
      series.id,
      ctx.destinatario_pessoa_id,
      occ.id,
    );
    if (collision) {
      await occurrencesRepo.releaseClaim(occ.id, 600); // try again in 10 min
      return 'deferred';
    }
  }

  const destinatario = await pessoasRepo.findById(ctx.destinatario_pessoa_id);
  if (!destinatario || destinatario.status !== 'ativa') {
    await occurrencesRepo.setStatus(occ.id, 'failed', {
      metadata_patch: { fail_reason: 'destinatario_inactive' },
    });
    return 'advanced';
  }
  const tasksList = await tasksRepo.byOccurrence(occ.id);
  const sendTask = tasksList.find((t) => t.kind === 'send_outreach');
  if (!sendTask) throw new Error('recurring_outreach: missing send_outreach task');

  const body = renderTemplate(ctx.message_template, {
    nome: destinatario.nome,
    mes_anterior: previousMonthLabel(new Date()),
  });
  const text = occ.correlation_token
    ? appendCorrelationFooter(body, occ.correlation_token)
    : body;

  // Transactional: task in_progress + occurrence awaiting_third_party +
  // outbox enqueue commit together.
  await advanceWithTx(async (_tx, repos) => {
    await repos.tasks.setStatus(sendTask.id, 'in_progress');
    await repos.occurrences.setStatus(occ.id, 'awaiting_third_party');
    await repos.outbox.enqueue({
      occurrence_id: occ.id,
      task_id: sendTask.id,
      kind: 'whatsapp_text',
      payload: { jid: jidFromPhone(destinatario.telefone_whatsapp), text },
      dedup_key: `${occ.id}:send_outreach`,
    });
  });
  await audit({
    acao: 'outreach_sent',
    pessoa_id: series.owner_pessoa_id,
    alvo_id: occ.id,
    occurrence_id: occ.id,
    metadata: { destinatario_id: destinatario.id },
  });
  return 'advanced';
}

async function advanceRecurringPayment(
  series: Awaited<ReturnType<typeof seriesRepo.findById>>,
  occ: Occurrence,
): Promise<'advanced' | 'deferred'> {
  if (!series) throw new Error('series missing');
  const ctx = occ.contexto_snapshot as RecurringPaymentContexto;
  if (ctx.valor > config.VALOR_LIMITE_DURO) {
    await occurrencesRepo.setStatus(occ.id, 'failed', {
      metadata_patch: { fail_reason: 'valor_above_limit_at_claim' },
    });
    await audit({
      acao: 'occurrence_rejected_limit',
      alvo_id: occ.id,
      occurrence_id: occ.id,
      metadata: { valor: ctx.valor, limit: config.VALOR_LIMITE_DURO },
    });
    return 'advanced';
  }
  const owner = await pessoasRepo.findById(series.owner_pessoa_id);
  if (!owner || owner.status !== 'ativa') {
    await occurrencesRepo.setStatus(occ.id, 'failed', {
      metadata_patch: { fail_reason: 'owner_inactive' },
    });
    return 'advanced';
  }
  const ownerConv = await conversasRepo.findActive(owner.id);
  if (!ownerConv) {
    // Defer: no active conversa to anchor a pending_question. Release
    // the claim so the next tick retries after the owner messages Maia.
    await occurrencesRepo.releaseClaim(occ.id, 600);
    return 'deferred';
  }
  const tasksList = await tasksRepo.byOccurrence(occ.id);
  const proposeTask = tasksList.find((t) => t.kind === 'propose_payment');
  if (!proposeTask) throw new Error('recurring_payment: missing propose_payment task');

  const valorFmt = ctx.valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const pergunta = `Pagamento ${ctx.descricao} de ${valorFmt} hoje? Responda *sim*, *não* ou *adiar*.`;

  // Transactional: pending_question + task completed + occurrence
  // awaiting_owner + outbox enqueue all commit together.
  await advanceWithTx(async (tx, repos) => {
    await pendingQuestionsRepo.createTx(tx, {
      conversa_id: ownerConv.id,
      pessoa_id: owner.id,
      tipo: 'payment_confirmation',
      pergunta,
      opcoes_validas: [
        { key: 'sim', label: 'Pagar agora' },
        { key: 'nao', label: 'Pular este mês' },
        { key: 'adiar', label: 'Adiar 2 dias' },
      ],
      acao_proposta: {
        // Blocker 1: scheduling-aware kind. Pending-resolver detects this
        // and routes to resolvePaymentOccurrence — does NOT dispatch
        // register_transaction generically.
        scheduling_kind: 'payment_due',
        occurrence_id: occ.id,
        series_id: series.id,
        // The transaction args are kept as `payload` so the sim branch can
        // dispatch them; nao/adiar branches never touch this.
        payload: {
          tool: 'register_transaction',
          args: {
            entidade_id: series.entidade_id,
            conta_id: ctx.conta_id,
            natureza: 'despesa',
            valor: ctx.valor,
            data_competencia: new Date().toISOString().slice(0, 10),
            data_pagamento: new Date().toISOString().slice(0, 10),
            status: 'paga',
            descricao: ctx.descricao,
            categoria_id: ctx.categoria_id,
            contraparte_id: ctx.contraparte_id,
            origem: 'whatsapp',
          },
        },
      },
      expira_em: new Date(Date.now() + ctx.escalate_after_hours * 3600_000),
      status: 'aberta',
      metadata: { occurrence_id: occ.id, series_id: series.id },
    });
    await repos.tasks.setStatus(proposeTask.id, 'completed', { pergunta });
    await repos.occurrences.setStatus(occ.id, 'awaiting_owner');
    await repos.outbox.enqueue({
      occurrence_id: occ.id,
      task_id: proposeTask.id,
      kind: 'whatsapp_text',
      payload: { jid: jidFromPhone(owner.telefone_whatsapp), text: pergunta },
      dedup_key: `${occ.id}:propose_payment`,
    });
  });
  await audit({
    acao: 'payment_due_proposed',
    pessoa_id: owner.id,
    alvo_id: occ.id,
    occurrence_id: occ.id,
    metadata: { valor: ctx.valor, descricao: ctx.descricao },
  });
  return 'advanced';
}

/**
 * Advances an `in_progress` recurring_outreach: runs the forward step
 * (if forward_template + response captured), then schedules the next
 * cycle. Blocker 3.
 */
async function advanceInProgressOccurrence(occ: Occurrence): Promise<'advanced' | 'skipped'> {
  const series = await seriesRepo.findById(occ.series_id);
  if (!series || series.status !== 'active') {
    await occurrencesRepo.setStatus(occ.id, 'cancelled');
    return 'skipped';
  }
  if (series.tipo !== 'recurring_outreach') {
    // Review 3 BLOCKER fix: previously this branch marked the occurrence
    // `completed/fired`, producing a phantom success for `one_shot_reminder`
    // rows whose outbox row was still pending. The repo-level claim is now
    // restricted to `recurring_outreach`, so reaching this branch means we
    // saw a row through a race with cancellation or a manual data fix.
    // Either way the safe action is to release the claim (no status mutation)
    // and let the outbox-drain own completion semantics.
    await occurrencesRepo.releaseClaim(occ.id, 30);
    logger.warn(
      { occurrence_id: occ.id, series_id: series.id, tipo: series.tipo },
      'scheduling.in_progress_advance_skipped_unexpected_tipo',
    );
    return 'skipped';
  }
  const ctx = occ.contexto_snapshot as RecurringOutreachContexto;
  const tasksList = await tasksRepo.byOccurrence(occ.id);
  const awaitTask = tasksList.find((t) => t.kind === 'await_response');
  const forwardTask = tasksList.find((t) => t.kind === 'forward');
  const response = (awaitTask?.result as Record<string, unknown> | null)?.['response_text'] as
    | string
    | undefined;

  // Blocker 3 (review 2): forward task must only complete AFTER the
  // outbox confirms send. We split this into three sub-states:
  //   (a) forwardTask.status === 'pending' AND there IS something to
  //       forward → enqueue the outbox row, mark task `in_progress`.
  //       DO NOT mark task or occurrence completed here. Outbox-drain
  //       will mark the task `completed` on successful send (see
  //       outbox-drain.ts processOne).
  //   (b) forwardTask.status === 'pending' AND nothing to forward
  //       (no forward_template / no forward_to / no response) → mark
  //       task `skipped` immediately. Then finalize the occurrence.
  //   (c) forwardTask.status === 'completed' (set by outbox-drain) or
  //       'skipped' (set in (b)) → finalize the occurrence + schedule
  //       next cycle. This is the path that runs ONCE per cycle, after
  //       the forward send is confirmed.
  if (forwardTask && forwardTask.status === 'pending') {
    if (ctx.forward_to_pessoa_id && ctx.forward_template && response) {
      const forwardTo = await pessoasRepo.findById(ctx.forward_to_pessoa_id);
      if (forwardTo && forwardTo.status === 'ativa') {
        const fwdMsg = renderTemplate(ctx.forward_template, {
          resposta: response,
          nome: forwardTo.nome,
          mes_anterior: previousMonthLabel(new Date()),
        });
        await advanceWithTx(async (_tx, repos) => {
          await repos.tasks.setStatus(forwardTask.id, 'in_progress');
          await repos.outbox.enqueue({
            occurrence_id: occ.id,
            task_id: forwardTask.id,
            kind: 'whatsapp_text',
            payload: { jid: jidFromPhone(forwardTo.telefone_whatsapp), text: fwdMsg },
            dedup_key: `${occ.id}:forward`,
          });
        });
        await audit({
          acao: 'outbox_enqueued',
          alvo_id: occ.id,
          occurrence_id: occ.id,
          metadata: { kind: 'whatsapp_text', purpose: 'forward', forward_to: forwardTo.id },
        });
        // STOP here. Occurrence stays in_progress. Outbox-drain will mark
        // the task completed on success, or dead on failure. Next engine
        // tick re-claims this occurrence and lands in branch (c).
        return 'advanced';
      } else {
        await tasksRepo.setStatus(forwardTask.id, 'skipped', { reason: 'forward_to_inactive' });
        // fall through to finalization below
      }
    } else {
      await tasksRepo.setStatus(forwardTask.id, 'skipped', { reason: 'nothing_to_forward' });
      // fall through to finalization below
    }
  }

  // Branch (c): forward is done (sent → completed by outbox-drain, or
  // skipped above). The forward task is either completed or skipped.
  // If it's still in_progress (outbox hasn't sent yet) we wait.
  if (forwardTask && forwardTask.status === 'in_progress') {
    // Still waiting on the outbox to send the forward. Don't finalize
    // — release claim so we re-claim on the next tick.
    await occurrencesRepo.releaseClaim(occ.id, 30);
    return 'skipped';
  }

  // Determine final occurrence outcome based on what the forward did.
  const forwardOutcome: string =
    forwardTask && forwardTask.status === 'completed' ? 'forwarded' : 'fired';

  // Schedule next cycle.
  if (series.rrule) {
    const next_at = await computeNextAdvance({
      rrule: series.rrule,
      after: new Date(),
      monthEndPolicy: series.month_end_policy as MonthEndPolicy,
      entidadeId: series.entidade_id,
    });
    await seriesRepo.insertNextOccurrenceIfActive({
      series_id: series.id,
      expected_version: series.version,
      scheduled_for: next_at,
      contexto_snapshot: occ.contexto_snapshot as SeriesContexto,
      correlation_token: newCorrelationToken(),
      tasks: outreachTaskBlueprint(),
    });
  }
  await occurrencesRepo.setStatus(occ.id, 'completed', { outcome: forwardOutcome });
  await audit({
    acao: 'occurrence_completed',
    alvo_id: occ.id,
    occurrence_id: occ.id,
    metadata: { tipo: series.tipo, forward_outcome: forwardOutcome },
  });
  return 'advanced';
}

/**
 * Handles a `recurring_outreach` occurrence whose `wait_response_hours`
 * window expired without a response. Marks it `failed` with outcome
 * `no_response`, sends a heads-up to the owner via outbox, and schedules
 * the next cycle so the series doesn't stall on the bad ciclo.
 */
async function escalateOutreachTimeout(occ: Occurrence): Promise<void> {
  const series = await seriesRepo.findById(occ.series_id);
  if (!series || series.status !== 'active') {
    await occurrencesRepo.setStatus(occ.id, 'cancelled');
    return;
  }
  const ctx = occ.contexto_snapshot as RecurringOutreachContexto;
  const destinatario = await pessoasRepo.findById(ctx.destinatario_pessoa_id);
  const owner = await pessoasRepo.findById(series.owner_pessoa_id);
  await advanceWithTx(async (_tx, repos) => {
    await repos.occurrences.setStatus(occ.id, 'failed', { outcome: 'no_response' });
    if (owner) {
      await repos.outbox.enqueue({
        occurrence_id: occ.id,
        task_id: null,
        kind: 'whatsapp_alert',
        payload: {
          jid: jidFromPhone(owner.telefone_whatsapp),
          text: `Heads-up: ${destinatario?.nome ?? 'o contato'} não respondeu o pedido recorrente agendado em ${occ.scheduled_for.toISOString().slice(0, 10)}. Próxima ocorrência segue normal.`,
        },
        dedup_key: `${occ.id}:no_response_alert`,
      });
    }
  });
  await audit({
    acao: 'outreach_no_response',
    pessoa_id: series.owner_pessoa_id,
    alvo_id: occ.id,
    occurrence_id: occ.id,
    metadata: { destinatario_id: ctx.destinatario_pessoa_id },
  });
  // Auto-schedule next cycle so the series keeps going.
  if (series.rrule) {
    const next_at = await computeNextAdvance({
      rrule: series.rrule,
      after: new Date(),
      monthEndPolicy: series.month_end_policy as MonthEndPolicy,
      entidadeId: series.entidade_id,
    });
    await seriesRepo.insertNextOccurrenceIfActive({
      series_id: series.id,
      expected_version: series.version,
      scheduled_for: next_at,
      contexto_snapshot: occ.contexto_snapshot as SeriesContexto,
      correlation_token: newCorrelationToken(),
      tasks: outreachTaskBlueprint(),
    });
  }
}

/**
 * Called from the pending-resolver when the owner answers a
 * `payment_confirmation` pending question whose `acao_proposta.scheduling_kind
 * === 'payment_due'`. Drives the rest of the payment_due state machine.
 * Blocker 1: this is the ONLY path that dispatches register_transaction
 * for payment_due — and only on `sim`.
 */
export async function resolvePaymentOccurrence(
  occurrence_id: string,
  decision: 'sim' | 'nao' | 'adiar',
  payload: { tool: string; args: Record<string, unknown> } | null,
  ctx: {
    pessoa: { id: string };
    conversa: { id: string };
    mensagem_id: string;
  },
): Promise<{ dispatched_tool: string | null }> {
  const occ = await occurrencesRepo.byId(occurrence_id);
  if (!occ || occ.status !== 'awaiting_owner') return { dispatched_tool: null };
  const series = await seriesRepo.findById(occ.series_id);
  if (!series) return { dispatched_tool: null };
  const tasksList = await tasksRepo.byOccurrence(occ.id);
  const execTask = tasksList.find((t) => t.kind === 'execute_or_skip');

  if (decision === 'sim') {
    // Dispatch register_transaction through the normal tool pipeline so
    // C-001, dual_approval and permissions apply.
    //
    // Blocker 1 (review 2): `dispatchTool` returns `{ error }` for
    // forbidden / requires_dual_approval / invalid_args /
    // redis_unavailable_blocked / execution_failed — it does NOT throw.
    // The previous code ignored the return value and audited
    // `payment_due_confirmed` even when the dispatch was rejected. Now
    // we inspect the result: only on a real success do we complete the
    // occurrence and audit confirmed.
    let dispatch_result: unknown = null;
    let dispatch_threw: string | null = null;
    if (payload?.tool) {
      try {
        const { dispatchTool } = await import('@/tools/_dispatcher.js');
        const { resolveScope } = await import('@/governance/permissions.js');
        const { uuid } = await import('@/lib/utils.js');
        const fullPessoa = await pessoasRepo.findById(ctx.pessoa.id);
        if (fullPessoa) {
          const scope = await resolveScope(fullPessoa);
          dispatch_result = await dispatchTool({
            tool: payload.tool,
            args: { ...(payload.args ?? {}), _pending_choice: 'sim' },
            ctx: {
              pessoa: fullPessoa,
              scope,
              conversa: { id: ctx.conversa.id } as never,
              mensagem_id: ctx.mensagem_id,
              request_id: uuid(),
            },
          });
        } else {
          dispatch_threw = 'pessoa_not_found';
        }
      } catch (err) {
        dispatch_threw = (err as Error).message;
        logger.warn(
          { err: dispatch_threw, occurrence_id },
          'payment_due.dispatch_threw',
        );
      }
    }
    const dispatchHasError =
      typeof dispatch_result === 'object' &&
      dispatch_result !== null &&
      'error' in (dispatch_result as Record<string, unknown>);

    if (dispatch_threw || dispatchHasError) {
      // Dispatch failed or was gated. Do NOT audit `payment_due_confirmed`
      // — that would lie about money having moved. Park the occurrence
      // as `failed` with the reason and let the operator decide. Do NOT
      // schedule the next cycle (the series stays alive; the operator
      // can resume or cancel via cancel_reminder).
      const reason = dispatch_threw ?? ((dispatch_result as { error: string }).error);
      if (execTask) {
        await tasksRepo.setStatus(execTask.id, 'failed', {
          decision: 'sim',
          dispatch_error: reason,
        });
      }
      await occurrencesRepo.setStatus(occ.id, 'failed', {
        metadata_patch: { dispatch_error: reason },
      });
      await audit({
        acao: 'occurrence_failed',
        pessoa_id: series.owner_pessoa_id,
        alvo_id: occ.id,
        occurrence_id: occ.id,
        metadata: { reason: 'payment_dispatch_rejected', detail: reason },
      });
      // Alert the owner so the failure is operator-visible (not just
      // buried in audit).
      const owner = await pessoasRepo.findById(series.owner_pessoa_id);
      if (owner) {
        await outboxRepo.enqueue({
          occurrence_id: occ.id,
          task_id: null,
          kind: 'whatsapp_alert',
          payload: {
            jid: jidFromPhone(owner.telefone_whatsapp),
            text: `⚠️ Não consegui registrar o pagamento "${(occ.contexto_snapshot as RecurringPaymentContexto).descricao ?? '?'}" (motivo: ${reason}). Vou pausar essa cobrança até você resolver.`,
          },
          dedup_key: `${occ.id}:dispatch_failure_alert`,
        });
      }
      return { dispatched_tool: null };
    }

    // Success path.
    const dispatched_tool = payload?.tool ?? null;
    if (execTask) await tasksRepo.setStatus(execTask.id, 'completed', { decision: 'sim' });
    await occurrencesRepo.setStatus(occ.id, 'completed', { outcome: 'sim' });
    await audit({
      acao: 'payment_due_confirmed',
      pessoa_id: series.owner_pessoa_id,
      alvo_id: occ.id,
      occurrence_id: occ.id,
    });
    await scheduleNextRecurring(series, occ);
    return { dispatched_tool };
  }

  if (decision === 'nao') {
    if (execTask) await tasksRepo.setStatus(execTask.id, 'skipped', { decision: 'nao' });
    await occurrencesRepo.setStatus(occ.id, 'skipped', { outcome: 'nao' });
    await audit({
      acao: 'payment_due_skipped',
      pessoa_id: series.owner_pessoa_id,
      alvo_id: occ.id,
      occurrence_id: occ.id,
    });
    await scheduleNextRecurring(series, occ);
    return { dispatched_tool: null };
  }

  // decision === 'adiar'
  if (execTask) await tasksRepo.setStatus(execTask.id, 'skipped', { decision: 'adiar' });
  await occurrencesRepo.setStatus(occ.id, 'skipped', { outcome: 'adiar' });
  await audit({
    acao: 'payment_due_postponed',
    pessoa_id: series.owner_pessoa_id,
    alvo_id: occ.id,
    occurrence_id: occ.id,
  });
  const next_at = new Date(Date.now() + 2 * 86400_000);
  await seriesRepo.insertNextOccurrenceIfActive({
    series_id: series.id,
    expected_version: series.version,
    scheduled_for: next_at,
    contexto_snapshot: occ.contexto_snapshot as SeriesContexto,
    tasks: paymentTaskBlueprint(),
  });
  return { dispatched_tool: null };
}

async function scheduleNextRecurring(
  series: NonNullable<Awaited<ReturnType<typeof seriesRepo.findById>>>,
  current: Occurrence,
): Promise<void> {
  if (!series.rrule) return;
  const next_at = await computeNextAdvance({
    rrule: series.rrule,
    after: new Date(),
    monthEndPolicy: series.month_end_policy as MonthEndPolicy,
    entidadeId: series.entidade_id,
  });
  const tasks: Array<{ ordem: number; kind: TaskKind }> =
    series.tipo === 'recurring_payment' ? paymentTaskBlueprint() : outreachTaskBlueprint();
  let correlation_token: string | undefined;
  if (series.tipo === 'recurring_outreach') correlation_token = newCorrelationToken();
  await seriesRepo.insertNextOccurrenceIfActive({
    series_id: series.id,
    expected_version: series.version,
    scheduled_for: next_at,
    contexto_snapshot: current.contexto_snapshot as SeriesContexto,
    correlation_token,
    tasks,
  });
}

/**
 * Backfill scheduler — runs less often than the main tick. Ensures every
 * active series has at least one pending future occurrence. Belt-and-
 * suspenders for the case where a decision flow failed to spawn the next
 * cycle (e.g., crash between `setStatus('completed')` and
 * `scheduleNextRecurring`).
 */
export async function runSeriesNextScheduler(): Promise<{ scheduled: number }> {
  if (!config.FEATURE_SCHEDULING_V2) return { scheduled: 0 };
  const orphaned = await seriesRepo.listActiveWithoutPendingOccurrence(50);
  let scheduled = 0;
  for (const s of orphaned) {
    if (!s.rrule) continue;
    try {
      const next_at = await computeNextAdvance({
        rrule: s.rrule,
        after: new Date(),
        monthEndPolicy: s.month_end_policy as MonthEndPolicy,
        entidadeId: s.entidade_id,
      });
      const tasks: Array<{ ordem: number; kind: TaskKind }> =
        s.tipo === 'recurring_payment' ? paymentTaskBlueprint() : outreachTaskBlueprint();
      const correlation_token =
        s.tipo === 'recurring_outreach' ? newCorrelationToken() : undefined;
      const result = await seriesRepo.insertNextOccurrenceIfActive({
        series_id: s.id,
        expected_version: s.version,
        scheduled_for: next_at,
        contexto_snapshot: s.contexto_template as SeriesContexto,
        correlation_token,
        tasks,
      });
      if (result.occurrence) {
        scheduled++;
        await audit({
          acao: 'occurrence_scheduled',
          alvo_id: result.occurrence.id,
          occurrence_id: result.occurrence.id,
          metadata: { series_id: s.id, source: 'backfill_scheduler' },
        });
      }
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, series_id: s.id },
        'scheduling.backfill_failed',
      );
    }
  }
  return { scheduled };
}

export function paymentTaskBlueprint(): Array<{ ordem: number; kind: TaskKind }> {
  return [
    { ordem: 1, kind: 'propose_payment' },
    { ordem: 2, kind: 'await_decision' },
    { ordem: 3, kind: 'execute_or_skip' },
  ];
}

export function outreachTaskBlueprint(): Array<{ ordem: number; kind: TaskKind }> {
  return [
    { ordem: 1, kind: 'send_outreach' },
    { ordem: 2, kind: 'await_response' },
    { ordem: 3, kind: 'forward' },
  ];
}

export function reminderTaskBlueprint(): Array<{ ordem: number; kind: TaskKind }> {
  return [{ ordem: 1, kind: 'fire_reminder' }];
}

export const _internal = { WORKER_ID, jidFromPhone };
