import { eq, and, sql, ne } from 'drizzle-orm';
import { db, withTx } from '../client.js';
import { idempotency_keys, idempotency_effect_outbox } from '../schema.js';
import { logger } from '@/lib/logger.js';
import { incCounter } from '@/lib/metrics.js';
import { applyTenantGuard } from '../tenant-guard.js';
import { getCurrentTenant, getCurrentAgent } from '../tenant-context.js';
import type { PlannedEffect } from '@/governance/idempotency-effects.js';
import { isVersionedPayloadHash } from '@/governance/idempotency.js';
import type { Tenant } from '../schema.js';

/**
 * idempotencyRepo — tool idempotency cache (`idempotency_keys` table).
 *
 * TENANT/AGENT-ISOLATION (issue #261). The `idempotency_keys` table has
 * `tenant_id` + `agent_id` columns (migrations 009/012). Before #261 both
 * `lookup` and `store` ignored both columns — `lookup` filtered ONLY by
 * `key`, and `store` relied on column defaults (`'default'`). That allowed
 * two tenants invoking the same tool with the same params to collide in
 * the cache and leak each other's tool output.
 *
 * After #261:
 *   - `lookup` pins `tenant_id = <ctx> AND agent_id = <ctx> AND key = <key>`
 *     in the WHERE. Defense in depth on top of the hash-input change in
 *     `computeIdempotencyKey` (src/governance/idempotency.ts).
 *   - `store` writes through `applyTenantGuard`, which stamps the routed
 *     `tenant_id`/`agent_id` and throws on mismatch. `onConflictDoNothing`
 *     now targets the new composite PK `(tenant_id, agent_id, key)` per
 *     migration 063, so a same-key collision across tenants does NOT silent-
 *     swallow the second insert.
 *   - `cleanup` stays global on purpose: it's a maintenance sweep run by
 *     `workers/idempotency-cleanup.ts` and intentionally crosses tenants.
 *     It does NOT read or return tool output, so it cannot leak — it only
 *     prunes by `created_at`. The cleanup worker bootstraps with the system
 *     tenant context for audit; the SQL itself stays unscoped.
 */

/**
 * Reservation outcome from `idempotencyRepo.tryReserve` (issue #298).
 *
 * Discriminated by `was_inserted`:
 *   - `was_inserted=true`: this caller WON the reservation. They MUST run
 *     the handler and then call `markCompleted` (success) or
 *     `releaseReservation` (failure), ALWAYS passing back the
 *     `reservation_token` returned here. `state` will be 'in_progress' and
 *     `resultado` will be undefined.
 *   - `was_inserted=false`: someone else's row was already there. Inspect
 *     `state`:
 *       - 'completed': use `resultado` as the cached output (cache hit) —
 *         ONLY returned when the stored row's `payload_hash` MATCHES the
 *         caller's `input.payload_hash` (see 'collision' below).
 *       - 'in_progress': another worker is mid-execution. The caller MUST
 *         NOT execute the handler; it should poll for completion (see
 *         `waitForCompletion`).
 *       - 'failed': a prior attempt for this exact key terminally FAILED
 *         (issue #298 B3). The caller MUST NOT silently re-execute — the
 *         failed handler may have applied a partial side effect. The
 *         dispatcher surfaces a typed error so any retry is an explicit,
 *         higher-level decision.
 *       - 'collision' (issue #299): a SETTLED ('completed') row exists for
 *         this exact (tenant, agent, key) but its stored `payload_hash`
 *         DIFFERS from the caller's. That means the idempotency key collided
 *         for two distinct payloads (truncated hash, derivator regression,
 *         or stale cache after a schema change). Returning the stored
 *         `resultado` would hand back a result computed for a DIFFERENT
 *         payload — a silent wrong side effect. We FAIL CLOSED: the caller
 *         MUST NOT use `resultado` (it is undefined here) and MUST NOT
 *         re-execute under the colliding key (that would clobber the other
 *         payload's cached result). The dispatcher surfaces a typed error.
 *         The collision is logged + metered inside `tryReserve`.
 *
 * Fencing token (issue #298 B2): on a winning reservation, `reservation_token`
 * is a freshly minted UUID. The owner MUST present it to `markCompleted` /
 * `releaseReservation`; those calls only mutate the row when the token still
 * matches. A slow owner whose lease expired and was reclaimed by a new owner
 * holds a STALE token, so its late completion is a no-op and cannot clobber
 * the new owner — closing the double-execution window of the fixed-TTL
 * reclaim. `reservation_token` is `undefined` on the non-winning branches
 * (the caller has nothing to complete).
 */
export type ReservationResult =
  | {
      was_inserted: true;
      state: 'in_progress';
      resultado: undefined;
      reservation_token: string;
    }
  | {
      was_inserted: false;
      state: 'completed';
      resultado: unknown;
      reservation_token: undefined;
    }
  | {
      was_inserted: false;
      state: 'in_progress';
      resultado: undefined;
      reservation_token: undefined;
    }
  | {
      was_inserted: false;
      state: 'failed';
      resultado: undefined;
      reservation_token: undefined;
    }
  | {
      // #299: settled row's payload_hash differs from the caller's — key
      // collision. Fail closed; never expose the foreign `resultado`.
      was_inserted: false;
      state: 'collision';
      resultado: undefined;
      reservation_token: undefined;
    };

/**
 * #318 (migration-window fix): decide whether a stored vs. expected
 * `payload_hash` mismatch is a REAL key collision that must fail closed.
 *
 * Background. #318 changed the BYTES `computePayloadHash` emits (per-segment
 * `encodeURIComponent` before the `'|'` join) to defeat a delimiter-aliasing
 * collision. Idempotency rows written BEFORE this build deploys store an
 * OLD-format hash with NO version prefix. The #299/#301 revalidation compares
 * the freshly computed (new-format) hash against the stored value; against a
 * legacy row it would NEVER match, so a legit idempotent retry would be
 * mis-reported as a `collision` (fail-closed typed error) for the row's whole
 * remaining TTL — breaking real retries across the deploy window.
 *
 * Rule. `computePayloadHash` now tags its output with
 * `PAYLOAD_HASH_VERSION_PREFIX` (`v2:`), so:
 *   - STORED hash is versioned (`v2:`-prefixed) AND differs from the expected
 *     (also versioned) hash → REAL collision. Strict #299/#301 revalidation
 *     is preserved for all new-vs-new comparisons.
 *   - STORED hash is LEGACY (no `v2:` prefix) → NOT a collision. A legacy hash
 *     can't be revalidated against the new encoding; we fall back to pre-#318
 *     behavior (return the cached result / wait-resolve normally). Legacy rows
 *     expire shortly under the bucket-minute TTL + cleanup sweep, so the
 *     window is bounded and there is no double-execution risk.
 *
 * Equality is exact-string. The expected hash is always current-format (it
 * comes from `computePayloadHash`), so a versioned-stored == expected check is
 * a strict same-format comparison. Tenant isolation is unaffected: the caller
 * has already scoped the row by `(tenant_id, agent_id, key)` in its WHERE
 * clause; this predicate only inspects the hash strings.
 */
