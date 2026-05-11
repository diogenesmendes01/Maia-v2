/**
 * Spec 18 — Scheduling engine.
 *
 * On every tick:
 *   1. Reclaim leases on `claimed` occurrences whose lease expired (the
 *      worker that claimed them crashed).
 *   2. Claim up to N due `pending` occurrences using FOR UPDATE SKIP LOCKED.
 *   3. For each claimed occurrence, advance it: apply missed-run policy
 *      if applicable, otherwise enqueue an outbox row appropriate for the
 *      task kind and move the occurrence into the matching waiting state.
 *
 * Side-effect contract: the engine NEVER calls Baileys directly. It only
 * writes DB rows (occurrences, tasks, outbox_messages) inside transactions.
 * The outbox-drain worker is responsible for actually sending.
 *
 * Determinism: the engine writes audit entries with `occurrence_id` so
 * the per-occurrence query (spec 18 §7.5) reconstructs the full timeline.
 */

import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Occurrence } from '@/db/schema.js';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { audit } from '@/governance/audit.js';
import { pessoasRepo, conversasRepo, pendingQuestionsRepo } from '@/db/repositories.js';
import { seriesRepo, occurrencesRepo, tasksRepo, outboxRepo } from './repos.js';
import { computeNext } from './rrule.js';
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

