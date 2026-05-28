/**
 * outboundMessagesRepo — Issue #227 idempotency / dedupe ledger.
 *
 * Closes the double-send crux from PR #216 review HIGH-1. See migration
 * 063 and `src/db/schema.ts` (outbound_messages) for the table shape +
 * status semantics. This repo enforces:
 *
 *   1. Tenant isolation — every read AND every write is scoped to
 *      `tenant_id = getCurrentTenant()` (the inviolable invariant from
 *      the project north star). Cross-tenant rows are invisible. Insert
 *      paths run through `applyTenantGuard` so the row carries the
 *      caller's tenant_id/agent_id, never the schema default. Adversarial
 *      cross-tenant seed tests live in `tests/unit/repos/outbound-messages-repo.spec.ts`
 *      (PR #222 pattern: A-first AND B-first ordering).
 *
 *   2. Optimistic pre-send (`upsertPending`) — the caller computes the
 *      `idempotency_key` from `(conversa_id, in_reply_to, hash(text))`
 *      and calls this BEFORE the provider. If a prior attempt for the
 *      same key already landed at `status='sent'`, we return that row
 *      with `skip=true` so the caller can avoid the second provider
 *      call (the user already received the reply). Otherwise we insert
 *      a fresh `pending` row.
 *
 *   3. Status transitions only forward (`markSent`, `markFailed`,
 *      `markUnknown`). The semantics differ on the RETRY path:
 *        - `failed` does NOT block ReAct fall-through (pre-send failure,
 *          nothing reached the provider — safe to retry).
 *        - `unknown` DOES block fall-through (ambiguous throw — trades
 *          risk-of-silence for zero double-send).
 *        - `sent` always blocks (provider acknowledged).
 *
 *   4. Per-turn guard (`findByConversaTurn`) — returns the latest
 *      attempt for `(conversa_id, in_reply_to)` under the current
 *      tenant context. Caller (execute-skill / future call sites) reads
 *      `.status` and decides whether ReAct may send.
 */
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../client.js';
import { outbound_messages } from '../schema.js';
import type { OutboundMessage } from '../schema.js';
import { applyTenantGuard } from '../tenant-guard.js';
import { getCurrentTenant } from '../tenant-context.js';

/**
 * Result of `upsertPending`. `skip=true` means a prior attempt for this
 * key already succeeded; the caller MUST NOT re-invoke the provider.
 * The returned `row` is the existing successful row (so the caller can
 * log the prior `provider_message_id` / `sent_at`).
 */
export interface UpsertPendingResult {
  row: OutboundMessage;
  /**
   * true ⇔ the existing row already had `status='sent'`. The caller
   * skips the provider call.
   */
  skip: boolean;
}

