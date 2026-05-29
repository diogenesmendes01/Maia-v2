/**
 * Issue #195 — Codex Adversarial Review on PR #190 (high):
 *
 * `seedNewActiveAtomic` previously relied solely on the parent-agent lock to
 * serialize with `operationalProfileVersionsRepo.transition`. The doccomment
 * explicitly said the active-row lock was "no longer needed". That was a
 * defense-in-depth gap because:
 *
 *   1. `seedNewActiveAtomic` read the current `active` row WITHOUT
 *      `FOR UPDATE` — only the `agents` row was locked. Under READ COMMITTED
 *      a different transaction holding the v1 row lock (e.g. drift
 *      `transition({to:'rolled_back'})`) commits in between the snapshot
 *      read and the seed's freeze UPDATE. The seed then writes
 *      `UPDATE ... SET status='frozen' WHERE id=v1` with NO `status`
 *      predicate — silently overwriting the just-rolled-back row back to
 *      `frozen`. Observability reports a successful rollback, but the DB
 *      no longer reflects it.
 *
 *   2. The freeze UPDATE has no `status='active'` predicate so even if the
 *      row was concurrently mutated to a non-active status (frozen,
 *      rolled_back) between the in-tx snapshot read and the UPDATE, the
 *      seed silently undoes that state change.
 *
 * Fix (strategy A): re-acquire `FOR UPDATE` on the active-row read inside
 * the seed tx, AND add `status='active'` to the freeze UPDATE WHERE
 * clause. Both are defense-in-depth on top of `lockParentAgent`. The
 * `FOR UPDATE` upgrades the snapshot to a hard row lock; the predicate
 * gives the DB itself the final say on whether the freeze is still valid
 * regardless of which locks any writer holds.
 *
 * This file is the regression test. Scenario A is a DETERMINISTIC
 * reproduction of the lost-write window using a side connection that
 * holds the v1 row lock through the seed's snapshot/update window —
 * proving the fix closes the race even with a writer that bypasses
 * `lockParentAgent`. Scenario B is the canonical concurrency race against
 * the real `transition({to:'rolled_back'})` writer, asserting end-state
 * invariants under `Promise.allSettled`.
 *
 * Skipped without TEST_DB_URL (matches sibling concurrency specs).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';

const SHOULD_RUN = !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T = 'issue195-tenant';
const A = 'issue195-agent';
const ACTOR = 'issue195-actor';

let pool: pg.Pool;

async function resetProfileVersions(): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query(`DELETE FROM admin_audit_log WHERE tenant_id = $1`, [T]);
    await c.query(`DELETE FROM agent_operational_profile_versions WHERE tenant_id = $1`, [T]);
  } finally {
    c.release();
  }
}

async function seedV1Active(): Promise<string> {
  const c = await pool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO agent_operational_profile_versions
         (tenant_id, agent_id, version, status, profile_body, proposed_by, proposed_reason,
          approved_by, approved_at, activated_at)
       VALUES ($1, $2, 1, 'active',
               jsonb_build_object('metadata', jsonb_build_object('previous_version_id', null)),
               $3, 'seed', $3, now(), now())
       RETURNING id`,
      [T, A, ACTOR],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

if (SHOULD_RUN) {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    const c = await pool.connect();
    try {
      await c.query(
        `INSERT INTO tenants(id, nome) VALUES ($1, 'Issue 195 Tenant') ON CONFLICT (id) DO NOTHING`,
        [T],
      );
      await c.query(
        `INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, 'Issue 195 Agent') ON CONFLICT (id) DO NOTHING`,
        [A, T],
      );
    } finally {
      c.release();
    }
  });

  afterAll(async () => {
    const c = await pool.connect();
    try {
      await c.query(`DELETE FROM admin_audit_log WHERE tenant_id = $1`, [T]);
      await c.query(`DELETE FROM agent_operational_profile_versions WHERE tenant_id = $1`, [T]);
      await c.query(`DELETE FROM agents WHERE tenant_id = $1`, [T]);
      await c.query(`DELETE FROM tenants WHERE id = $1`, [T]);
    } finally {
      c.release();
      await pool.end();
    }
  });

  beforeEach(async () => {
    await resetProfileVersions();
  });
}

d('seedNewActiveAtomic vs transition cross-writer race (issue #195, real DB)', () => {
  /**
   * Scenario A — DETERMINISTIC lost-write reproduction.
   *
   * Uses a side connection that holds the v1 row lock to widen the snapshot
   * window inside `seedNewActiveAtomic` precisely so the bug surfaces
   * regardless of `lockParentAgent`. The side connection rolls v1 back and
   * commits BEFORE releasing the row lock — under READ COMMITTED the seed's
   * already-queued freeze UPDATE then re-evaluates against the new committed
   * value of v1.
   *
   * Pre-fix behaviour (no `status='active'` predicate on freeze):
   *   - Seed's freeze UPDATE matches the row by `(id, tenant, agent)` alone,
   *     silently overwriting `rolled_back → frozen`. Final state: v1 frozen,
   *     v2 active. The drift rollback is lost.
   *
   * Post-fix behaviour (`status='active'` predicate on freeze + `FOR UPDATE`
   * on the active-row read):
   *   - Seed's snapshot read FOR UPDATE blocks on the side connection's row
   *     lock, so when the side connection rolls v1 back and commits, the
   *     seed sees `status='rolled_back'` in its now-current snapshot and
   *     short-circuits (no active row found, no freeze attempted). New v2
   *     still gets inserted. v1 stays rolled_back.
   *   - Even if the `FOR UPDATE` were bypassed by a future refactor, the
   *     freeze UPDATE's `status='active'` predicate matches zero rows and
   *     the seed throws `seed_atomic_freeze_failed`, rolling the whole
   *     seed tx back. The rollback is preserved either way.
   */
  it('side-connection rolls v1 back mid-seed → seed never silently overwrites rolled_back', async () => {
    const { operationalProfileVersionsRepo } = await import('../../src/db/repositories.js');
    const { runWithTenantContext } = await import('../../src/db/tenant-context.js');

    const v1Id = await seedV1Active();

    // Side connection: open a tx and hold a row-level lock on v1. The seed
    // running in another connection will be forced to interleave with us.
    const side = await pool.connect();
    let sideCommitted = false;
    try {
      await side.query('BEGIN');
      // Lock v1 in this connection. The seed's `FOR UPDATE` re-read (or its
      // freeze UPDATE pre-fix) will block on this lock.
      await side.query(
        `SELECT id FROM agent_operational_profile_versions
          WHERE id = $1 FOR UPDATE`,
        [v1Id],
      );

      // Fire the seed in a separate task. It will:
      //   - acquire lockParentAgent (different table → no block on our row
      //     lock)
      //   - SELECT current active. Pre-fix: snapshot read, sees v1 active,
      //     proceeds to freeze UPDATE which blocks on us. Post-fix:
      //     FOR UPDATE read blocks on us right here.
      //   - either way, the seed is now blocked on the v1 row lock.
      // Codex round 2 [P2/HIGH]: this is a NON-INITIAL seed (v1 already
      // exists), so per the new `seedNewActiveAtomic` contract introduced
      // in cc04b369 we MUST declare which active row we expect to
      // supersede. Omitting `expected_current_active_id` would short-
      // circuit on `seed_atomic_missing_predecessor_expectation` BEFORE
      // the test ever exercises the FOR UPDATE / freeze-predicate race
      // this scenario is meant to verify. With the expectation in place,
      // the test models the realistic migration path (caller observed v1
      // active via `getActive()`, then raced the drift rollback).
      const seedPromise = runWithTenantContext({ tenant_id: T, agent_id: A }, async () =>
        operationalProfileVersionsRepo.seedNewActiveAtomic({
          expected_current_active_id: v1Id,
          profile_body: {
            metadata: { previous_version_id: v1Id },
          } as unknown as Parameters<
            typeof operationalProfileVersionsRepo.seedNewActiveAtomic
          >[0]['profile_body'],
          proposed_by: 'p8d-migration',
          proposed_reason: 'concurrent with drift rollback',
        }),
      );

      // Give the seed time to enqueue its blocking statement against our
      // row lock. 100ms is generous; even on a slow CI runner the seed's
      // initial SELECTs run in single-digit ms.
      await new Promise((resolve) => setTimeout(resolve, 100));

      // While the seed is blocked, simulate the drift engine winning and
      // rolling v1 back. This MUST commit before we release the row lock
      // so the seed sees the new committed value when it wakes.
      await side.query(
        `UPDATE agent_operational_profile_versions
            SET status = 'rolled_back',
                rolled_back_at = now(),
                rollback_reason = $2
          WHERE id = $1`,
        [v1Id, 'drift_critical_concurrent_with_seed'],
      );
      await side.query('COMMIT');
      sideCommitted = true;

      // Wait for the seed to either complete or fail.
      const seedSettled = await Promise.allSettled([seedPromise]);
      const seedResult = seedSettled[0]!;

      // Assert the INVARIANT regardless of which seed path is taken:
      // v1 MUST remain in 'rolled_back'. The seed must NEVER silently
      // overwrite it back to 'frozen'.
      const verify = await pool.connect();
      try {
        const r = await verify.query<{ status: string; rolled_back_at: Date | null }>(
          `SELECT status, rolled_back_at
             FROM agent_operational_profile_versions
            WHERE id = $1`,
          [v1Id],
        );
        const v1Final = r.rows[0]!;

        expect(v1Final.status).toBe('rolled_back');
        expect(v1Final.rolled_back_at).not.toBeNull();

        // Codex round 2: with `expected_current_active_id: v1Id` now
        // declared, this orchestration has a deterministic terminal
        // state — the seed MUST reject. Reasoning: the side connection
        // commits v1→rolled_back BEFORE releasing the row lock, so when
        // the seed's `FOR UPDATE` re-read wakes, the now-current snapshot
        // returns zero rows (rolled_back is filtered out by
        // `status='active'`). With currentActive=null and an explicit
        // expectation, the stale-active guard fires and the seed throws
        // `seed_atomic_stale_active`, rolling the tx back. The
        // `seed_atomic_freeze_failed` branch is the alternate
        // defense-in-depth outcome that would fire if `FOR UPDATE` were
        // ever bypassed and the freeze UPDATE's `status='active'`
        // predicate matched zero rows instead. Either rejection
        // preserves the same end-state: v1 stays rolled_back, no v2 is
        // inserted, and the rollback is honoured.
        if (seedResult.status === 'fulfilled') {
          // Defensive: a fulfilled seed under this orchestration would
          // mean the new contract (mandatory expectation + stale-active
          // guard) silently regressed. Surface the full state so the
          // failure is actionable.
          const allRows = await verify.query<{ version: number; status: string }>(
            `SELECT version, status
               FROM agent_operational_profile_versions
              WHERE tenant_id = $1 AND agent_id = $2
              ORDER BY version`,
            [T, A],
          );
          throw new Error(
            'seed unexpectedly fulfilled with expected_current_active_id set ' +
              'and v1 already rolled_back — stale-active guard regressed. ' +
              `rows=${JSON.stringify(allRows.rows)}`,
          );
        }

        const msg = String(seedResult.reason);
        expect(msg).toMatch(/seed_atomic_freeze_failed|seed_atomic_stale_active/i);

        const allRows = await verify.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
             FROM agent_operational_profile_versions
            WHERE tenant_id = $1 AND agent_id = $2`,
          [T, A],
        );
        // Only v1 should exist (seed tx rolled back so no v2 inserted).
        expect(allRows.rows[0]!.count).toBe('1');

        // Active-slot invariant: AT MOST one active row at any time.
        const active = await verify.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
             FROM agent_operational_profile_versions
            WHERE tenant_id = $1 AND agent_id = $2 AND status = 'active'`,
          [T, A],
        );
        expect(parseInt(active.rows[0]!.count, 10)).toBeLessThanOrEqual(1);
      } finally {
        verify.release();
      }
    } finally {
      if (!sideCommitted) {
        await side.query('ROLLBACK').catch(() => undefined);
      }
      side.release();
    }
  });

  /**
   * Scenario B — canonical concurrency race against the REAL `transition`
   * writer using `Promise.allSettled`. With the parent-agent lock both
   * writers serialize cleanly, so this asserts the end-state invariants
   * (no lost rollback, no duplicate active, no orphaned partial-unique
   * index error) under realistic contention rather than a synthetic
   * side-channel.
   *
   * This duplicates the `issue-177-transition-parent-lock.spec.ts`
   * scenario A on purpose: #177 covered the lock acquisition; #195
   * covers the defense-in-depth seed-side invariants (predicate + row
   * lock). If anyone later weakens the lock OR the predicate, BOTH
   * tests will go red, making the regression obvious.
   */
  it('Promise.allSettled race: seed vs transition(rolled_back, expected_from:active) — no lost rollback', async () => {
    const { operationalProfileVersionsRepo } = await import('../../src/db/repositories.js');
    const { runWithTenantContext } = await import('../../src/db/tenant-context.js');

    const v1Id = await seedV1Active();

    const transitionCall = runWithTenantContext({ tenant_id: T, agent_id: A }, async () =>
      operationalProfileVersionsRepo.transition({
        id: v1Id,
        to: 'rolled_back',
        expected_from: 'active',
        rollback_reason: 'drift_critical_concurrent_with_seed',
      }),
    );

    // Codex round 2 [P2/HIGH]: non-initial seed (v1 already exists) now
    // requires `expected_current_active_id`. Omitting it would make this
    // call degenerate into an immediate `seed_atomic_missing_predecessor_
    // expectation` rejection instead of exercising the freeze/insert
    // serialization against `transition`. With `v1Id` declared the test
    // models the realistic migration-script path (`p8d-migration-
    // priorities` reads `getActive()` first and passes its id).
    const seedCall = runWithTenantContext({ tenant_id: T, agent_id: A }, async () =>
      operationalProfileVersionsRepo.seedNewActiveAtomic({
        expected_current_active_id: v1Id,
        profile_body: {
          metadata: { previous_version_id: v1Id },
        } as unknown as Parameters<
          typeof operationalProfileVersionsRepo.seedNewActiveAtomic
        >[0]['profile_body'],
        proposed_by: 'p8d-migration',
        proposed_reason: 'priorities migration concurrent with drift rollback',
      }),
    );

    const results = await Promise.allSettled([transitionCall, seedCall]);

    // No promise may reject with a duplicate-key error — the parent lock
    // must serialize the active-row writes cleanly.
    for (const r of results) {
      if (r.status === 'rejected') {
        const msg = String(r.reason);
        expect(msg).not.toMatch(/agent_op_profile_active_uniq/i);
        expect(msg).not.toMatch(/agent_op_profile_version_uq/i);
        expect(msg).not.toMatch(/duplicate key/i);
      }
    }

    const c2 = await pool.connect();
    try {
      const r = await c2.query<{ id: string; version: number; status: string }>(
        `SELECT id, version, status FROM agent_operational_profile_versions
          WHERE tenant_id = $1 AND agent_id = $2
          ORDER BY version`,
        [T, A],
      );
      const v1 = r.rows.find((row) => row.id === v1Id);
      expect(v1).toBeDefined();

      const transitionRes = results[0];
      const seedRes = results[1];

      // If `transition` returned `ok:true`, the drift rollback was applied.
      // CRITICAL INVARIANT (issue #195): v1 MUST stay `rolled_back`. Pre-fix,
      // the seed could silently overwrite the rolled-back row back to
      // `frozen` because its freeze UPDATE had no `status='active'`
      // predicate.
      if (transitionRes.status === 'fulfilled' && transitionRes.value.ok) {
        expect(v1!.status).toBe('rolled_back');
        // Codex round 2: with `expected_current_active_id: v1Id` declared,
        // the seed CANNOT silently insert a v2 after a successful
        // rollback — its `FOR UPDATE` re-read sees no active row, the
        // expectation/currentActive mismatch fires
        // `seed_atomic_stale_active`, and the tx rolls back. So the seed
        // must have rejected and zero new active rows exist.
        expect(seedRes!.status).toBe('rejected');
        if (seedRes!.status === 'rejected') {
          expect(String(seedRes!.reason)).toMatch(/seed_atomic_stale_active/i);
        }
        const activeRows = r.rows.filter((row) => row.status === 'active');
        expect(activeRows.length).toBe(0);
      } else if (
        transitionRes.status === 'fulfilled' &&
        !transitionRes.value.ok &&
        transitionRes.value.reason === 'stale'
      ) {
        // Seed won the lock first → froze v1 → transition saw 'frozen' !=
        // expected_from='active' → returned stale (no fail-open).
        expect(transitionRes.value.expected_from).toBe('active');
        expect(transitionRes.value.actual).toBe('frozen');
        expect(v1!.status).toBe('frozen');
        // Seed must have fulfilled (it observed v1=active under its
        // FOR UPDATE, expectation matched, freeze+insert ran cleanly).
        expect(seedRes!.status).toBe('fulfilled');
        if (seedRes!.status === 'fulfilled') {
          expect(seedRes!.value.new_active.version).toBe(2);
          expect(seedRes!.value.new_active.status).toBe('active');
        }
      } else {
        // Codex review of PR #202 [P3]: any other outcome (transition
        // rejected, or returned ok:false with a reason other than 'stale')
        // is unexpected for this race and would let a broken rollback path
        // silently pass the active-row count check below. Mirror the
        // catch-all that `issue-177-transition-parent-lock.spec.ts`
        // scenario A uses so the regression is obvious instead of hidden.
        throw new Error(
          `unexpected transition result: ${JSON.stringify(transitionRes)}; ` +
            `seed=${JSON.stringify(seedRes)}; rows=${JSON.stringify(r.rows)}`,
        );
      }

      // Active-slot invariant: at most one active row.
      const activeCount = r.rows.filter((row) => row.status === 'active').length;
      expect(activeCount).toBeLessThanOrEqual(1);
    } finally {
      c2.release();
    }
  });

  /**
   * Scenario C — direct SQL invariant test of the freeze predicate.
   *
   * If a row's `status` is no longer `active` at the moment the seed
   * issues its freeze UPDATE, the UPDATE MUST match zero rows. This is
   * the contract the `status='active'` predicate enforces. We exercise
   * it by manually preparing a row that's already in a non-active state
   * and asserting the predicate filter behaves as expected.
   *
   * This catches anyone who deletes the predicate without realising the
   * test in scenario A also depends on it (the side-connection
   * orchestration in scenario A masks the predicate's role behind the
   * `FOR UPDATE` snapshot upgrade).
   */
  it('freeze UPDATE with status=active predicate matches zero rows when target is not active', async () => {
    const v1Id = await seedV1Active();

    // Move v1 to frozen out-of-band so the predicate WHERE clause must
    // reject the freeze attempt below.
    const setup = await pool.connect();
    try {
      await setup.query(
        `UPDATE agent_operational_profile_versions
            SET status = 'rolled_back', rolled_back_at = now()
          WHERE id = $1`,
        [v1Id],
      );
    } finally {
      setup.release();
    }

    // Now run the exact freeze SQL the fix issues — predicate must reject.
    const verify = await pool.connect();
    try {
      const r = await verify.query<{ id: string }>(
        `UPDATE agent_operational_profile_versions
            SET status = 'frozen', frozen_at = now()
          WHERE id = $1
            AND tenant_id = $2
            AND agent_id = $3
            AND status = 'active'
          RETURNING id`,
        [v1Id, T, A],
      );
      // The predicate must reject — zero rows updated.
      expect(r.rows.length).toBe(0);

      // And v1 must STILL be rolled_back (the predicate didn't overwrite it).
      const after = await verify.query<{ status: string }>(
        `SELECT status FROM agent_operational_profile_versions WHERE id = $1`,
        [v1Id],
      );
      expect(after.rows[0]!.status).toBe('rolled_back');
    } finally {
      verify.release();
    }
  });

  /**
   * Scenario D — Codex Adversarial Review of PR #202 [HIGH] regression.
   *
   * After the new `FOR UPDATE` re-read inside `seedNewActiveAtomic`, a
   * row whose status was concurrently flipped to a non-active value
   * (e.g. `rolled_back` by the drift engine) disappears from the
   * `status='active'` result set. The pre-#202 contract treated that as
   * `currentActive = null` and silently fell through to:
   *
   *   1. Skip the freeze step entirely (no active row to freeze).
   *   2. Insert a brand-new `status='active'` row.
   *
   * That preserves v1's `rolled_back` state but immediately re-enables
   * runtime profile state on v2 — defeating the rollback's intent (the
   * decision engine wanted the agent OFF, not OFF-then-ON-with-a-new-row).
   *
   * The fix: when the seed sees a non-initial allocation (`nextV > 1`,
   * meaning prior versions exist for this agent), the caller MUST
   * declare `expected_current_active_id`. Omitting it on a non-initial
   * seed throws `seed_atomic_missing_predecessor_expectation` and rolls
   * the tx back. Initial seeds (`nextV === 1`, no prior versions) still
   * accept an absent expectation — there is nothing to be stale against.
   *
   * Pre-fix behaviour: seed succeeds, two rows end up in the DB
   * (v1 rolled_back + v2 active).
   *
   * Post-fix behaviour: seed throws, tx rolls back, only v1 remains.
   */
  it('non-initial seed without expected_current_active_id throws after concurrent rollback', async () => {
    const { operationalProfileVersionsRepo } = await import('../../src/db/repositories.js');
    const { runWithTenantContext } = await import('../../src/db/tenant-context.js');

    const v1Id = await seedV1Active();

    // Roll v1 back out-of-band so when the seed runs its FOR UPDATE
    // re-read, no `status='active'` row exists. This simulates the
    // drift engine's rollback landing BEFORE the seed acquired its lock
    // (the harder-to-detect case Codex flagged — the seed has no way to
    // distinguish "agent never had an active row" from "agent's active
    // row was just rolled back" without an explicit expectation).
    const setup = await pool.connect();
    try {
      await setup.query(
        `UPDATE agent_operational_profile_versions
            SET status = 'rolled_back',
                rolled_back_at = now(),
                rollback_reason = $2
          WHERE id = $1`,
        [v1Id, 'drift_critical_before_seed_lock'],
      );
    } finally {
      setup.release();
    }

    // Caller forgets to pass `expected_current_active_id`. Pre-fix this
    // would silently insert v2 as `active`, re-enabling runtime state
    // post-rollback. Post-fix the seed must refuse.
    const seedPromise = runWithTenantContext({ tenant_id: T, agent_id: A }, async () =>
      operationalProfileVersionsRepo.seedNewActiveAtomic({
        profile_body: {
          metadata: { previous_version_id: v1Id },
        } as unknown as Parameters<
          typeof operationalProfileVersionsRepo.seedNewActiveAtomic
        >[0]['profile_body'],
        proposed_by: 'p8d-migration',
        proposed_reason: 'forgot to pass expectation after concurrent rollback',
      }),
    );

    await expect(seedPromise).rejects.toThrow(
      /seed_atomic_missing_predecessor_expectation/i,
    );

    // Verify tx rolled back — only v1 exists, still rolled_back.
    const verify = await pool.connect();
    try {
      const r = await verify.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM agent_operational_profile_versions
          WHERE tenant_id = $1 AND agent_id = $2`,
        [T, A],
      );
      expect(r.rows[0]!.count).toBe('1');

      const v1 = await verify.query<{ status: string }>(
        `SELECT status FROM agent_operational_profile_versions WHERE id = $1`,
        [v1Id],
      );
      expect(v1.rows[0]!.status).toBe('rolled_back');

      // CRITICAL invariant: no active row exists. The agent is OFF, as
      // the rollback intended.
      const active = await verify.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM agent_operational_profile_versions
          WHERE tenant_id = $1 AND agent_id = $2 AND status = 'active'`,
        [T, A],
      );
      expect(active.rows[0]!.count).toBe('0');
    } finally {
      verify.release();
    }
  });

  /**
   * Scenario E — Codex PR #202 [HIGH]: initial seeds (nextV === 1, no
   * prior versions) MUST still accept an absent `expected_current_active_id`.
   * There is no predecessor to be stale against, so the requirement only
   * binds when prior versions exist. This is the "don't break legitimate
   * first-version creation" guard.
   */
  it('initial seed (no prior versions) without expected_current_active_id succeeds', async () => {
    const { operationalProfileVersionsRepo } = await import('../../src/db/repositories.js');
    const { runWithTenantContext } = await import('../../src/db/tenant-context.js');

    // No versions seeded for this agent — the reset in beforeEach already
    // truncated. The seed should treat this as an initial allocation.
    const result = await runWithTenantContext(
      { tenant_id: T, agent_id: A },
      async () =>
        operationalProfileVersionsRepo.seedNewActiveAtomic({
          profile_body: {
            metadata: { previous_version_id: null },
          } as unknown as Parameters<
            typeof operationalProfileVersionsRepo.seedNewActiveAtomic
          >[0]['profile_body'],
          proposed_by: 'p8d-migration',
          proposed_reason: 'initial seed for brand-new agent',
        }),
    );

    expect(result.new_active.version).toBe(1);
    expect(result.new_active.status).toBe('active');
    expect(result.frozen_previous).toBeNull();
  });
});
