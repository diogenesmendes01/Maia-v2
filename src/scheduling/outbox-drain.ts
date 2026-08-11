/**
 * Spec 18 §7.1 + §7.2 — outbox drain worker.
 *
 * Claims due outbox rows under backpressure, sends each via the
 * appropriate channel, and reconciles success/failure with retry +
 * eventual DLQ. The state contract:
 *
 *   pending ─claim▶ claimed ─send_ok▶ sent
 *                       │
 *                       ├─send_fail (attempts<max)▶ pending (+backoff)
 *                       └─send_fail (attempts=max)▶ dead
 *
 * Concurrency is bounded by `OUTBOX_WORKER_CONCURRENCY`; per-send
 * backpressure is applied via `tryAcquireSendSlot` in `backpressure.ts`.
 * If the rate gate denies the send, the row is returned to `pending`
 * with `next_attempt_at = now() + backoff` so the next tick retries.
 *
 * Idempotency: every enqueue carries a `dedup_key` keyed by occurrence_id
 * + task_ordem + purpose. The UNIQUE partial index in migration 007
 * rejects duplicates; enqueue treats the unique-violation as success.
 */

import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { audit } from '@/governance/audit.js';
import { forCurrentAgentChannel, type LineOutput } from '@/gateway/line-output.js';
import { sendAlert } from '@/lib/alerts.js';
import { outboxRepo, occurrencesRepo, tasksRepo } from './repos.js';
import { tryAcquireSendSlot, releasePaceKey } from './backpressure.js';
import type {
  EmailAlertPayload,
  WhatsappAlertPayload,
  WhatsappTextPayload,
} from './types.js';
import type { OutboxMessage } from '@/db/schema.js';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

const WORKER_ID = `${hostname()}:outbox:${process.pid}:${randomUUID().slice(0, 8)}`;
const CLAIM_LIMIT = 50;
const RETRY_BACKOFF_BASE_SECONDS = 30;

/** Polynomial backoff: 30s, 60s, 120s, 240s, 480s, ... capped at 1h. */
function backoffSeconds(attempts: number): number {
  return Math.min(3600, RETRY_BACKOFF_BASE_SECONDS * 2 ** Math.max(0, attempts - 1));
}

