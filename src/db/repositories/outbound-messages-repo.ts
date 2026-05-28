/**
 * outboundMessagesRepo — Issue #227 idempotency / dedupe ledger.
 *
 * Closes the double-send crux from PR #216 review HIGH-1. See migration
 * 065 and `src/db/schema.ts` (outbound_messages) for the table shape +
 * status semantics. This repo enforces:
 *
 *   1. Tenant isolation — every read AND every write is scoped to
 *      `tenant_id = getCurrentTenant()` AND `agent_id = getCurrentAgent()`
 *      (the inviolable invariant from the project north star). The
 *      UNIQUE is composite on `(tenant_id, agent_id, idempotency_key)`
 *      so cross-tenant key collisions never surface. Adversarial
 *      cross-tenant seed tests live in
 *      `tests/unit/repos/outbound-messages-repo.spec.ts` (PR #222
 *      pattern: A-first AND B-first ordering).
 *
 *   2. Atomic pre-send claim (`upsertPending`) — uses Postgres-native
 *      `INSERT ... ON CONFLICT ON CONSTRAINT outbound_messages_turn_uniq
 *      DO UPDATE` with a WHERE clause that ONLY overwrites a stale
 *      pending row (created_at older than the 30s stale threshold) OR
 *      a `failed` row. The conflict target is the TURN-LEVEL UNIQUE
 *      `(tenant_id, agent_id, conversa_id, in_reply_to)` — picked so
 *      a same-turn / different-content race (two workers, different
 *      idempotency_keys, same turn) is caught here too: both writers
 *      conflict on the TURN even when their keys differ. The
 *      per-key UNIQUE
 *      `(tenant_id, agent_id, idempotency_key)` stays in place for
 *      cross-turn same-content dedupe (post-content retries with the
 *      same hash short-circuit on the prior row). The RETURNING
 *      exposes `xmax = 0` AND `idempotency_key AS existing_key` so
 *      the caller can distinguish:
 *        - Race A/B same turn, SAME content → one inserts, the other
 *          sees existing_key=winner's_key (idempotent retry).
 *        - Race A/B same turn, DIFF content → one inserts, the other
 *          sees existing_key ≠ candidate_key → caller MUST skip
 *          (terminal-skip, owner's "zero double-send" choice).
 *        - DB drop mid-claim → stale pending gets reclaimed after 30s.
 *        - markSent failure → pending becomes stale and is recoverable.
 *
 *   3. CAS-guarded transitions (`markSent`, `markFailed`,
 *      `markUnknown`) — `markFailed`/`markUnknown` carry
 *      `WHERE status NOT IN ('sent', 'unknown')` so a stale background
 *      retry CAN NEVER degrade a `sent`/`unknown` row. `markSent` is
 *      idempotent (last-writer-wins on success metadata). The
 *      RETURNING is used to detect a no-op (the row was already at a
 *      higher status) — we log and proceed rather than throw.
 *
 *   4. Per-turn guard (`findByConversaTurn`) — returns the latest
 *      attempt for `(conversa_id, in_reply_to)` under the current
 *      tenant + agent context. Caller (execute-skill / future call
 *      sites) reads `.status` and decides whether ReAct may send.
 *      `unknown` is TERMINAL-SKIP (does NOT cascade to ReAct) per
 *      owner's "rare silence > zero double-send" trade-off.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../client.js';
import { outbound_messages } from '../schema.js';
import type { OutboundMessage } from '../schema.js';
import { getCurrentTenant, getCurrentAgent } from '../tenant-context.js';
import { logger } from '@/lib/logger.js';

/**
 * Stale-pending threshold. A `pending` row older than this is
 * considered abandoned (the previous claim crashed mid-resolve, or
 * `markSent`/`markFailed`/`markUnknown` failed) and is reclaimable
 * via ON CONFLICT DO UPDATE. 30s is generous enough for any normal
 * provider timeout but short enough that user-visible retry latency
 * stays bounded.
 */
export const STALE_PENDING_SECONDS = 30;

/**
 * Result of `upsertPending`. Four orthogonal signals the caller maps to
 * its own send decision:
 *  - `inserted` true ⇔ THIS caller atomically claimed the row (it is
 *     the winner of any race). The caller MUST proceed with the send.
 *  - `inserted` false + `skip` true ⇔ a prior attempt for this turn
 *     ALREADY succeeded (status='sent'). The caller MUST NOT re-invoke
 *     the provider; the returned `row` carries the prior
 *     `provider_message_id`.
 *  - `inserted` false + `skip` false + `existing_key === candidate_key`
 *     ⇔ a prior attempt is `pending`/`failed`/`unknown` with the SAME
 *     content. Idempotent retry — caller decides based on status.
 *  - `inserted` false + `existing_key !== candidate_key` ⇔ another
 *     worker is processing the SAME TURN with DIFFERENT content. The
 *     caller MUST treat this as TERMINAL-SKIP (zero double-send) per
 *     owner choice — emit audit and DO NOT send.
 *
 * `existing_key` reflects the idempotency_key of whichever row currently
 * sits in the table for this turn — for the winner this equals the
 * candidate key it just inserted; for losers it's the WINNER's key.
 * The caller compares it against its own candidate key to detect the
 * "same turn, different content" race.
 */