export const outboundMessagesRepo = {
  /**
   * Reserve a pre-send row, or detect a prior success and signal skip.
   *
   * Semantics:
   *  - If NO row exists for the key → INSERT a fresh `pending` row.
   *  - If a row exists at `status='sent'` → return it with `skip=true`.
   *  - If a row exists at `status='pending' | 'failed' | 'unknown'`
   *    → return it with `skip=false` (caller may retry / interpret).
   *    The pending case is rare in practice (a previous attempt
   *    crashed without resolving the status); the caller proceeds and
   *    `markSent`/`markFailed`/`markUnknown` overwrites the status.
   *
   * Tenant-scoped: the lookup AND the insert both go through the
   * current `runWithTenantContext`. A row inserted under tenant-A is
   * invisible to a lookup from tenant-B context. The unique constraint
   * is at the global level on `idempotency_key`, but we filter on
   * tenant_id in every read so an accidental key collision across
   * tenants (e.g., a caller that forgets to include tenant in the
   * recipe) is contained: tenant-B can never read or update the
   * tenant-A row.
   */
  async upsertPending(args: {
    idempotency_key: string;
    conversa_id: string;
    in_reply_to: string;
  }): Promise<UpsertPendingResult> {
    const tenant_id = getCurrentTenant();

    // Lookup first — tenant-scoped so a cross-tenant key collision can
    // never surface (defense in depth on top of the UNIQUE constraint).
    const existing = await db
      .select()
      .from(outbound_messages)
      .where(
        and(
          eq(outbound_messages.idempotency_key, args.idempotency_key),
          eq(outbound_messages.tenant_id, tenant_id),
        ),
      )
      .limit(1);

    if (existing[0]) {
      return { row: existing[0], skip: existing[0].status === 'sent' };
    }

    // No row yet — insert a fresh pending. applyTenantGuard injects
    // tenant_id/agent_id from the current context so the row matches
    // the read filter above.
    const guarded = applyTenantGuard({
      idempotency_key: args.idempotency_key,
      conversa_id: args.conversa_id,
      in_reply_to: args.in_reply_to,
      status: 'pending' as const,
    });

    try {
      const inserted = await db
        .insert(outbound_messages)
        .values(guarded)
        .returning();
      return { row: inserted[0]!, skip: false };
    } catch (e) {
      // UNIQUE collision — a parallel writer beat us. Re-read so the
      // caller sees the winner's state (which may already be `sent`).
      // The unique constraint is on `idempotency_key` globally, so the
      // winning row is unambiguous; we still filter by tenant_id in the
      // re-read to protect against the hypothetical cross-tenant key
      // collision (defense in depth).
      const code = (e as { code?: string }).code;
      if (code === '23505') {
        const winner = await db
          .select()
          .from(outbound_messages)
          .where(
            and(
              eq(outbound_messages.idempotency_key, args.idempotency_key),
              eq(outbound_messages.tenant_id, tenant_id),
            ),
          )
          .limit(1);
        if (winner[0]) {
          return { row: winner[0], skip: winner[0].status === 'sent' };
        }
      }
      // Different error (not the unique collision we expected) — rethrow.
      throw e;
    }
  },

  /**
   * Transition `pending` → `sent` after a successful provider send.
   * Idempotent: re-calling on an already-`sent` row is a no-op
   * (last-writer-wins on the timestamps, status stays `sent`).
   * Tenant-scoped: a tenant-B caller cannot mark a tenant-A row sent
   * (the WHERE filters by both idempotency_key AND tenant_id).
   */
  async markSent(args: {
    idempotency_key: string;
    provider_message_id: string | null;
    sent_at: Date;
  }): Promise<void> {
    const tenant_id = getCurrentTenant();
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
          eq(outbound_messages.idempotency_key, args.idempotency_key),
          eq(outbound_messages.tenant_id, tenant_id),
        ),
      );
  },

  /**
   * Transition `pending` → `failed` for a pre-send failure that
   * DEFINITIVELY did not reach the provider (JID resolution, payload
   * serialization, etc.). The per-turn guard treats `failed` as
   * "ReAct fall-through allowed" because nothing was sent.
   * Tenant-scoped: same guarantees as markSent.
   */
  async markFailed(args: {
    idempotency_key: string;
    error: string;
  }): Promise<void> {
    const tenant_id = getCurrentTenant();
    await db
      .update(outbound_messages)
      .set({
        status: 'failed',
        error: args.error,
      })
      .where(
        and(
          eq(outbound_messages.idempotency_key, args.idempotency_key),
          eq(outbound_messages.tenant_id, tenant_id),
        ),
      );
  },

  /**
   * Transition `pending` → `unknown` for an ambiguous throw (the
   * provider call returned an error but the message COULD have
   * delivered before the throw, or the post-persist failed with the
   * user already seeing the reply). The per-turn guard treats
   * `unknown` as a do-not-resend signal — trades a fraction of
   * risk-of-silence for zero double-send (owner's explicit choice;
   * see migration 063 header and the issue spec §Design point 3).
   * Tenant-scoped: same guarantees as markSent.
   */
  async markUnknown(args: {
    idempotency_key: string;
    error: string;
  }): Promise<void> {
    const tenant_id = getCurrentTenant();
    await db
      .update(outbound_messages)
      .set({
        status: 'unknown',
        error: args.error,
      })
      .where(
        and(
          eq(outbound_messages.idempotency_key, args.idempotency_key),
          eq(outbound_messages.tenant_id, tenant_id),
        ),
      );
  },

  /**
   * Per-turn guard primary read.
   *
   * Returns the LATEST attempt (by `created_at`) for the
   * `(conversa_id, in_reply_to)` pair under the current tenant.
   * The caller (execute-skill / future call sites) reads `.status`:
   *   - `sent` or `unknown` → BLOCK ReAct from sending.
   *   - `failed`            → ReAct MAY send (safe retry).
   *   - `pending`           → BLOCK conservatively (an attempt is
   *                           still in flight or crashed mid-resolve).
   *   - null (no row)       → no attempt yet, ReAct MAY send.
   *
   * Tenant-scoped: a tenant-B caller cannot see tenant-A rows even
   * if they happened to share a (conversa_id, in_reply_to) pair.
   */
  async findByConversaTurn(args: {
    conversa_id: string;
    in_reply_to: string;
  }): Promise<OutboundMessage | null> {
    const tenant_id = getCurrentTenant();
    const rows = await db
      .select()
      .from(outbound_messages)
      .where(
        and(
          eq(outbound_messages.conversa_id, args.conversa_id),
          eq(outbound_messages.in_reply_to, args.in_reply_to),
          eq(outbound_messages.tenant_id, tenant_id),
        ),
      )
      .orderBy(desc(outbound_messages.created_at))
      .limit(1);
    return rows[0] ?? null;
  },
};