export async function runOutboxDrain(): Promise<{
  reclaimed: number;
  drained: number;
  sent: number;
  failed: number;
  rate_limited: number;
}> {
  // Reclaim leases from crashed workers — these go back to `pending` so
  // the regular `claimDue` below picks them up in this same tick.
  // Blocker 2: the previous version returned reclaimed rows but never
  // processed them; outbox rows could sit `claimed` indefinitely.
  const reclaimedIds = await outboxRepo.reclaimExpiredLeases(
    WORKER_ID,
    config.OUTBOX_LEASE_TTL_SECONDS,
    CLAIM_LIMIT,
  );

  const due = await outboxRepo.claimDue(WORKER_ID, CLAIM_LIMIT);
  if (due.length === 0)
    return { reclaimed: reclaimedIds.length, drained: 0, sent: 0, failed: 0, rate_limited: 0 };

  // Process under bounded concurrency.
  const concurrency = Math.max(1, config.OUTBOX_WORKER_CONCURRENCY);
  let cursor = 0;
  let sent = 0;
  let failed = 0;
  let rate_limited = 0;

  async function worker(): Promise<void> {
    while (cursor < due.length) {
      const idx = cursor++;
      const msg = due[idx]!;
      const r = await processOne(msg).catch((err) => {
        logger.warn(
          { err: (err as Error).message, outbox_id: msg.id },
          'outbox_drain.unexpected_error',
        );
        return 'failed' as const;
      });
      if (r === 'sent') sent++;
      else if (r === 'rate_limited') rate_limited++;
      else failed++;
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { reclaimed: reclaimedIds.length, drained: due.length, sent, failed, rate_limited };
}

async function processOne(msg: OutboxMessage): Promise<'sent' | 'failed' | 'rate_limited'> {
  // Channel-specific send.
  const channel = pickChannel(msg);
  if (!channel) {
    await outboxRepo.markDead(msg.id, `unknown_kind:${msg.kind}`);
    await audit({
      acao: 'outbox_dead',
      alvo_id: msg.id,
      occurrence_id: msg.occurrence_id,
      metadata: { kind: msg.kind, reason: 'unknown_kind' },
    });
    return 'failed';
  }

  // Backpressure gate (only for whatsapp channels — emails go via spec 17).
  // Review PR #496 (alto 4): a linha é resolvida ANTES do gate e a
  // conectividade checada NA LINHA-ALVO (`line.isConnected()`), não na sessão
  // global — com N linhas, a global conectada não prova nada sobre a linha da
  // row (markSent fantasma) e a global caída não pode bloquear uma linha
  // adicional saudável. Falha de RESOLUÇÃO (channel_ambiguous / scope
  // mismatch) cai na mesma máquina de retry/DLQ do send.
  let line: LineOutput | null = null;
  if (channel.requiresBaileys) {
    try {
      line = await forCurrentAgentChannel(msg.channel_id ?? null);
    } catch (err) {
      return handleSendFailure(msg, err as Error);
    }
    if (!line.isConnected()) {
      await outboxRepo.returnToPending(msg.id);
      return 'rate_limited';
    }
    const decision = await tryAcquireSendSlot(channel.jid!);
    if (decision.kind === 'deny') {
      // Schedule a backoff that respects the cause:
      //   per_second → 1s    per_recipient → 2s    per_hour → 60s    redis_down → 30s
      const wait =
        decision.reason === 'per_second' ? 1 :
        decision.reason === 'per_recipient' ? 2 :
        decision.reason === 'per_hour' ? 60 : 30;
      await outboxRepo.markFailedRetryable(msg.id, `rate_limit:${decision.reason}`, wait);
      return 'rate_limited';
    }
  }

  try {
    const providerRef = await channel.send(line);
    // Review PR #496 (alto 4): o transporte devolve null quando a linha caiu
    // entre o gate e o send (LineTransport devolve null sem sessão viva) —
    // tratar como FALHA RETRYABLE; seguir adiante marcaria como `sent` algo
    // que nunca saiu (perda silenciosa violando o ledger).
    if (channel.requiresBaileys && providerRef == null) {
      throw new Error('whatsapp_send_returned_null (line disconnected mid-send?)');
    }
  } catch (err) {
    if (channel.jid) await releasePaceKey(channel.jid).catch(() => null);
    return handleSendFailure(msg, err as Error);
  }

  await outboxRepo.markSent(msg.id);
  await audit({
    acao: 'outbox_sent',
    alvo_id: msg.id,
    occurrence_id: msg.occurrence_id,
    metadata: { kind: msg.kind },
  });

  // Confirm task completion after a successful send. This is the
  // contract change for Blocker 3 (review 2): the forward task is NO
  // LONGER marked completed in the engine right after enqueue. The
  // outbox-drain only marks it completed here, after the send actually
  // succeeded. For other task kinds (fire_reminder, send_outreach,
  // propose_payment) the same logic applies — task completes on send.
  if (msg.task_id && msg.kind === 'whatsapp_text') {
    await tasksRepo.setStatus(msg.task_id, 'completed', { sent_outbox_id: msg.id });
    if (msg.occurrence_id) {
      const occ = await occurrencesRepo.byId(msg.occurrence_id);
      if (occ && occ.status === 'in_progress') {
        // one_shot_reminder fires and is done. For recurring_outreach
        // the occurrence is already `awaiting_third_party` (engine
        // flipped before enqueue) — we don't touch it. For the
        // recurring_outreach FORWARD step the occurrence is `in_progress`
        // and the engine's next tick lands on branch (c) which finalizes.
        // We mark `completed` here only when the task that just sent
        // is the `fire_reminder` kind (one_shot_reminder).
        const tasks = await tasksRepo.byOccurrence(occ.id);
        const self = tasks.find((t) => t.id === msg.task_id);
        if (self?.kind === 'fire_reminder') {
          await occurrencesRepo.setStatus(occ.id, 'completed', { outcome: 'fired' });
          await audit({
            acao: 'occurrence_completed',
            alvo_id: occ.id,
            occurrence_id: occ.id,
            metadata: { kind: msg.kind },
          });
        }
      }
    }
  }
  return 'sent';
}

/**
 * Máquina de retry/DLQ compartilhada entre falha de RESOLUÇÃO de linha e
 * falha de SEND (review PR #496 alto 4 — a resolução passou a acontecer
 * antes do gate e precisa do mesmo destino: attempts++, retryable até
 * max_attempts, depois dead + consequências de scheduling + alerta).
 */
async function handleSendFailure(msg: OutboxMessage, err: Error): Promise<'failed'> {
  const newAttempts = msg.attempts + 1;
  if (newAttempts >= msg.max_attempts) {
    await outboxRepo.markDead(msg.id, err.message);
    await audit({
      acao: 'outbox_dead',
      alvo_id: msg.id,
      occurrence_id: msg.occurrence_id,
      metadata: { kind: msg.kind, attempts: newAttempts, error: err.message },
    });
    // Blocker 3 (review 2): if the dead message was an outreach
    // FORWARD or a one_shot_reminder FIRE, the underlying task must
    // be marked failed and the occurrence must NOT remain a phantom
    // success. `onMessageDead` looks up the task kind and updates
    // accordingly.
    await onMessageDead({
      ...msg,
      last_error: err.message,
    } as OutboxMessage).catch(() => null);
    await sendAlert({
      subject: `Outbox DLQ: ${msg.kind}`,
      body: `Outbox row ${msg.id} reached max_attempts (${newAttempts}). Error: ${err.message}`,
    }).catch(() => null);
    return 'failed';
  }
  const backoff = backoffSeconds(newAttempts);
  await outboxRepo.markFailedRetryable(msg.id, err.message, backoff);
  await audit({
    acao: 'outbox_failed',
    alvo_id: msg.id,
    occurrence_id: msg.occurrence_id,
    metadata: { kind: msg.kind, attempts: newAttempts, backoff_seconds: backoff },
  });
  return 'failed';
}

/**
 * Called from `markDead` path to handle scheduling-specific consequences
 * of a dead outbox message (forward never sent → mark forward task
 * failed and the occurrence failed; the series stays alive but this
 * cycle is recorded as a failure).
 */
async function onMessageDead(msg: OutboxMessage): Promise<void> {
  if (!msg.task_id) return;
  try {
    const tasks = await tasksRepo.byOccurrence(msg.occurrence_id ?? '');
    const self = tasks.find((t) => t.id === msg.task_id);
    if (!self) return;
    await tasksRepo.setStatus(self.id, 'failed', {
      dead_outbox_id: msg.id,
      last_error: msg.last_error ?? 'unknown',
    });
    if (msg.occurrence_id) {
      // For forward step we fail the occurrence so the operator sees a
      // distinct failure rather than a silent ghost-success.
      if (self.kind === 'forward' || self.kind === 'fire_reminder') {
        await occurrencesRepo.setStatus(msg.occurrence_id, 'failed', {
          metadata_patch: { reason: 'outbox_dead', task_kind: self.kind },
        });
        await audit({
          acao: 'occurrence_failed',
          alvo_id: msg.occurrence_id,
          occurrence_id: msg.occurrence_id,
          metadata: { reason: 'outbox_dead', task_kind: self.kind },
        });
      }
    }
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, outbox_id: msg.id },
      'outbox_drain.on_dead_failed',
    );
  }
}