function isRealPayloadHashCollision(
  storedPayloadHash: string,
  expectedPayloadHash: string,
): boolean {
  // Legacy stored hash (pre-#318, no version prefix) → cannot revalidate →
  // never a collision (fall back to the pre-#318 hit/wait-resolve behavior).
  if (!isVersionedPayloadHash(storedPayloadHash)) return false;
  // Both current-format: strict #299/#301 revalidation.
  return storedPayloadHash !== expectedPayloadHash;
}

/**
 * #299: emit the structured warn + collision metric and return the typed
 * `collision` reservation result. Shared by both `tryReserve` 'completed'
 * branches (initial SELECT + post-reclaim recheck) so the observability and
 * fail-closed shape stay identical. Mirrors the same event name / metric the
 * legacy `lookup` path uses, so dashboards see one signal regardless of which
 * code path detected the collision.
 */
function reportPayloadHashCollision(
  input: { key: string; payload_hash: string },
  stored: { payload_hash: string },
): ReservationResult {
  logger.warn(
    {
      event: 'idempotency_key_collision_payload_mismatch',
      key: input.key,
      stored_payload_hash: stored.payload_hash,
      expected_payload_hash: input.payload_hash,
    },
    'idempotency.payload_hash_mismatch',
  );
  incCounter('maia_idempotency_payload_hash_collision_total');
  return {
    was_inserted: false,
    state: 'collision',
    resultado: undefined,
    reservation_token: undefined,
  };
}

