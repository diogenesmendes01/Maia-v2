/**
 * Issue #316 — transactional effect outbox relayer.
 *
 * The read side of the exactly-once mechanism. The dispatcher writes an
 * intended NON-IDEMPOTENT external effect into `idempotency_effect_outbox` IN
 * THE SAME TRANSACTION as the WINNING idempotency reservation completion
 * (src/db/repositories.ts `markCompletedWithEffect`). This relayer dispatches
 * each committed pending row EXACTLY ONCE:
 *
 *   - A preempted-but-fenced owner never enqueued an effect (its markCompleted
 *     was fenced → the whole tx rolled back), so only the WINNER's effect is in
 *     the outbox. The relayer dispatches that one, exactly once.
 *   - The tool handler no longer fires the effect inline, so no physical effect
 *     escapes the atomic commit.
 *
 * SINGLE-FLIGHT (mirrors outbound-messages-sweeper #292 blocker #3): the whole
 *   pass runs under a GLOBAL advisory lock on a DEDICATED pool client, acquired
 *   at the start and released in `finally` (success AND error). If another
 *   worker instance already holds it, this pass is SKIPPED. The namespace is
 *   distinct from every other advisory-lock consumer so keyspaces never collide.
 *
 * PER-TENANT FAN-OUT + FAIRNESS (mirrors reflection-batch #240/#251): the
 *   relayer enumerates DISTINCT (tenant_id, agent_id) tuples with dispatchable
 *   pending rows and opens runWithTenantContext per tuple. Within a tenant it
 *   claims AT MOST OUTBOX_RELAYER_BATCH_PER_TENANT rows (oldest-first), so a
 *   high-volume tenant cannot starve others in one pass. NO 'default' sentinel.
 *
 * RETRY / BACKOFF: each row carries `attempts` / `max_attempts` /
 *   `next_attempt_at`. A transient dispatch failure bumps attempts, stores the
 *   error, and pushes next_attempt_at forward by an exponential backoff
 *   (base * 2^attempts, capped). When attempts exhaust max_attempts the row is
 *   transitioned to terminal 'failed' (ops_alert). A success marks 'sent' with
 *   the provider ref. Claim uses FOR UPDATE SKIP LOCKED so a crash mid-dispatch
 *   leaves the row pending for the next tick — at-least-once attempt semantics
 *   on top of the exactly-once ENQUEUE (the outbox row exists once; we retry
 *   DISPATCH until it succeeds or exhausts).
 *
 *   Crash window note (CLOSED by #327): the gateway send and `markEffectSent`
 *   are two steps. If the process crashes AFTER the send but BEFORE
 *   markEffectSent, the row stays pending and a later tick re-dispatches. To
 *   make that re-dispatch a NO-OP at the transport, `dispatchEffect` derives a
 *   DETERMINISTIC provider-side dedup key from the row's stable identity
 *   (tenant_id, agent_id, idempotency_key) and passes it on the send
 *   (`deriveProviderDedupKey` → Baileys `messageId`). The same effect always
 *   sends with the SAME WhatsApp message id, and WhatsApp keys messages on
 *   `(remoteJid, fromMe, id)`, so the duplicate send is the same message →
 *   provider/recipient dedups it. Combined with the exactly-once ENQUEUE
 *   (#316), the effect is now exactly-once END-TO-END for `whatsapp_text`. The
 *   derivation is per-effect-type (exhaustive switch): a future effect whose
 *   transport CANNOT take a client-supplied id returns null and falls back to
 *   the at-least-once tail (documented at the call site) — never a faked key.
 *
 * RETENTION: terminal rows (sent/failed) older than OUTBOX_RELAYER_RETENTION_DAYS
 *   are deleted in the same pass via a bounded batched DELETE (mirrors #292
 *   blocker #1). The dispatcher enumeration (`listTenantsWithWork`) includes a
 *   tenant that has ONLY old terminal rows (no pending) so retention reaches an
 *   IDLE tenant too — cleanup is NOT gated on the pending-dispatch path (Codex
 *   #326 blocker). A terminal-only tenant claims 0 pending rows (no dispatch)
 *   and its retention loop drains the aged rows.
 *
 * Wired into src/workers/index.ts as a phase-1 cron (every minute).
 */