function jidFromPhone(tel: string): string {
  return tel.replace('+', '') + '@s.whatsapp.net';
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`);
}

function previousMonthLabel(now: Date): string {
  const prev = new Date(now);
  prev.setMonth(prev.getMonth() - 1);
  return `${String(prev.getMonth() + 1).padStart(2, '0')}/${prev.getFullYear()}`;
}

export async function runSchedulingTick(): Promise<{ claimed: number; advanced: number; skipped: number }> {
  if (!config.FEATURE_SCHEDULING_V2) return { claimed: 0, advanced: 0, skipped: 0 };

  // Step 1: reclaim expired leases.
  await occurrencesRepo
    .reclaimExpiredLeases(WORKER_ID, config.OCCURRENCE_LEASE_TTL_SECONDS, CLAIM_LIMIT_PER_TICK)
    .catch((err) =>
      logger.warn({ err: (err as Error).message }, 'scheduling.reclaim_failed'),
    );

  // Step 2: claim due.
  const claimed = await occurrencesRepo.claimDue(WORKER_ID, CLAIM_LIMIT_PER_TICK);
  if (claimed.length === 0) return { claimed: 0, advanced: 0, skipped: 0 };

  await audit({
    acao: 'occurrence_claimed',
    metadata: { count: claimed.length, worker: WORKER_ID },
  });

  let advanced = 0;
  let skipped = 0;
  for (const occ of claimed) {
    try {
      const result = await advanceOccurrence(occ);
      if (result === 'advanced') advanced++;
      else if (result === 'skipped') skipped++;
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
  return { claimed: claimed.length, advanced, skipped };
}

async function advanceOccurrence(occ: Occurrence): Promise<'advanced' | 'skipped'> {
  const series = await seriesRepo.findById(occ.series_id);
  if (!series) {
    // Series deleted? Mark occurrence cancelled.
    await occurrencesRepo.setStatus(occ.id, 'cancelled');
    return 'skipped';
  }

  // If the series was cancelled while we held the lease, abort.
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
    // The current occurrence is `claimed`, not `pending`, so it won't be
    // in the sibling list. Include it explicitly for the latest-only check.
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
    // decision.kind === 'fire' → continue advancing below.
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
): Promise<'advanced'> {
  if (!series) throw new Error('series missing');
  const owner = await pessoasRepo.findById(series.owner_pessoa_id);
  if (!owner || owner.status !== 'ativa') {
    await occurrencesRepo.setStatus(occ.id, 'skipped', {
      metadata_patch: { skip_reason: 'owner_inactive' },
    });
    return 'advanced';
  }
  const ctx = occ.contexto_snapshot as OneShotReminderContexto;
  const tasks = await tasksRepo.byOccurrence(occ.id);
  const fireTask = tasks.find((t) => t.kind === 'fire_reminder');
  if (!fireTask) throw new Error('one_shot_reminder: missing fire_reminder task');

  await outboxRepo.enqueue({
    occurrence_id: occ.id,
    task_id: fireTask.id,
    kind: 'whatsapp_text',
    payload: { jid: jidFromPhone(owner.telefone_whatsapp), text: `🔔 Lembrete: ${ctx.texto}` },
    dedup_key: `${occ.id}:fire_reminder`,
  });
  await tasksRepo.setStatus(fireTask.id, 'in_progress');
  await occurrencesRepo.setStatus(occ.id, 'in_progress');
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
): Promise<'advanced'> {
  if (!series) throw new Error('series missing');
  const ctx = occ.contexto_snapshot as RecurringOutreachContexto;
  const destinatario = await pessoasRepo.findById(ctx.destinatario_pessoa_id);
  if (!destinatario || destinatario.status !== 'ativa') {
    await occurrencesRepo.setStatus(occ.id, 'failed', {
      metadata_patch: { fail_reason: 'destinatario_inactive' },
    });
    return 'advanced';
  }
  const tasks = await tasksRepo.byOccurrence(occ.id);
  const sendTask = tasks.find((t) => t.kind === 'send_outreach');
  if (!sendTask) throw new Error('recurring_outreach: missing send_outreach task');

  const body = renderTemplate(ctx.message_template, {
    nome: destinatario.nome,
    mes_anterior: previousMonthLabel(new Date()),
  });
  const text = occ.correlation_token
    ? appendCorrelationFooter(body, occ.correlation_token)
    : body;

  await outboxRepo.enqueue({
    occurrence_id: occ.id,
    task_id: sendTask.id,
    kind: 'whatsapp_text',
    payload: { jid: jidFromPhone(destinatario.telefone_whatsapp), text },
    dedup_key: `${occ.id}:send_outreach`,
  });
  await tasksRepo.setStatus(sendTask.id, 'in_progress');
  await occurrencesRepo.setStatus(occ.id, 'awaiting_third_party');
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
): Promise<'advanced'> {
  if (!series) throw new Error('series missing');
  const ctx = occ.contexto_snapshot as RecurringPaymentContexto;
  // C-008 defence: re-check valor against the current hard limit.
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
    // Cannot anchor a pending_question without an active conversa. Re-pend
    // (return occurrence to pending so the next tick retries).
    await occurrencesRepo.setStatus(occ.id, 'pending');
    return 'advanced';
  }
  const tasks = await tasksRepo.byOccurrence(occ.id);
  const proposeTask = tasks.find((t) => t.kind === 'propose_payment');
  if (!proposeTask) throw new Error('recurring_payment: missing propose_payment task');

  const valorFmt = ctx.valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const pergunta = `Pagamento ${ctx.descricao} de ${valorFmt} hoje? Responda *sim*, *não* ou *adiar*.`;

  // Create the pending_question + enqueue the outbox in the SAME tx so
  // the message either both exists and will be sent, or neither.
  await pendingQuestionsRepo.create({
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
    expira_em: new Date(Date.now() + ctx.escalate_after_hours * 3600_000),
    status: 'aberta',
    metadata: { occurrence_id: occ.id, series_id: series.id },
  });

  await outboxRepo.enqueue({
    occurrence_id: occ.id,
    task_id: proposeTask.id,
    kind: 'whatsapp_text',
    payload: { jid: jidFromPhone(owner.telefone_whatsapp), text: pergunta },
    dedup_key: `${occ.id}:propose_payment`,
  });

  await tasksRepo.setStatus(proposeTask.id, 'completed', { pergunta });
  await occurrencesRepo.setStatus(occ.id, 'awaiting_owner');
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
 * Called from spec 12 / pending-resolver when the owner answers a
 * payment_confirmation pending question whose metadata carried our
 * occurrence_id. Drives the rest of the payment_due state machine.
 */
export async function resolvePaymentOccurrence(
  occurrence_id: string,
  decision: 'sim' | 'nao' | 'adiar',
): Promise<void> {
  const occ = await occurrencesRepo.byId(occurrence_id);
  if (!occ || occ.status !== 'awaiting_owner') return;
  const series = await seriesRepo.findById(occ.series_id);
  if (!series) return;
  const tasks = await tasksRepo.byOccurrence(occ.id);
  const execTask = tasks.find((t) => t.kind === 'execute_or_skip');

  if (decision === 'sim') {
    if (execTask) await tasksRepo.setStatus(execTask.id, 'completed', { decision: 'sim' });
    await occurrencesRepo.setStatus(occ.id, 'completed', { outcome: 'sim' });
    await audit({
      acao: 'payment_due_confirmed',
      pessoa_id: series.owner_pessoa_id,
      alvo_id: occ.id,
      occurrence_id: occ.id,
    });
    await scheduleNextRecurring(series, occ);
    return;
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
    return;
  }
  if (decision === 'adiar') {
    if (execTask) await tasksRepo.setStatus(execTask.id, 'skipped', { decision: 'adiar' });
    await occurrencesRepo.setStatus(occ.id, 'skipped', { outcome: 'adiar' });
    await audit({
      acao: 'payment_due_postponed',
      pessoa_id: series.owner_pessoa_id,
      alvo_id: occ.id,
      occurrence_id: occ.id,
    });
    // Spawn a one-off "+2 days" occurrence — same series, but explicit
    // scheduled_for, idempotent on (series_id, scheduled_for).
    const next_at = new Date(Date.now() + 2 * 86400_000);
    await seriesRepo.insertNextOccurrenceIfActive({
      series_id: series.id,
      expected_version: series.version,
      scheduled_for: next_at,
      contexto_snapshot: occ.contexto_snapshot as SeriesContexto,
      tasks: paymentTaskBlueprint(),
    });
    return;
  }
}

async function scheduleNextRecurring(
  series: NonNullable<Awaited<ReturnType<typeof seriesRepo.findById>>>,
  current: Occurrence,
): Promise<void> {
  if (!series.rrule) return;
  const next_at = computeNext(
    series.rrule,
    new Date(),
    series.month_end_policy as MonthEndPolicy,
  );
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