export const idempotencyRepo = {
  /**
   * Legacy read-only lookup with payload-hash revalidation (#299), state
   * filtering (#298) and tenant/agent scoping (#261).
   *
   * Use `tryReserve` for the atomic dispatcher path; this helper exists for
   * backward compat with non-dispatch callers (tests, one-off inspections).
   * The dispatcher itself no longer calls `lookup` — but it carries the
   * SAME three-layer defense so any non-dispatch caller is protected too.
   *
   * Three-layer defense against a wrong-result cache hit:
   *
   * 1. Tenant/agent scope (#261). The WHERE pins `tenant_id = <ctx> AND
   *    agent_id = <ctx> AND key = <key>`. `getCurrentTenant`/`getCurrentAgent`
   *    throw `MissingTenantContextError` if no ALS context — we refuse a
   *    silent fall-through to the legacy `'default'` bucket. Defense in
   *    depth on top of the hash-input change in `computeIdempotencyKey`
   *    (src/governance/idempotency.ts).
   *
   * 2. State filtering (#298). We filter `state <> 'in_progress'` (rather
   *    than `state = 'completed'`) so that:
   *      - 'completed' → returns `resultado` (the cache hit).
   *      - 'in_progress' → EXCLUDED. An in-flight reservation has no result
   *        yet; surfacing it would make the caller skip execution and return
   *        undefined to the user (silent data loss).
   *      - 'failed' → carries a NULL `resultado`, so it yields a miss.
   *      - pre-#298 rows (written before the `state` column existed) are
   *        treated as settled and still hit, preserving the pre-existing
   *        same-scope idempotency contract.
   *
   * 3. Payload-hash revalidation (#299). The cache key is
   *    `computeIdempotencyKey(...)` — a fingerprint of the inputs PLUS a
   *    bucket-minutes timestamp. If two distinct requests in the same scope
   *    collide on that key (truncated hash, regression in the derivator that
   *    drops a discriminant field, or stale cached payload after a schema
   *    change), the older result would be returned for the NEW request and
   *    the side effect would be silently wrong.
   *
   *    `payload_hash` is an independent SHA256 over (pessoa, entity, tool,
   *    op, normalized_payload | file_sha256). On a hit we verify that the
   *    STORED row's hash matches the EXPECTED hash; on mismatch we treat as
   *    a miss, warn, and bump a metric so we can detect drift.
   *
   * Note on existing rows: rows stored before this fix have
   * `payload_hash == key` (legacy `store` from _dispatcher.ts). Those rows
   * fail revalidation against a real payload_hash and are treated as a miss.
   * Acceptable: the bucket-minute TTL + cleanup worker drain stale rows.
   */
  async lookup(input: { key: string; payload_hash: string }): Promise<unknown | null> {
    // Resolve tenant/agent — `getCurrentTenant`/`getCurrentAgent` throw
    // `MissingTenantContextError` if no context. We refuse a silent
    // fall-through to the legacy `'default'` bucket (see header #261).
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(idempotency_keys)
      .where(
        and(
          eq(idempotency_keys.tenant_id, tenant_id),
          eq(idempotency_keys.agent_id, agent_id),
          eq(idempotency_keys.key, input.key),
          // #298: never surface an in-flight reservation as a cache hit.
          ne(idempotency_keys.state, 'in_progress'),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    // #318: only a CURRENT-format (v2:-prefixed) stored hash that differs is a
    // real collision. A legacy (pre-#318, unprefixed) stored hash can't be
    // revalidated against the new encoding → treat as a hit (pre-#318
    // behavior); it expires shortly under the bucket-minute TTL.
    if (isRealPayloadHashCollision(row.payload_hash, input.payload_hash)) {
      // #299: collision detected within tenant scope. Log + metric so we
      // can detect drift. Treat as miss so caller re-executes.
      logger.warn(
        {
          event: 'idempotency_key_collision_payload_mismatch',
          key: input.key,
          stored_payload_hash: row.payload_hash,
          expected_payload_hash: input.payload_hash,
          stored_tool_name: row.tool_name,
        },
        'idempotency.payload_hash_mismatch',
      );
      incCounter('maia_idempotency_payload_hash_collision_total');
      return null;
    }
    return row.resultado;
  },

  /**
   * Issue #298: atomic reservation. Replaces the racey check-then-act in
   * the dispatcher.
   *
   * Single round-trip:
   *   - INSERT a new row with state='in_progress', expires_at=now()+TTL,
   *     resultado=NULL.
   *   - ON CONFLICT (PK = `(tenant_id, agent_id, key)`) DO NOTHING. If a row already exists,
   *     INSERT is a no-op; otherwise the row is created.
   *   - RETURNING (xmax = 0) AS was_inserted, state, resultado. The xmax
   *     trick: on a fresh insert, xmax=0; on a no-op caused by
   *     ON CONFLICT DO NOTHING, xmax is the *current* transaction's xid
   *     (non-zero). So `xmax = 0` is the canonical "I inserted vs row was
   *     already there" probe.
   *
   * Stale-reservation reclaim: if an existing row is state='in_progress'
   * AND expires_at < now(), it's an orphan (the previous worker crashed
   * before completing). The reclaim path runs an UPDATE … WHERE
   * state='in_progress' AND expires_at < now() — at most one caller wins
   * the update (UPDATE … RETURNING is atomic). Winner re-acquires the
   * reservation; losers see the winner's freshened row on next poll.
   *
   * The repository writes through `applyTenantGuard` (defense in depth:
   * even before PR #273's composite PK lands, the tenant_id/agent_id
   * columns are stamped from ALS context, so cross-tenant collisions are
   * prevented at the application layer).
   */
  async tryReserve(input: {
    key: string;
    tool_name: string;
    operation_type: string;
    pessoa_id: string;
    entity_id: string;
    payload_hash: string;
    file_sha256?: string;
    ttl_seconds: number;
  }): Promise<ReservationResult> {
    // applyTenantGuard stamps tenant_id/agent_id from ALS context and
    // rejects any explicit mismatch. Throws MissingTenantContextError if
    // no context. The atomic-reservation path is dispatcher-driven and
    // always runs inside runWithTenantContext (webhook routes, scheduler).
    const guarded = applyTenantGuard({
      key: input.key,
      tool_name: input.tool_name,
      operation_type: input.operation_type,
      pessoa_id: input.pessoa_id,
      entity_id: input.entity_id,
      payload_hash: input.payload_hash,
      file_sha256: input.file_sha256 ?? null,
      state: 'in_progress' as const,
    });

    // Step 1: try INSERT … ON CONFLICT DO NOTHING. RETURNING captures
    // both the "I inserted" probe and the existing-row state in the same
    // round-trip — no separate SELECT needed in the common path.
    // NOTE: `(xmax = 0)` is the Postgres ON CONFLICT DO NOTHING idiom for
    // distinguishing inserted vs pre-existing rows. With RETURNING, the
    // row body returned is the inserted-or-existing row in either case.
    //
    // Fencing token (B2): `gen_random_uuid()::text` mints a per-reservation
    // token server-side, atomic with the INSERT. The winner gets it back in
    // RETURNING and must echo it on markCompleted/releaseReservation; a
    // preempted owner's stale token can never match the row after a reclaim.
    const ttl = `${input.ttl_seconds} seconds`;
    const inserted = await db.execute<{
      was_inserted: boolean;
      state: string;
      resultado: unknown;
      expires_at: string | null;
      reservation_token: string | null;
    }>(sql`
      INSERT INTO idempotency_keys
        (key, tenant_id, agent_id, tool_name, operation_type, pessoa_id,
         entity_id, payload_hash, file_sha256, resultado, state, expires_at,
         reservation_token)
      VALUES
        (${guarded.key}, ${guarded.tenant_id}, ${guarded.agent_id},
         ${guarded.tool_name}, ${guarded.operation_type}, ${guarded.pessoa_id},
         ${guarded.entity_id}, ${guarded.payload_hash}, ${guarded.file_sha256},
         NULL, 'in_progress', now() + ${ttl}::interval, gen_random_uuid()::text)
      ON CONFLICT (tenant_id, agent_id, key) DO NOTHING
      RETURNING (xmax = 0) AS was_inserted, state, resultado, expires_at,
                reservation_token
    `);

    const firstRow = inserted.rows[0];
    if (firstRow && firstRow.was_inserted) {
      return {
        was_inserted: true,
        state: 'in_progress',
        resultado: undefined,
        reservation_token: firstRow.reservation_token ?? '',
      };
    }

    // Step 2: ON CONFLICT triggered (or RETURNING returned the
    // existing-but-not-inserted row). SELECT the row to inspect state.
    // We tenant-scope the read; if PR #273 merges (composite PK), this
    // also matches the new PK shape.
    const existingRows = await db
      .select({
        state: idempotency_keys.state,
        resultado: idempotency_keys.resultado,
        expires_at: idempotency_keys.expires_at,
        // #299: needed to revalidate the cached payload on a 'completed' hit.
        payload_hash: idempotency_keys.payload_hash,
      })
      .from(idempotency_keys)
      .where(
        and(
          eq(idempotency_keys.tenant_id, guarded.tenant_id),
          eq(idempotency_keys.agent_id, guarded.agent_id),
          eq(idempotency_keys.key, input.key),
        ),
      )
      .limit(1);

    const existing = existingRows[0];
    if (!existing) {
      // Extremely narrow race: row was deleted between ON CONFLICT and
      // SELECT (cleanup worker or down-migration). Treat as "couldn't
      // reserve" — caller re-enters. We retry the insert once to recover
      // cleanly without bubbling up a misleading error.
      const retry = await db.execute<{
        was_inserted: boolean;
        reservation_token: string | null;
      }>(sql`
        INSERT INTO idempotency_keys
          (key, tenant_id, agent_id, tool_name, operation_type, pessoa_id,
           entity_id, payload_hash, file_sha256, resultado, state, expires_at,
           reservation_token)
        VALUES
          (${guarded.key}, ${guarded.tenant_id}, ${guarded.agent_id},
           ${guarded.tool_name}, ${guarded.operation_type}, ${guarded.pessoa_id},
           ${guarded.entity_id}, ${guarded.payload_hash}, ${guarded.file_sha256},
           NULL, 'in_progress', now() + ${ttl}::interval, gen_random_uuid()::text)
        ON CONFLICT (tenant_id, agent_id, key) DO NOTHING
        RETURNING (xmax = 0) AS was_inserted, reservation_token
      `);
      if (retry.rows[0]?.was_inserted) {
        return {
          was_inserted: true,
          state: 'in_progress',
          resultado: undefined,
          reservation_token: retry.rows[0].reservation_token ?? '',
        };
      }
      // Still lost — fall through to a "stale" view; caller will poll and
      // either find a completed row or time out.
      return {
        was_inserted: false,
        state: 'in_progress',
        resultado: undefined,
        reservation_token: undefined,
      };
    }

    if (existing.state === 'completed') {
      // #299: revalidate the cached payload before returning it as a hit.
      // A 'completed' row whose stored payload_hash differs from ours is a
      // key collision (two distinct payloads mapped to the same key). Fail
      // closed — never expose the foreign result.
      // #318: only enforce this when the STORED hash is current-format
      // (v2:-prefixed). A legacy (pre-#318) stored hash can't be revalidated
      // against the new encoding, so a mismatch there is NOT a collision —
      // return the cached result (pre-#318 behavior); the row expires shortly.
      if (isRealPayloadHashCollision(existing.payload_hash, input.payload_hash)) {
        return reportPayloadHashCollision(input, existing);
      }
      return {
        was_inserted: false,
        state: 'completed',
        resultado: existing.resultado,
        reservation_token: undefined,
      };
    }

    if (existing.state === 'failed') {
      // Terminal failure (B3). A prior attempt for this exact key failed;
      // its handler may have applied a partial side effect. We do NOT
      // reclaim or re-run here — the caller (dispatcher) surfaces a typed
      // error so any retry is an explicit, higher-level decision. The
      // failed row is pruned later by `cleanup`.
      return {
        was_inserted: false,
        state: 'failed',
        resultado: undefined,
        reservation_token: undefined,
      };
    }

    // state='in_progress'. Check if expired — if so, try to reclaim.
    // Atomic UPDATE … WHERE state='in_progress' AND expires_at < now()
    // ensures at most one caller wins the reclaim. The reclaim MINTS A
    // FRESH reservation_token (B2): the previous (crashed or preempted)
    // owner still holds the OLD token, so its late markCompleted/
    // releaseReservation — gated on `reservation_token` — becomes a no-op
    // and cannot resurrect or clobber the row the reclaimer now owns.
    if (existing.expires_at && new Date(existing.expires_at) < new Date()) {
      const reclaimed = await db.execute<{ reservation_token: string | null }>(sql`
        UPDATE idempotency_keys
           SET expires_at = now() + ${ttl}::interval,
               reservation_token = gen_random_uuid()::text,
               tool_name = ${guarded.tool_name},
               operation_type = ${guarded.operation_type},
               pessoa_id = ${guarded.pessoa_id},
               entity_id = ${guarded.entity_id},
               payload_hash = ${guarded.payload_hash},
               file_sha256 = ${guarded.file_sha256}
         WHERE tenant_id = ${guarded.tenant_id}
           AND agent_id = ${guarded.agent_id}
           AND key = ${input.key}
           AND state = 'in_progress'
           AND expires_at < now()
         RETURNING reservation_token
      `);
      if (reclaimed.rows.length > 0) {
        return {
          was_inserted: true,
          state: 'in_progress',
          resultado: undefined,
          reservation_token: reclaimed.rows[0]!.reservation_token ?? '',
        };
      }
      // Reclaim lost (someone else got it, or row transitioned to
      // completed/failed). Re-check current state.
      const recheck = await db
        .select({
          state: idempotency_keys.state,
          resultado: idempotency_keys.resultado,
          // #299: revalidate the cached payload on a 'completed' recheck.
          payload_hash: idempotency_keys.payload_hash,
        })
        .from(idempotency_keys)
        .where(
          and(
            eq(idempotency_keys.tenant_id, guarded.tenant_id),
            eq(idempotency_keys.agent_id, guarded.agent_id),
            eq(idempotency_keys.key, input.key),
          ),
        )
        .limit(1);
      const recheckRow = recheck[0];
      if (recheckRow?.state === 'completed') {
        // #299: same collision guard as the first 'completed' branch.
        // #318: legacy-aware — only a current-format (v2:) stored hash that
        // differs is a real collision; a legacy stored hash is treated as a
        // hit (pre-#318 behavior).
        if (isRealPayloadHashCollision(recheckRow.payload_hash, input.payload_hash)) {
          return reportPayloadHashCollision(input, recheckRow);
        }
        return {
          was_inserted: false,
          state: 'completed',
          resultado: recheckRow.resultado,
          reservation_token: undefined,
        };
      }
      if (recheckRow?.state === 'failed') {
        return {
          was_inserted: false,
          state: 'failed',
          resultado: undefined,
          reservation_token: undefined,
        };
      }
      return {
        was_inserted: false,
        state: 'in_progress',
        resultado: undefined,
        reservation_token: undefined,
      };
    }

    return {
      was_inserted: false,
      state: 'in_progress',
      resultado: undefined,
      reservation_token: undefined,
    };
  },

  /**
   * Transition an in_progress reservation to completed and persist the
   * handler's result. Idempotent on the (tenant, agent, key) — if the
   * row is already 'completed' (e.g., a duplicate completion attempt),
   * we keep the existing resultado (the WHERE state='in_progress' makes
   * it a no-op).
   *
   * Fencing (B2): `reservation_token` MUST be the token returned by the
   * winning `tryReserve` for THIS reservation. The UPDATE is gated on
   * `reservation_token = <token>`, so an owner whose lease expired and was
   * reclaimed (the reclaim minted a NEW token) can no longer complete: its
   * stale token doesn't match, the UPDATE touches 0 rows, and the new
   * owner's reservation is preserved. Returns whether the row was actually
   * transitioned (true) or the completion was fenced out / already settled
   * (false) so the caller can detect a preemption.
   */
  async markCompleted(input: {
    key: string;
    resultado: unknown;
    reservation_token: string;
  }): Promise<boolean> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const updated = await db
      .update(idempotency_keys)
      .set({
        resultado: input.resultado as object,
        state: 'completed',
        expires_at: null,
      })
      .where(
        and(
          eq(idempotency_keys.tenant_id, tenant_id),
          eq(idempotency_keys.agent_id, agent_id),
          eq(idempotency_keys.key, input.key),
          eq(idempotency_keys.state, 'in_progress'),
          eq(idempotency_keys.reservation_token, input.reservation_token),
        ),
      )
      .returning({ key: idempotency_keys.key });
    return updated.length > 0;
  },

  /**
   * ABANDONA a reserva (issue #504 §Fencing): o handler NUNCA rodou.
   *
   * Diferente de `releaseReservation`, isto APAGA a row em vez de deixá-la
   * 'failed', e a diferença é a única que importa aqui: 'failed' é terminal
   * justamente porque um handler que rodou e falhou pode ter aplicado efeito
   * parcial. Quando a tentativa perde a posse do turno ANTES do handler não há
   * efeito nenhum a fencear — e deixar 'failed' fecharia a chave contra o
   * worker que TEM a lease vigente, que receberia `idempotency_prior_failed`
   * por uma execução que nunca existiu. Ou seja: o fence do turno viraria uma
   * negação de serviço sobre o dono legítimo.
   *
   * Fencing (B2): gated no `reservation_token` e em `state='in_progress'`,
   * como as demais transições. Um dono preemptado carrega token velho e o
   * DELETE não toca a reserva viva do novo dono. Devolve se apagou de fato.
   */
  async abandonReservation(input: {
    key: string;
    reservation_token: string;
  }): Promise<boolean> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const deleted = await db
      .delete(idempotency_keys)
      .where(
        and(
          eq(idempotency_keys.tenant_id, tenant_id),
          eq(idempotency_keys.agent_id, agent_id),
          eq(idempotency_keys.key, input.key),
          eq(idempotency_keys.state, 'in_progress'),
          eq(idempotency_keys.reservation_token, input.reservation_token),
        ),
      )
      .returning({ key: idempotency_keys.key });
    return deleted.length > 0;
  },

  /**
   * Mark a reservation as terminally FAILED (issue #298 B3).
   *
   * Previously this DELETEd the in_progress row so the next caller could
   * re-claim with a fresh INSERT. That let the SAME idempotency key be
   * silently re-executed after a failure — dangerous when the failed
   * handler already applied a partial side effect (the caller would see a
   * cache MISS and run the handler again). We now transition
   * in_progress→'failed', a TERMINAL state: a subsequent same-key
   * `tryReserve` reports the failure to the caller instead of re-running.
   * The coherence CHECK requires (failed ⇒ resultado IS NULL AND
   * expires_at IS NULL), so we clear expires_at in the same UPDATE — this
   * also removes the row from the in_progress reaper's partial index; the
   * row is pruned later by the aged-failed sweep in `cleanup`.
   *
   * Fencing (B2): gated on `reservation_token`. A preempted owner (whose
   * lease expired and was reclaimed) holds a STALE token, so its release
   * is a no-op (0 rows) and cannot mark the NEW owner's live reservation
   * as failed. Returns whether the row was actually transitioned.
   */
  async releaseReservation(input: {
    key: string;
    reservation_token: string;
  }): Promise<boolean> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const updated = await db
      .update(idempotency_keys)
      .set({
        state: 'failed',
        expires_at: null,
      })
      .where(
        and(
          eq(idempotency_keys.tenant_id, tenant_id),
          eq(idempotency_keys.agent_id, agent_id),
          eq(idempotency_keys.key, input.key),
          eq(idempotency_keys.state, 'in_progress'),
          eq(idempotency_keys.reservation_token, input.reservation_token),
        ),
      )
      .returning({ key: idempotency_keys.key });
    return updated.length > 0;
  },

  /**
   * Poll for a competing worker's reservation to settle. Used by the
   * dispatcher when `tryReserve` returns `was_inserted=false,
   * state='in_progress'` — another worker owns the reservation and we
   * want to return ITS result (not double-execute the side effect).
   *
   * Terminal outcomes:
   *   - 'completed' → the owner finished; return the cached `resultado`.
   *   - 'collision' (issue #299) → the owner's settled row carries a
   *     payload_hash that DIFFERS from `expected_payload_hash`. The owner
   *     reserved a colliding payload (same key, different inputs); adopting
   *     its result would leak the wrong side effect across the collision.
   *     Only emitted when `expected_payload_hash` is supplied. The caller
   *     MUST NOT use the result; the dispatcher surfaces a typed error.
   *   - 'failed' → the owner terminally failed (issue #298 B3:
   *     releaseReservation now marks the row 'failed' rather than deleting
   *     it). The caller MUST NOT re-execute; the dispatcher surfaces a
   *     typed error so any retry is a higher-level decision.
   *   - 'released' → the row vanished entirely (narrow race: the cleanup
   *     worker reaped it, or a down-migration ran). Treated like a failure
   *     from the caller's perspective — re-dispatch from scratch.
   *   - 'timeout' → the deadline elapsed with the owner still in_progress.
   *
   * `expected_payload_hash` is OPTIONAL for backward compat with non-dispatch
   * callers (and pre-#299 tests) that poll a key without a payload to verify.
   * When omitted, the completed result is returned without revalidation.
   *
   * Polling starts at 100ms and backs off exponentially (capped at 500ms)
   * so the loser of the race pays low latency on a fast handler while not
   * hammering the DB on a slow one. The deadline + sleep shape avoids both
   * wall-clock drift and a busy-wait if `setTimeout` resolves early.
   */
  async waitForCompletion(
    key: string,
    timeout_ms: number,
    expected_payload_hash?: string,
  ): Promise<
    | { status: 'completed'; resultado: unknown }
    | { status: 'collision' }
    | { status: 'timeout' }
    | { status: 'released' }
    | { status: 'failed' }
  > {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const deadline = Date.now() + timeout_ms;
    const INITIAL_POLL_MS = 100;
    const MAX_POLL_MS = 500;
    let pollIntervalMs = INITIAL_POLL_MS;
    while (Date.now() < deadline) {
      const rows = await db
        .select({
          state: idempotency_keys.state,
          resultado: idempotency_keys.resultado,
          // #299: needed to revalidate the owner's payload on completion.
          payload_hash: idempotency_keys.payload_hash,
        })
        .from(idempotency_keys)
        .where(
          and(
            eq(idempotency_keys.tenant_id, tenant_id),
            eq(idempotency_keys.agent_id, agent_id),
            eq(idempotency_keys.key, key),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) {
        // Row vanished entirely (cleanup reap / down-migration) — caller
        // should re-dispatch from scratch.
        return { status: 'released' };
      }
      if (row.state === 'completed') {
        // #299: revalidate the owner's payload_hash before adopting their
        // result. A mismatch is a key collision — fail closed.
        // #318: legacy-aware — only a current-format (v2:-prefixed) stored
        // hash that differs is a real collision. A legacy (pre-#318) stored
        // hash can't be revalidated against the new encoding, so the waiter
        // adopts the owner's result (pre-#318 behavior); the row expires
        // shortly. (`expected_payload_hash` may be omitted by non-dispatch
        // callers — then we skip revalidation entirely, unchanged from #299.)
        if (
          expected_payload_hash !== undefined &&
          isRealPayloadHashCollision(row.payload_hash, expected_payload_hash)
        ) {
          reportPayloadHashCollision(
            { key, payload_hash: expected_payload_hash },
            row,
          );
          return { status: 'collision' };
        }
        return { status: 'completed', resultado: row.resultado };
      }
      if (row.state === 'failed') {
        // Terminal failure (B3). Stop polling immediately — the result
        // will never arrive, and we must not re-run the handler.
        return { status: 'failed' };
      }
      // Still in progress; wait and retry with capped exponential backoff.
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      pollIntervalMs = Math.min(pollIntervalMs * 2, MAX_POLL_MS);
    }
    return { status: 'timeout' };
  },

  /**
   * Legacy write path. PRESERVED for backward compat with tests / call
   * sites that haven't migrated to the tryReserve/markCompleted flow.
   * Inserts a 'completed' row directly (matches the pre-#298 semantics:
   * the row exists only after the handler returned, so it's correctly
   * classified as completed).
   *
   * New code should use tryReserve + markCompleted instead — see
   * src/tools/_dispatcher.ts for the canonical pattern.
   */
  async store(input: {
    key: string;
    tool_name: string;
    operation_type: string;
    pessoa_id: string;
    entity_id: string;
    payload_hash: string;
    file_sha256?: string;
    resultado: unknown;
  }): Promise<void> {
    // applyTenantGuard stamps tenant_id/agent_id from ALS context and rejects
    // any explicit mismatch in the input. Also throws if no context.
    const guarded = applyTenantGuard({
      key: input.key,
      tool_name: input.tool_name,
      operation_type: input.operation_type,
      pessoa_id: input.pessoa_id,
      entity_id: input.entity_id,
      payload_hash: input.payload_hash,
      file_sha256: input.file_sha256 ?? null,
      resultado: input.resultado as object,
      state: 'completed' as const,
      expires_at: null,
    });
    await db.insert(idempotency_keys).values(guarded).onConflictDoNothing();
  },
  async cleanup(olderThanDays: number): Promise<number> {
    // Three-phase sweep:
    //   (1) Reap stale in_progress reservations (crashed workers) so they
    //       don't block re-claim forever. The partial index from
    //       migration 064 (`idx_idempotency_keys_in_progress_expires`)
    //       makes this O(stale rows) regardless of total table size.
    //       Deleting an orphaned in_progress row is safe: a crashed owner
    //       left no result, and the next dispatch re-INSERTs a fresh
    //       reservation. (The fencing token in #298 B2 protects the
    //       OTHER case — a slow-but-alive owner whose lease was reclaimed
    //       via UPDATE — so its late completion can't clobber the row.)
    //   (2) Age out long-completed rows past the cache retention window.
    //   (3) Age out terminal 'failed' rows (issue #298 B3) on the same
    //       retention window — they exist only to suppress silent
    //       re-execution; once well past the window the side effect (if
    //       any) is no longer a re-run risk. The partial index
    //       `idx_idempotency_keys_failed_created` (migration 065) keeps
    //       this O(aged-failed rows).
    // All global on purpose: cleanup is a maintenance sweep, not a
    // tenant-scoped read; it cannot leak (no row body returned).
    const reaped = await db
      .delete(idempotency_keys)
      .where(
        and(
          eq(idempotency_keys.state, 'in_progress'),
          sql`expires_at < now()`,
        ),
      )
      .returning({ key: idempotency_keys.key });
    const aged = await db
      .delete(idempotency_keys)
      .where(
        and(
          eq(idempotency_keys.state, 'completed'),
          sql`created_at < now() - (${olderThanDays} || ' days')::interval`,
        ),
      )
      .returning({ key: idempotency_keys.key });
    const agedFailed = await db
      .delete(idempotency_keys)
      .where(
        and(
          eq(idempotency_keys.state, 'failed'),
          sql`created_at < now() - (${olderThanDays} || ' days')::interval`,
        ),
      )
      .returning({ key: idempotency_keys.key });
    return reaped.length + aged.length + agedFailed.length;
  },
};