import type { PoolClient } from 'pg';
import { pool } from '@/db/client.js';
import { idempotencyOutboxRepo, type ClaimedOutboxEffect } from '@/db/repositories.js';
import {
  parseEffectPayload,
  deriveProviderDedupKey,
  type PlannedEffect,
  type OutboxRowIdentity,
} from '@/governance/idempotency-effects.js';
import { forCurrentAgentChannel } from '@/gateway/line-output.js';
import { logger } from '@/lib/logger.js';
import { config } from '@/config/env.js';
import { incCounter } from '@/lib/metrics.js';
import {
  runWithTenantContext,
  getCurrentTenant,
  getCurrentAgent,
} from '@/db/tenant-context.js';

/**
 * GLOBAL single-flight advisory-lock namespace. Distinct from
 * REFLECTION_BATCH_LOCK_NAMESPACE (4711_4711n) and OUTBOUND_SWEEPER_LOCK_NAMESPACE
 * (4712_4712n) so keyspaces never collide. MUST NOT change between deploys.
 */
const OUTBOX_RELAYER_LOCK_NAMESPACE = 4713_4713n;
const OUTBOX_RELAYER_LOCK_KEY = 'idempotency_outbox_relayer';

type AcquiredLock = {
  /** Releases the lock and returns the client to the pool. Safe to call twice. */
  release: () => Promise<void>;
};

/**
 * Try to acquire the GLOBAL single-flight advisory lock. Holds it on a
 * DEDICATED pool client for the lifetime of the pass; inner queries use the
 * shared pool. Returns null when another instance holds it (pass skipped) or
 * when even acquiring a client/lock fails (treated as "couldn't acquire" — the
 * next tick retries). Mirrors outbound-messages-sweeper.tryAcquireSweepLock.
 */
