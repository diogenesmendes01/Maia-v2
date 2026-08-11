import { sql } from 'drizzle-orm';
import { eq, and, gt, lt } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { pending_questions } from '@/db/schema.js';
import { pendingQuestionsRepo } from '@/db/repositories.js';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { isBaileysConnected } from '@/gateway/baileys.js';
import { forCurrentAgentChannel } from '@/gateway/line-output.js';
import { audit } from '@/governance/audit.js';
import { quotedReplyContext } from '@/gateway/presence.js';
import {
  runWithTenantContext,
  getCurrentTenant,
  getCurrentAgent,
} from '@/db/tenant-context.js';

const SCAN_LIMIT = 50;
const MAX_REMINDERS = 2;

type Row = {
  id: string;
  tipo: string;
  pergunta: string;
  telefone_whatsapp: string;
  outbound_metadata: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  /** Fase 0 (spec roteamento v4 §1.6): canal da conversa do pending (NULL legado). */
  channel_id: string | null;
};

/**
 * Issue #345 (Phase 4 of #323) — per-tenant fan-out for `pending-reminder`.
 *
 * BEFORE: `runPendingReminder` opened a HARDCODED
 * `runWithTenantContext({ tenant_id: 'default', agent_id: 'default' })` and ran
 * the inner once. WORSE, the inner's raw JOIN SELECT over
 * `pending_questions`/`pessoas`/`mensagens` carried NO tenant predicate at all —
 * it relied entirely on running under a single `default` context. Under a
 * multi-tenant deployment that single pass would have scanned EVERY tenant's
 * pending questions, sent reminders cross-tenant, and stamped each reminder's
 * `metadata` UPDATE on rows belonging to other tenants — a cross-tenant
 * mutation, violating the inviolable isolation invariant.
 *
 * AFTER: the worker is a DISPATCHER. It enumerates — OUTSIDE any tenant context —
 * the DISTINCT (tenant_id, agent_id) tuples that own at least one remindable
 * pending question (`pendingQuestionsRepo.listTenantAgentPairsWithRemindableQuestions`,
 * whose predicate mirrors the inner's eligibility filter EXACTLY), then runs the
 * inner once PER tuple inside `runWithTenantContext`.
 *
 * Inner read/write scoping (the #345 "scope the inner" lesson — both were
 * unscoped before this fix):
 *   - READ: the raw JOIN SELECT now binds `pq.tenant_id = <ctx> AND
 *     pq.agent_id = <ctx>` (from `getCurrentTenant()`/`getCurrentAgent()`), so
 *     each pass reads ONLY the current tuple's pending questions. The `pessoas`
 *     and `mensagens` joins are further constrained to the SAME tenant/agent so
 *     a cross-tenant person/outbound row can never be joined in.
 *   - WRITE: the `db.update(pending_questions).set({metadata}).where(...)` in
 *     `processOne` now binds `tenant_id`/`agent_id` IN ADDITION to `id`, so the
 *     reminder-bookkeeping UPDATE can only ever touch the current tuple's row.
 *
 * Behavior-preserving in single-tenant mode: when the only remindable data lives
 * under `('default','default')`, the enumeration yields exactly that one tuple,
 * so the inner still runs once under default. Fail-isolated per tuple.
 */
export async function runPendingReminder(): Promise<void> {
  // Feature gate is checked here (cheap, no DB) so a disabled feature does not
  // even enumerate. Mirrors the inner's original first-line guard.
  if (!config.FEATURE_PENDING_REMINDER) return;
  if (!isBaileysConnected()) {
    logger.debug('pending_reminder.baileys_disconnected_skip');
    return;
  }

  const tuples =
    await pendingQuestionsRepo.listTenantAgentPairsWithRemindableQuestions(MAX_REMINDERS);

  if (tuples.length === 0) {
    logger.debug('pending_reminder.idle');
    return;
  }

  let agents_processed = 0;
  let agents_failed = 0;

  for (const { tenant_id, agent_id } of tuples) {
    try {
      await runWithTenantContext({ tenant_id, agent_id }, runPendingReminderInner);
      agents_processed++;
    } catch (err) {
      // Fail-isolated per (tenant, agent): a throw under one tuple must not
      // abort reminders for the others.
      agents_failed++;
      logger.warn(
        {
          tenant_id,
          agent_id,
          err: (err as Error).message,
          stack: (err as Error).stack,
        },
        'pending_reminder.agent_failed',
      );
    }
  }

  logger.info(
    { tuples: tuples.length, agents_processed, agents_failed },
    'pending_reminder.done',
  );
}