/**
 * Issue #316 — transactional effect outbox repository
 * (`idempotency_effect_outbox` table, migrations 068/069).
 *
 * The crux of exactly-once for NON-IDEMPOTENT external effects: the WINNING
 * idempotency reservation's completion and the enqueue of its intended effect
 * happen in ONE transaction (`markCompletedWithEffect`). The effect is thus
 * bound to whichever worker WON the reservation — not to a racer. The tool
 * handler never fires the effect inline (it only PLANS it), so a slow/preempted
 * owner whose lease was reclaimed and whose `markCompleted` is fenced out never
 * enqueues an effect (the UPDATE touches 0 rows → the whole tx no-ops the
 * INSERT too). A single relayer (src/workers/idempotency-outbox-relayer.ts)
 * dispatches each committed pending row EXACTLY ONCE with retry/backoff.
 *
 * TENANT ISOLATION (inviolable): every method scopes by the ALS-resolved
 * (tenant_id, agent_id) and writes through `applyTenantGuard`. The relayer is a
 * per-tenant dispatcher (mirrors reflection-batch #240/#251 +
 * outbound-messages-sweeper #292) and never assumes the 'default' sentinel.
 */
export type IdempotencyEffectOutboxRow = typeof idempotency_effect_outbox.$inferSelect;
export type OutboxEffectStatus = 'pending' | 'sent' | 'failed';