async function tryAcquireRelayerLock(): Promise<AcquiredLock | null> {
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'idempotency_outbox_relayer.lock_acquire_failed',
    );
    return null;
  }

  let released = false;
  try {
    const r = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtextextended($1, $2)) AS locked`,
      [OUTBOX_RELAYER_LOCK_KEY, OUTBOX_RELAYER_LOCK_NAMESPACE.toString()],
    );
    const locked = r.rows[0]?.locked === true;
    if (!locked) {
      client.release();
      return null;
    }
  } catch (err) {
    client.release();
    logger.warn(
      { err: (err as Error).message },
      'idempotency_outbox_relayer.lock_acquire_failed',
    );
    return null;
  }

  return {
    release: async () => {
      if (released) return;
      released = true;
      try {
        await client.query(
          `SELECT pg_advisory_unlock(hashtextextended($1, $2))`,
          [OUTBOX_RELAYER_LOCK_KEY, OUTBOX_RELAYER_LOCK_NAMESPACE.toString()],
        );
      } catch (err) {
        logger.warn(
          { err: (err as Error).message },
          'idempotency_outbox_relayer.lock_release_failed',
        );
      } finally {
        client.release();
      }
    },
  };
}

/**
 * Dispatch a single validated planned effect. Returns the provider ref on
 * success; throws on a transient failure (the relayer records the retry).
 * A null return from the gateway (not connected) is treated as a transient
 * failure so the row is retried when connectivity returns.
 *
 * Issue #327 — PROVIDER-SIDE DEDUP. `identity` is the outbox row's STABLE
 * identity (tenant_id, agent_id, idempotency_key). We derive a DETERMINISTIC
 * provider-side dedup key from it (`deriveProviderDedupKey`) and pass it on the
 * send so a crash-induced re-dispatch (send succeeded but `markEffectSent` did
 * not persist before the crash) carries the SAME provider id → the transport
 * dedups the duplicate. For `whatsapp_text` this is a genuine end-to-end
 * exactly-once close: Baileys stamps the id as the message key id and WhatsApp
 * keys messages on `(remoteJid, fromMe, id)`. The per-effect-type derivation
 * keeps the switch exhaustive; a new effect type supplies its own key (or null
 * when its transport has no client-id concept).
 */
async function dispatchEffect(
  effect: PlannedEffect,
  identity: OutboxRowIdentity,
): Promise<string | null> {
  // Provider-side dedup key derived from the row's stable identity. null when
  // this effect's transport cannot accept a client-supplied id (the send then
  // proceeds without one — see deriveProviderDedupKey).
  const dedupKey = deriveProviderDedupKey(effect, identity);
  switch (effect.kind) {
    case 'whatsapp_text': {
      // Pass the deterministic message id so a re-dispatch is the SAME WhatsApp
      // message key → provider/recipient dedups instead of showing a duplicate.
      //
      // Fase 0 (spec roteamento v4 §1.6): sai pela fronteira única, sob o ALS
      // do tuple da row. O effect não carrega canal (legado) ⇒ canal único
      // ativo do agente; ambiguidade lança → retry/DLQ da própria row.
      const line = await forCurrentAgentChannel(null);
      const providerRef = await line.sendText(effect.jid, effect.text, {
        ...(dedupKey ? { messageId: dedupKey } : {}),
      });
      if (providerRef === null) {
        // Gateway not connected — transient. Throw so the row is retried.
        throw new Error('gateway_not_connected');
      }
      return providerRef;
    }
    default: {
      // Exhaustiveness: a new EffectType must add a branch here.
      const _never: never = effect.kind;
      throw new Error(`unknown_effect_type:${String(_never)}`);
    }
  }
}

/** Exponential backoff seconds for the Nth attempt (0-based), capped. */
function backoffSeconds(attempts: number): number {
  const base = config.OUTBOX_RELAYER_BASE_BACKOFF_SEC;
  const max = config.OUTBOX_RELAYER_MAX_BACKOFF_SEC;
  // base * 2^attempts, but guard against overflow for large attempt counts.
  const raw = attempts >= 30 ? max : base * 2 ** attempts;
  return Math.min(raw, max);
}

type RelayStats = { sent: number; retried: number; failed: number; invalid: number; cleaned: number };

/**
 * Per-tenant relay pass. ASSUMES the caller opened runWithTenantContext for
 * (tenant_id, agent_id) — every repo call scopes by that tuple
 * (defense-in-depth on top of the dispatcher routing).
 */
async function relayInner(): Promise<RelayStats> {
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();
  const batch = config.OUTBOX_RELAYER_BATCH_PER_TENANT;

  const claimed: ClaimedOutboxEffect[] = await idempotencyOutboxRepo.claimPendingEffects(batch);

  let sent = 0;
  let retried = 0;
  let failed = 0;
  let invalid = 0;

  for (const row of claimed) {
    // Validate the persisted payload before dispatch. A row could have been
    // written by an older code version, corrupted, or hand-edited. An invalid
    // payload can NEVER be dispatched — mark it terminally failed (ops_alert)
    // so it doesn't loop forever and ops can triage.
    const effect = parseEffectPayload(row.effect_type, row.effect_payload);
    if (!effect) {
      invalid++;
      // FORCE-TERMINAL (Codex #326 note (b)): a payload that does not
      // parse/validate can NEVER be dispatched and will NEVER become valid by
      // retrying. Flip it straight to terminal 'failed' (one step, retry budget
      // untouched) instead of burning all max_attempts ticks on a doomed row.
      const wasFailed = await idempotencyOutboxRepo.markEffectFailed({
        id: row.id,
        error: `invalid_effect_payload:${row.effect_type}`,
      });
      logger.error(
        {
          tenant_id,
          agent_id,
          outbox_id: row.id,
          effect_type: row.effect_type,
          // 'failed' when this pass performed the transition; null when a
          // concurrent settle already moved the row off 'pending' (CAS lost).
          final_status: wasFailed ? 'failed' : null,
          ops_alert: true,
        },
        'idempotency_outbox_relayer.invalid_payload',
      );
      continue;
    }

    try {
      // #327: derive the provider-side dedup key from the row's STABLE identity
      // read STRAIGHT OFF THE PERSISTED ROW (tenant_id, agent_id,
      // idempotency_key) — NOT the ambient ALS context (getCurrentTenant/Agent).
      // The key must be byte-identical across a re-dispatch (including a
      // crash-recovered one, the exact case this closes); if the ALS context
      // ever diverged from the row being dispatched the re-send would compute a
      // DIFFERENT provider id and the transport could not dedup it. Keying on
      // persisted row fields makes the derivation independent of who/what
      // context is dispatching.
      const providerRef = await dispatchEffect(effect, {
        tenant_id: row.tenant_id,
        agent_id: row.agent_id,
        idempotency_key: row.idempotency_key,
      });
      const marked = await idempotencyOutboxRepo.markEffectSent({
        id: row.id,
        provider_ref: providerRef,
      });
      if (marked) {
        sent++;
        logger.info(
          {
            tenant_id,
            agent_id,
            outbox_id: row.id,
            effect_type: row.effect_type,
            provider_ref: providerRef,
          },
          'idempotency_outbox_relayer.effect_sent',
        );
      }
    } catch (err) {
      const message = (err as Error).message;
      const finalStatus = await idempotencyOutboxRepo.markEffectRetry({
        id: row.id,
        error: message,
        backoff_seconds: backoffSeconds(row.attempts),
      });
      if (finalStatus === 'failed') {
        failed++;
        logger.error(
          {
            tenant_id,
            agent_id,
            outbox_id: row.id,
            effect_type: row.effect_type,
            attempts: row.attempts + 1,
            max_attempts: row.max_attempts,
            err: message,
            ops_alert: true,
          },
          'idempotency_outbox_relayer.effect_failed_terminal',
        );
      } else {
        retried++;
        logger.warn(
          {
            tenant_id,
            agent_id,
            outbox_id: row.id,
            effect_type: row.effect_type,
            attempts: row.attempts + 1,
            err: message,
          },
          'idempotency_outbox_relayer.effect_retry',
        );
      }
    }
  }

  // Retention cleanup: drain terminal rows past the retention window in bounded
  // batches (mirrors outbound-messages-sweeper #292 blocker #1).
  let cleaned = 0;
  const MAX_RETENTION_BATCHES = 10_000;
  for (let b = 0; b < MAX_RETENTION_BATCHES; b++) {
    const inThisBatch = await idempotencyOutboxRepo.cleanupTerminal({
      olderThanDays: config.OUTBOX_RELAYER_RETENTION_DAYS,
      batchSize: config.OUTBOX_RELAYER_RETENTION_BATCH_SIZE,
    });
    cleaned += inThisBatch;
    if (inThisBatch < config.OUTBOX_RELAYER_RETENTION_BATCH_SIZE) break;
  }

  if (sent > 0) {
    incCounter('maia_idempotency_outbox_relayer_sent_total', { tenant_id, agent_id }, sent);
  }
  if (retried > 0) {
    incCounter('maia_idempotency_outbox_relayer_retried_total', { tenant_id, agent_id }, retried);
  }
  if (failed > 0) {
    incCounter('maia_idempotency_outbox_relayer_failed_total', { tenant_id, agent_id }, failed);
  }
  if (cleaned > 0) {
    incCounter('maia_idempotency_outbox_relayer_cleaned_total', { tenant_id, agent_id }, cleaned);
  }

  return { sent, retried, failed, invalid, cleaned };
}

/**
 * Worker entrypoint. Single-flight (GLOBAL advisory lock) + per-tenant fan-out
 * (fail-isolated per tenant). Cron registered in src/workers/index.ts.
 */
export async function runIdempotencyOutboxRelayer(): Promise<void> {
  const lock = await tryAcquireRelayerLock();
  if (!lock) {
    logger.debug('idempotency_outbox_relayer.skipped_locked');
    return;
  }

  try {
    // Enumerate tenants with ANY work: a dispatchable pending row OR a terminal
    // row past the retention window. The terminal-row arm makes retention
    // cleanup reach an IDLE tenant that has ONLY old terminal rows (Codex #326
    // blocker) — cleanup is no longer gated on the pending-dispatch path.
    const tenants = await idempotencyOutboxRepo.listTenantsWithWork(
      config.OUTBOX_RELAYER_RETENTION_DAYS,
    );
    if (tenants.length === 0) {
      logger.debug('idempotency_outbox_relayer.idle');
      return;
    }

    let totalSent = 0;
    let totalRetried = 0;
    let totalFailed = 0;
    let totalInvalid = 0;
    let totalCleaned = 0;
    let tenantsProcessed = 0;
    let tenantsFailed = 0;

    for (const { tenant_id, agent_id } of tenants) {
      try {
        const stats = await runWithTenantContext({ tenant_id, agent_id }, () => relayInner());
        totalSent += stats.sent;
        totalRetried += stats.retried;
        totalFailed += stats.failed;
        totalInvalid += stats.invalid;
        totalCleaned += stats.cleaned;
        tenantsProcessed++;
      } catch (err) {
        // Fail-isolated: one tenant's error must not abort the relayer.
        tenantsFailed++;
        logger.warn(
          {
            tenant_id,
            agent_id,
            err: (err as Error).message,
            stack: (err as Error).stack,
          },
          'idempotency_outbox_relayer.tenant_failed',
        );
      }
    }

    logger.info(
      {
        tenants: tenants.length,
        tenants_processed: tenantsProcessed,
        tenants_failed: tenantsFailed,
        sent: totalSent,
        retried: totalRetried,
        failed: totalFailed,
        invalid: totalInvalid,
        cleaned: totalCleaned,
      },
      'idempotency_outbox_relayer.done',
    );
  } finally {
    await lock.release();
  }
}