type Channel =
  | {
      kind: 'whatsapp';
      requiresBaileys: true;
      jid: string;
      /** Recebe a linha JÁ resolvida/gated pelo processOne (nunca null aqui). */
      send: (line: LineOutput | null) => Promise<unknown>;
    }
  | { kind: 'email'; requiresBaileys: false; jid: null; send: (line: LineOutput | null) => Promise<unknown> };

function pickChannel(msg: OutboxMessage): Channel | null {
  const payload = msg.payload as unknown;
  switch (msg.kind) {
    case 'whatsapp_text':
    case 'whatsapp_alert': {
      const p = payload as WhatsappTextPayload | WhatsappAlertPayload;
      return {
        kind: 'whatsapp',
        requiresBaileys: true,
        jid: p.jid,
        // Fase 0 (spec roteamento v4 §1.6): o drain roda sob o ALS do tuple e
        // envia pela fronteira única, no canal da PRÓPRIA row (o CHECK de 090
        // garante channel_id em rows pending/claimed novas; NULL legado
        // resolve o canal único do agente). A linha chega JÁ resolvida e
        // gated pelo processOne (review #496 alto 4); o retorno é o provider
        // id — null vira falha retryable no chamador.
        send: (line) => line!.sendText(p.jid, p.text),
      };
    }
    case 'whatsapp_pending_question': {
      void payload; // reserved for future poll-mode usage; engine currently
                    // enqueues the pergunta as `whatsapp_text` so it goes
                    // through the standard send path.
      return null;
    }
    case 'email_alert': {
      const p = payload as EmailAlertPayload;
      return {
        kind: 'email',
        requiresBaileys: false,
        jid: null,
        send: () => sendAlert({ subject: p.subject, body: p.body }),
      };
    }
    default:
      return null;
  }
}