/**
 * A pending row claimed by the relayer for dispatch.
 *
 * #327 — `tenant_id` + `agent_id` are selected onto the row (not just used in
 * the WHERE clause) so the relayer can build the provider-side dedup identity
 * from PERSISTED row fields. The dedup key MUST be byte-identical across a
 * re-dispatch (including a crash-recovered one); deriving tenant/agent from the
 * ambient ALS context instead of the row would let a context mismatch produce a
 * DIFFERENT key → the transport wouldn't dedup. The key depends only on the row.
 */
export type ClaimedOutboxEffect = {
  id: string;
  tenant_id: string;
  agent_id: string;
  idempotency_key: string;
  effect_type: string;
  effect_payload: unknown;
  attempts: number;
  max_attempts: number;
};

export const idempotencyOutboxRepo = {
  /**
   * ATOMIC write side. Transition the in_progress reservation → completed AND
   * enqueue the intended external effect in ONE transaction.
   *
   * Both writes are fenced by `reservation_token` (the markCompleted UPDATE is
   * gated on it). If the owner was preempted (lease reclaimed → fresh token),
   * the UPDATE matches 0 rows: we DETECT that inside the tx and ROLL BACK, so
   * the effect is NOT enqueued under a reservation this worker no longer owns.
   * Returns whether the row was transitioned (true) or fenced out (false) —
   * same contract as `idempotencyRepo.markCompleted`, so the dispatcher's
   * `idempotency_completion_fenced` branch is unchanged.
   *
   * The outbox INSERT is ON CONFLICT (tenant, agent, idempotency_key) DO
   * NOTHING: if a previous (committed) completion already enqueued the effect,
   * a re-entry is a no-op — never a second physical effect. Combined with the
   * fencing UPDATE, the (completion, enqueue) pair is exactly-once.
   */
  async markCompletedWithEffect(input: {
    key: string;
    resultado: unknown;
    reservation_token: string;
    effect: PlannedEffect;
    max_attempts?: number;
  }): Promise<boolean> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const maxAttempts = input.max_attempts ?? 5;
    return withTx(async (tx) => {
      // Fence first: only the current reservation owner (matching token) may
      // complete. A preempted owner's stale token matches 0 rows.
      const completed = await tx
        .update(idempotency_keys)
        .set({
          resultado: input.resultado as object,
          state: 'completed',
          expires_at: null,
        })
        .where(
          and(
            eq(idempotency_keys.tenant_id, tenant_id),
            eq(idempotency_keys.agent_id, agent_id),
            eq(idempotency_keys.key, input.key),
            eq(idempotency_keys.state, 'in_progress'),
            eq(idempotency_keys.reservation_token, input.reservation_token),
          ),
        )
        .returning({ key: idempotency_keys.key });
      if (completed.length === 0) {
        // Fenced out / already settled. Roll back: do NOT enqueue an effect
        // for a reservation we no longer own. Throwing aborts the tx; we
        // translate it back to the boolean contract below.
        throw new OutboxFenced();
      }
      // Enqueue the intended effect, atomic with the completion. ON CONFLICT
      // DO NOTHING on (tenant, agent, key) makes a duplicate completion a
      // no-op (never a second physical effect).
      await tx
        .insert(idempotency_effect_outbox)
        .values(
          applyTenantGuard({
            idempotency_key: input.key,
            effect_type: input.effect.kind,
            effect_payload: input.effect as object,
            status: 'pending' as const,
            attempts: 0,
            max_attempts: maxAttempts,
          }),
        )
        .onConflictDoNothing({
          target: [
            idempotency_effect_outbox.tenant_id,
            idempotency_effect_outbox.agent_id,
            idempotency_effect_outbox.idempotency_key,
          ],
        });
      return true;
    }).catch((err) => {
      if (err instanceof OutboxFenced) return false;
      throw err;
    });
  },

  /**
   * Relayer dispatcher enumeration: DISTINCT (tenant_id, agent_id) tuples that
   * have ANY WORK to do this pass — EITHER a dispatchable pending row
   * (status='pending' AND backoff gate elapsed) OR a terminal row
   * (status IN ('sent','failed')) past the retention window. Runs OUTSIDE
   * tenant context — the relayer opens runWithTenantContext per tuple.
   *
   * The terminal-row arm is LOAD-BEARING for retention (Codex #326 blocker):
   * an IDLE tenant whose outbox holds ONLY old terminal rows and NO pending
   * row would otherwise never be enumerated, so its terminal rows would
   * accumulate without bound. Including it here makes the bounded retention
   * cleanup in `relayInner` reach a terminal-only tenant — cleanup is no
   * longer GATED on the pending-dispatch path. Same shape as the sibling
   * outbound-messages-sweeper `listTenantsWithWork` (#292). Belt-and-suspenders
   * NOT NULL predicate (schema already enforces) mirrors #251/#292.
   */
  async listTenantsWithWork(retentionDays: number): Promise<
    Array<{ tenant_id: string; agent_id: string }>
  > {
    const result = await db.execute<{ tenant_id: string; agent_id: string }>(sql`
      SELECT DISTINCT tenant_id, agent_id
      FROM ${idempotency_effect_outbox}
      WHERE tenant_id IS NOT NULL
        AND agent_id IS NOT NULL
        AND (
          (status = 'pending' AND next_attempt_at <= now())
          OR (
            status IN ('sent', 'failed')
            AND updated_at < now() - (${retentionDays} || ' days')::interval
          )
        )
    `);
    return Array.from(result.rows as unknown as Array<{ tenant_id: string; agent_id: string }>);
  },

  /**
   * Claim a bounded, oldest-first batch of dispatchable pending rows for the
   * CURRENT (tenant, agent). `FOR UPDATE SKIP LOCKED` lets concurrent relayer
   * passes (or the per-tenant advisory lock failing open) never contend on the
   * same row. The claim does NOT mutate status — dispatch + markSent/markRetry
   * happen per row after the physical effect, so a crash mid-batch leaves the
   * row pending (the next tick reclaims it). Bounded by `limit` for per-tenant
   * fairness (a high-volume tenant can't starve others within one pass).
   */
  async claimPendingEffects(limit: number): Promise<ClaimedOutboxEffect[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    // #327: SELECT tenant_id + agent_id (not just filter on them) so the relayer
    // derives the provider-side dedup key from the ROW's persisted identity, not
    // the ambient ALS context — the key must be stable across a re-dispatch.
    const rows = await db.execute<ClaimedOutboxEffect>(sql`
      SELECT id, tenant_id, agent_id, idempotency_key, effect_type, effect_payload, attempts, max_attempts
      FROM ${idempotency_effect_outbox}
      WHERE tenant_id = ${tenant_id}
        AND agent_id = ${agent_id}
        AND status = 'pending'
        AND next_attempt_at <= now()
      ORDER BY next_attempt_at ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `);
    return Array.from(rows.rows as unknown as ClaimedOutboxEffect[]);
  },

  /**
   * Mark a dispatched effect as sent (terminal-ish; retained for audit +
   * retention cleanup). Scoped + CAS on status='pending' so a concurrent
   * relayer that already settled the row is a no-op. Stores the provider ref
   * (external message id) for the audit trail.
   */
  async markEffectSent(input: { id: string; provider_ref: string | null }): Promise<boolean> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const updated = await db
      .update(idempotency_effect_outbox)
      .set({
        status: 'sent',
        provider_ref: input.provider_ref,
        last_error: null,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(idempotency_effect_outbox.tenant_id, tenant_id),
          eq(idempotency_effect_outbox.agent_id, agent_id),
          eq(idempotency_effect_outbox.id, input.id),
          eq(idempotency_effect_outbox.status, 'pending'),
        ),
      )
      .returning({ id: idempotency_effect_outbox.id });
    return updated.length > 0;
  },

  /**
   * Record a transient dispatch failure: bump `attempts`, store the error, and
   * push `next_attempt_at` forward by `backoff_seconds` (exponential backoff is
   * computed by the relayer). The row STAYS pending so the next tick retries —
   * UNLESS this attempt exhausts `max_attempts`, in which case the row is
   * transitioned to the terminal 'failed' status (the failed-has-error CHECK is
   * satisfied because we always store `error`). Returns the post-update status
   * so the relayer can ops_alert on terminal failure.
   */
  async markEffectRetry(input: {
    id: string;
    error: string;
    backoff_seconds: number;
  }): Promise<OutboxEffectStatus | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const backoff = `${input.backoff_seconds} seconds`;
    // Single statement: increment attempts, and if attempts+1 >= max_attempts
    // flip to 'failed' (terminal); otherwise stay 'pending' with the backoff
    // gate pushed forward. CAS on status='pending' so a concurrent settle wins.
    const updated = await db.execute<{ status: OutboxEffectStatus }>(sql`
      UPDATE ${idempotency_effect_outbox}
         SET attempts = attempts + 1,
             last_error = ${input.error},
             status = CASE WHEN attempts + 1 >= max_attempts THEN 'failed' ELSE 'pending' END,
             next_attempt_at = now() + ${backoff}::interval,
             updated_at = now()
       WHERE tenant_id = ${tenant_id}
         AND agent_id = ${agent_id}
         AND id = ${input.id}
         AND status = 'pending'
      RETURNING status
    `);
    return updated.rows[0]?.status ?? null;
  },

  /**
   * FORCE-TERMINAL failure (Codex #326 note (b)): transition a pending row
   * STRAIGHT to terminal 'failed' WITHOUT consuming the retry budget. Unlike
   * `markEffectRetry` (which only increments `attempts` by one), this is for a
   * permanently-unrecoverable row — e.g. an effect_payload that does not parse
   * / validate. Retrying such a row is pointless: it will never become valid,
   * so burning all `max_attempts` ticks on it just delays the ops_alert and
   * wastes relayer passes. We flip to 'failed' immediately and store the error
   * (the failed-has-error CHECK is satisfied because `error` is always set).
   * CAS on status='pending' so a concurrent settle wins. Returns true when this
   * call performed the transition.
   */
  async markEffectFailed(input: { id: string; error: string }): Promise<boolean> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const updated = await db.execute<{ id: string }>(sql`
      UPDATE ${idempotency_effect_outbox}
         SET status = 'failed',
             last_error = ${input.error},
             updated_at = now()
       WHERE tenant_id = ${tenant_id}
         AND agent_id = ${agent_id}
         AND id = ${input.id}
         AND status = 'pending'
      RETURNING id
    `);
    return updated.rows.length > 0;
  },

  /**
   * Retention cleanup: delete terminal rows (sent/failed) older than N days, in
   * bounded batches (mirrors outbound-messages-sweeper #292 blocker #1). Scoped
   * per current (tenant, agent). Returns the count deleted this call.
   *
   * The OUTER `DELETE` repeats the explicit `tenant_id`/`agent_id` predicate
   * (Codex #326 note (a)) so the row removal is tenant-scoped at the DELETE
   * itself, not only inside the `id IN (...)` subquery — defense-in-depth
   * against the (theoretical) reuse of an `id` value across tenants.
   */
  async cleanupTerminal(input: {
    olderThanDays: number;
    batchSize: number;
  }): Promise<number> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const deleted = await db.execute<{ id: string }>(sql`
      DELETE FROM ${idempotency_effect_outbox}
      WHERE tenant_id = ${tenant_id}
        AND agent_id = ${agent_id}
        AND id IN (
          SELECT id
          FROM ${idempotency_effect_outbox}
          WHERE tenant_id = ${tenant_id}
            AND agent_id = ${agent_id}
            AND status IN ('sent', 'failed')
            AND updated_at < now() - (${input.olderThanDays} || ' days')::interval
          ORDER BY updated_at ASC
          LIMIT ${input.batchSize}
          FOR UPDATE SKIP LOCKED
        )
      RETURNING id
    `);
    return deleted.rows.length;
  },
};

/**
 * Sentinel thrown inside `markCompletedWithEffect`'s tx to abort + roll back
 * when the fencing UPDATE matched 0 rows (preempted owner). Translated back to
 * `false` by the `.catch` so the dispatcher sees the same boolean contract as
 * plain `markCompleted`. Not exported — internal to the atomic write path.
 */
class OutboxFenced extends Error {
  constructor() {
    super('idempotency_outbox_completion_fenced');
    this.name = 'OutboxFenced';
  }
}