export interface UpsertPendingResult {
  row: OutboundMessage;
  /**
   * true ⇔ THIS call atomically inserted the row (claim winner). The
   * caller has exclusive rights to send. Derived from Postgres
   * `xmax = 0` on the RETURNING clause (a freshly-inserted row has
   * xmax=0; an UPDATE-by-conflict has the conflicting xact's id).
   */
  inserted: boolean;
  /**
   * true ⇔ the existing row already had `status='sent'`. The caller
   * skips the provider call.
   */
  skip: boolean;
  /**
   * The `idempotency_key` of the row that currently holds the turn
   * claim. When `inserted=true` this equals the candidate key. When
   * `inserted=false`, the caller compares this against the candidate
   * key it supplied to detect the same-turn-different-content race:
   *   - existing_key === candidate_key → idempotent same-content retry.
   *   - existing_key !== candidate_key → DIFFERENT content racing on
   *     the SAME turn; caller MUST skip the send (terminal-skip).
   */
  existing_key: string;
}

export const outboundMessagesRepo = {
  /**
   * Atomic pre-send claim via `INSERT ON CONFLICT DO UPDATE`.
   *
   * Race-safe by construction: two concurrent claims for the same
   * `(tenant_id, agent_id, conversa_id, in_reply_to)` both attempt
   * the INSERT; Postgres serialises the conflict and applies the
   * DO UPDATE branch to the loser. The conflict target is the
   * TURN-LEVEL UNIQUE (one row per turn across all idempotency keys)
   * so a same-turn / different-content race is caught here — both
   * writers conflict on the turn even when their idempotency_keys
   * differ. The DO UPDATE clause OVERWRITES the row only when the
   * existing row is `failed` OR a stale `pending` (older than
   * `STALE_PENDING_SECONDS`) — otherwise the UPDATE is filtered out
   * by WHERE and the prior row is returned as-is.
   *
   * The `was_inserted` flag (derived from `xmax = 0` in RETURNING)
   * tells the caller whether IT claimed the row. The `existing_key`
   * returned alongside lets the caller detect the same-turn /
   * different-content race:
   *   - inserted=true                              → claim winner
   *   - inserted=false + existing_key=candidate    → idempotent same-
   *                                                  content retry
   *   - inserted=false + existing_key≠candidate    → SAME TURN, DIFF
   *                                                  CONTENT race;
   *                                                  caller MUST skip
   *                                                  the send (no
   *                                                  double-send).
   *
   * Tenant-scoped: the conflict target includes `(tenant_id,
   * agent_id, ...)`. Cross-tenant collisions are physically
   * impossible (different rows in the unique index).
   */
  async upsertPending(args: {
    idempotency_key: string;
    conversa_id: string;
    in_reply_to: string;
  }): Promise<UpsertPendingResult> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();

    // ON CONFLICT DO UPDATE — atomic claim with stale-pending recovery.
    //
    // Conflict target: the TURN-LEVEL UNIQUE
    // `(tenant_id, agent_id, conversa_id, in_reply_to)`. Picked
    // instead of the per-key UNIQUE to catch the same-turn /
    // different-content race (two workers, same turn, different
    // payload hash → different keys → both would otherwise INSERT).
    //
    // The WHERE clause on the DO UPDATE makes the overwrite CONDITIONAL:
    //   - `failed` rows are always reclaimable (pre-send failure, safe
    //     to retry).
    //   - `pending` rows are reclaimable only when older than
    //     STALE_PENDING_SECONDS (abandoned attempt).
    //   - `sent`/`unknown`/recent-`pending` rows are NOT overwritten;
    //     the UPDATE is filtered out by WHERE, and RETURNING returns
    //     no row. We fall through to a SELECT to surface the existing
    //     row below.
    //
    // The `was_inserted = (xmax = 0)` trick: Postgres assigns
    // xmax=0 to a freshly-inserted tuple; an UPDATE-by-conflict
    // carries the conflicting transaction's id. This is the canonical
    // pattern for distinguishing insert vs update in a single
    // upsert (Postgres docs: "Concurrency Control" §UPSERT).
    //
    // RETURNING also exposes `idempotency_key AS existing_key` so the
    // caller knows WHICH key now owns the turn — same-turn / different-
    // content racers see existing_key ≠ candidate_key and skip.
    type Returned = {
      id: string;
      tenant_id: string;
      agent_id: string;
      idempotency_key: string;
      conversa_id: string;
      in_reply_to: string;
      provider_message_id: string | null;
      status: 'pending' | 'sent' | 'failed' | 'unknown';
      sent_at: Date | null;
      error: string | null;
      created_at: Date;
      expires_at: Date;
      was_inserted: boolean;
      existing_key: string;
    };
    const result = await db.execute<Returned>(sql`
      INSERT INTO outbound_messages (
        tenant_id, agent_id, idempotency_key, conversa_id, in_reply_to, status
      ) VALUES (
        ${tenant_id}, ${agent_id}, ${args.idempotency_key},
        ${args.conversa_id}::uuid, ${args.in_reply_to}::uuid, 'pending'
      )
      ON CONFLICT ON CONSTRAINT outbound_messages_turn_uniq
      DO UPDATE SET
        status = 'pending',
        idempotency_key = EXCLUDED.idempotency_key,
        provider_message_id = NULL,
        sent_at = NULL,
        error = NULL,
        created_at = now(),
        expires_at = now() + INTERVAL '30 days'
      WHERE
        outbound_messages.status = 'failed'
        OR (
          outbound_messages.status = 'pending'
          AND outbound_messages.created_at < now() - (${STALE_PENDING_SECONDS}::text || ' seconds')::interval
        )
      RETURNING *, (xmax = 0) AS was_inserted, idempotency_key AS existing_key
    `);

    const rows = Array.from(result.rows as unknown as Returned[]);
    const row = rows[0] ?? null;

    if (!row) {
      // Conflict matched a NON-reclaimable row (sent / unknown /
      // recent pending) — the DO UPDATE WHERE filtered the UPDATE out
      // and RETURNING produced no row. Re-read the existing row by
      // the TURN (not the key — the existing row may carry a
      // different key when this is a same-turn/different-content
      // race).
      const existing = await db
        .select()
        .from(outbound_messages)
        .where(
          and(
            eq(outbound_messages.tenant_id, tenant_id),
            eq(outbound_messages.agent_id, agent_id),
            eq(outbound_messages.conversa_id, args.conversa_id),
            eq(outbound_messages.in_reply_to, args.in_reply_to),
          ),
        )
        .limit(1);
      if (!existing[0]) {
        // Extremely unlikely race: conflict was filtered out AND the
        // row vanished before our re-read. Fail loudly — the caller's
        // outer try/catch in sendOutbound treats this as a ledger
        // outage and proceeds without the ledger (fail-open by design).
        throw new Error(
          'outbound_ledger_invariant: ON CONFLICT filtered + row missing on re-read',
        );
      }
      return {
        row: existing[0],
        inserted: false,
        skip: existing[0].status === 'sent',
        existing_key: existing[0].idempotency_key,
      };
    }

    const wasInserted = Boolean(row.was_inserted);
    const typed: OutboundMessage = {
      id: row.id,
      tenant_id: row.tenant_id,
      agent_id: row.agent_id,
      idempotency_key: row.idempotency_key,
      conversa_id: row.conversa_id,
      in_reply_to: row.in_reply_to,
      provider_message_id: row.provider_message_id ?? null,
      status: row.status,
      sent_at: row.sent_at ?? null,
      error: row.error ?? null,
      created_at: row.created_at,
      expires_at: row.expires_at,
    };
    return {
      row: typed,
      inserted: wasInserted,
      // The DO UPDATE branch above resets `status = 'pending'` on a
      // successful reclaim, so `skip` here only ever surfaces on the
      // NO-row path above (handled separately). Defensive check.
      skip: typed.status === 'sent',
      // Source-of-truth for the same-turn / different-content guard.
      // For the winner this equals the candidate key (we just INSERT-
      // ed it). For a reclaim of a stale/failed row the DO UPDATE
      // overwrites idempotency_key with EXCLUDED.idempotency_key, so
      // this is the CALLER's key in that branch too.
      existing_key: row.existing_key ?? row.idempotency_key,
    };
  },

  /**
   * Transition pending → sent after a successful provider send.
   *
   * Idempotent: re-calling on an already-`sent` row updates the
   * timestamps and provider_message_id. The CAS guard is implicit —
   * `sent` is terminal forward, last-writer-wins is acceptable on
   * the success metadata.
   *
   * Tenant + agent-scoped: a tenant-B caller cannot mark a tenant-A
   * row sent (the WHERE filters by tenant_id, agent_id, idempotency_key).
   */
  async markSent(args: {
    idempotency_key: string;
    provider_message_id: string | null;
    sent_at: Date;
  }): Promise<void> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    await db
      .update(outbound_messages)
      .set({
        status: 'sent',
        provider_message_id: args.provider_message_id,
        sent_at: args.sent_at,
        error: null,
      })
      .where(
        and(
          eq(outbound_messages.tenant_id, tenant_id),
          eq(outbound_messages.agent_id, agent_id),
          eq(outbound_messages.idempotency_key, args.idempotency_key),
        ),
      );
  },

  /**
   * Transition pending → failed for a pre-send failure that
   * DEFINITIVELY did not reach the provider (JID resolution, payload
   * serialization, etc.).
   *
   * CAS-guarded: `WHERE status NOT IN ('sent', 'unknown')` so a stale
   * background `markFailed` CAN NEVER degrade a row that already
   * reached `sent` or `unknown`. The RETURNING is inspected; if the
   * row was not updated (already at a higher status), we log and
   * no-op rather than throw — the higher status is the correct
   * outcome (no double-send risk; pre-send failure is the safe state).
   *
   * Tenant + agent-scoped: same guarantees as markSent.
   */
  async markFailed(args: {
    idempotency_key: string;
    error: string;
  }): Promise<void> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const updated = await db
      .update(outbound_messages)
      .set({
        status: 'failed',
        error: args.error,
      })
      .where(
        and(
          eq(outbound_messages.tenant_id, tenant_id),
          eq(outbound_messages.agent_id, agent_id),
          eq(outbound_messages.idempotency_key, args.idempotency_key),
          // CAS — never degrade `sent` or `unknown`.
          sql`${outbound_messages.status} NOT IN ('sent', 'unknown')`,
        ),
      )
      .returning({ id: outbound_messages.id });
    if (updated.length === 0) {
      logger.info(
        { idempotency_key: args.idempotency_key, tenant_id, agent_id },
        'outbound_ledger.mark_failed_noop_higher_status',
      );
    }
  },

  /**
   * Transition pending → unknown for an ambiguous throw (provider
   * call errored after a possible partial relay, or post-persist
   * failed with the user already seeing the reply).
   *
   * CAS-guarded: `WHERE status NOT IN ('sent', 'unknown')` so we never
   * overwrite a `sent` row (the higher confidence). `unknown` ↔
   * `unknown` is a no-op (idempotent). The per-turn guard treats
   * `unknown` as a TERMINAL-SKIP signal — owner's "zero double-send"
   * choice (see migration 065 header).
   *
   * Tenant + agent-scoped: same guarantees as markSent.
   */
  async markUnknown(args: {
    idempotency_key: string;
    error: string;
  }): Promise<void> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const updated = await db
      .update(outbound_messages)
      .set({
        status: 'unknown',
        error: args.error,
      })
      .where(
        and(
          eq(outbound_messages.tenant_id, tenant_id),
          eq(outbound_messages.agent_id, agent_id),
          eq(outbound_messages.idempotency_key, args.idempotency_key),
          // CAS — never degrade `sent`. `unknown` → `unknown` is a
          // no-op (excluded by the same predicate, so RETURNING is
          // empty; we log and proceed).
          sql`${outbound_messages.status} NOT IN ('sent', 'unknown')`,
        ),
      )
      .returning({ id: outbound_messages.id });
    if (updated.length === 0) {
      logger.info(
        { idempotency_key: args.idempotency_key, tenant_id, agent_id },
        'outbound_ledger.mark_unknown_noop_higher_status',
      );
    }
  },

  /**
   * Per-turn guard primary read.
   *
   * Returns the LATEST attempt (by `created_at`) for the
   * `(conversa_id, in_reply_to)` pair under the current tenant +
   * agent. The caller (execute-skill / future call sites) reads
   * `.status`:
   *   - `sent` or `unknown` → BLOCK ReAct from sending (terminal-skip).
   *   - `failed`            → ReAct MAY send (safe retry).
   *   - `pending`           → BLOCK conservatively (an attempt is
   *                           still in flight or crashed mid-resolve).
   *   - null (no row)       → no attempt yet, ReAct MAY send.
   *
   * Tenant + agent-scoped: a tenant-B (or agent-B) caller cannot see
   * tenant-A rows even if they happened to share a (conversa_id,
   * in_reply_to) pair.
   */
  async findByConversaTurn(args: {
    conversa_id: string;
    in_reply_to: string;
  }): Promise<OutboundMessage | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(outbound_messages)
      .where(
        and(
          eq(outbound_messages.conversa_id, args.conversa_id),
          eq(outbound_messages.in_reply_to, args.in_reply_to),
          eq(outbound_messages.tenant_id, tenant_id),
          eq(outbound_messages.agent_id, agent_id),
        ),
      )
      .orderBy(desc(outbound_messages.created_at))
      .limit(1);
    return rows[0] ?? null;
  },
};