async function runPendingReminderInner(): Promise<void> {
  if (!config.FEATURE_PENDING_REMINDER) return;
  if (!isBaileysConnected()) {
    logger.debug('pending_reminder.baileys_disconnected_skip');
    return;
  }

  // Issue #345 (Phase 4): this inner runs ONCE PER enumerated (tenant_id,
  // agent_id) tuple. The JOIN SELECT below is a RAW `db.execute()` that does NOT
  // pass through the tenant guard, so it MUST carry an EXPLICIT (tenant_id,
  // agent_id) predicate bound from the ALS context on EVERY joined table —
  // otherwise a per-tuple run would scan EVERY tenant's pending questions (and
  // then `processOne` would UPDATE + send a reminder for foreign-tenant rows),
  // violating the inviolable cross-tenant isolation invariant. The `pessoas`
  // and `mensagens` joins are likewise pinned to the same tenant/agent.
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();

  const result = await db.execute<Row>(sql`
    SELECT
      pq.id,
      pq.tipo,
      pq.pergunta,
      p.telefone_whatsapp,
      m.metadata AS outbound_metadata,
      pq.metadata AS metadata,
      c.channel_id AS channel_id
    FROM pending_questions pq
    JOIN pessoas p
      ON p.id = pq.pessoa_id
     AND p.tenant_id = pq.tenant_id
     AND p.agent_id = pq.agent_id
    LEFT JOIN conversas c
      ON c.id = pq.conversa_id
     AND c.tenant_id = pq.tenant_id
     AND c.agent_id = pq.agent_id
    LEFT JOIN mensagens m
      ON m.direcao = 'out'
     AND m.tenant_id = pq.tenant_id
     AND m.agent_id = pq.agent_id
     AND (m.metadata->>'pending_question_id') = pq.id::text
    WHERE pq.tenant_id = ${tenant_id}
      AND pq.agent_id = ${agent_id}
      AND pq.status = 'aberta'
      AND pq.expira_em > now()
      AND pq.tipo != 'edit_review'
      AND pq.created_at < now() - interval '1 hour'
      AND COALESCE((pq.metadata->>'reminder_count')::int, 0) < ${MAX_REMINDERS}
      AND (
        pq.metadata->>'last_reminder_at' IS NULL
        OR (pq.metadata->>'last_reminder_at')::timestamptz < now() - interval '1 hour'
      )
    ORDER BY pq.created_at ASC
    LIMIT ${SCAN_LIMIT}
  `);

  for (const row of result.rows) {
    await processOne(row).catch((err) =>
      logger.warn({ err: (err as Error).message, pq_id: row.id }, 'pending_reminder.row_failed'),
    );
  }
}

async function processOne(row: Row): Promise<void> {
  if (!row.outbound_metadata) {
    await audit({
      acao: 'pending_reminder_skipped_no_outbound',
      alvo_id: row.id,
      metadata: { tipo: row.tipo },
    });
    return;
  }

  const quoted = quotedReplyContext(row.outbound_metadata, row.pergunta);
  if (!quoted) {
    await audit({
      acao: 'pending_reminder_skipped_no_outbound',
      alvo_id: row.id,
      metadata: { reason: 'invalid_metadata' },
    });
    return;
  }

  // Update last_reminder_at + reminder_count BEFORE send (idempotency: never
  // double-send). On send failure the timestamp is already advanced.
  const newCount = ((row.metadata.reminder_count as number | undefined) ?? 0) + 1;
  const newMeta = {
    ...row.metadata,
    last_reminder_at: new Date().toISOString(),
    reminder_count: newCount,
  };
  // Issue #345 (Phase 4): scope the bookkeeping UPDATE to the CURRENT
  // (tenant_id, agent_id) IN ADDITION to the row id, so this mutation can only
  // ever touch the running tuple's row — defense-in-depth even though the
  // enumeration + scoped SELECT already guarantee `row` belongs to this tuple.
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();
  // Issue #362: compare-and-swap. `pending_expirer` runs every 1min while this
  // reminder pass runs every 30min, so a row that was `aberta`/non-expired at
  // SELECT time can be flipped to `expirada` BEFORE this UPDATE lands. Re-assert
  // the eligibility invariants the SELECT used (status='aberta', expira_em >
  // now(), reminder_count < MAX_REMINDERS) directly in the WHERE so the
  // bookkeeping bump only ever applies to a STILL-VALID row. `.returning` lets us
  // detect a LOST RACE (0 rows) and skip the send instead of notifying the owner
  // about an already-expired question and corrupting `reminder_count`.
  const updated = await db
    .update(pending_questions)
    .set({ metadata: newMeta })
    .where(
      and(
        eq(pending_questions.tenant_id, tenant_id),
        eq(pending_questions.agent_id, agent_id),
        eq(pending_questions.id, row.id),
        eq(pending_questions.status, 'aberta'),
        gt(pending_questions.expira_em, sql`now()`),
        lt(
          sql`COALESCE((${pending_questions.metadata}->>'reminder_count')::int, 0)`,
          MAX_REMINDERS,
        ),
      ),
    )
    .returning({ id: pending_questions.id });

  // LOST RACE: the row was expired (or hit the reminder cap) by a concurrent
  // `pending_expirer` between the SELECT and this UPDATE. NOT an error — log,
  // audit, and skip the send. The send below is CONDITIONAL on the CAS winning.
  if (updated.length === 0) {
    logger.debug({ pq_id: row.id }, 'pending_reminder.lost_race');
    await audit({
      acao: 'pending_reminder_skipped_stale',
      alvo_id: row.id,
      metadata: { tipo: row.tipo, reason: 'expired_or_capped_between_select_and_update' },
    });
    return;
  }

  const jid = quoted.key.remoteJid;
  try {
    // Fase 0 (spec roteamento v4 §1.6): lembrete sai pela fronteira única, no
    // canal da conversa do pending (NULL legado ⇒ canal único do agente).
    const line = await forCurrentAgentChannel(row.channel_id ?? null);
    await line.sendText(jid, 'Lembra dessa? Tô aguardando.', { quoted });
    await audit({
      acao: 'pending_reminder_sent',
      alvo_id: row.id,
      metadata: { reminder_count: newCount },
    });
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, pq_id: row.id },
      'pending_reminder.send_failed',
    );
  }
}
