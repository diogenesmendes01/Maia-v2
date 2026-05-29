/**
 * Codex Adversarial Review on PR #171 round 4 (issue #177) — covers the LAST
 * remaining writer of `agent_operational_profile_versions` that bypassed the
 * parent-agent FOR UPDATE lock established by `acquireNextVersionForAgent` /
 * `lockParentAgent`: `operationalProfileVersionsRepo.transition`.
 *
 * Round 4 documented race:
 *   - priorities seed reads `active = A`
 *   - drift decision engine calls `transition({ id: A, to: 'rolled_back' })`
 *     concurrently → A becomes terminal
 *   - seed re-writes A as `frozen` using only `{ id, tenant, agent }` in the
 *     UPDATE WHERE → silently undoes `rolled_back` (the terminal state per
 *     the doccomment) and leaves the active slot in an inconsistent state.
 *
 * The fix wraps `transition` in `withTx`, takes `lockParentAgent` FIRST, and
 * adds a `status = <from>` predicate to the UPDATE itself. This file tests
 * the new contract end-to-end against a real Postgres, mirroring the pattern
 * established by `issue-166-propose-version-race.spec.ts`.
 *
 * Skipped without TEST_DB_URL (matches sibling concurrency specs).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';

const SHOULD_RUN = !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T = 'issue177-tenant';
const A = 'issue177-agent';
const ACTOR = 'issue177-actor';

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

if (SHOULD_RUN) {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    const c = await pool.connect();
    try {
      await c.query(
        `INSERT INTO tenants(id, nome) VALUES ($1, 'Issue 177 Tenant') ON CONFLICT (id) DO NOTHING`,
        [T],
      );
      await c.query(
        `INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, 'Issue 177 Agent') ON CONFLICT (id) DO NOTHING`,
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

d('operationalProfileVersionsRepo.transition (parent-agent lock, real DB)', () => {
  /**
   * Scenario A (the canonical #177 race + Codex PR #182 round 1 regression):
   * `seedNewActiveAtomic` racing the drift engine's
   * `transition({ to: 'rolled_back', expected_from: 'active' })`.
   *
   * Pre-#177 fix: the seed could re-write the just-rolled-back row as
   * `frozen` using only `{id, tenant, agent}`, silently undoing the
   * terminal state.
   *
   * Pre-PR #182 round 1 fix: the seed wins the parent-agent lock, freezes
   * v1, seeds v2 as active, commits. The waiting drift `transition` then
   * acquires the lock, re-reads v1 as `frozen`, finds `frozen →
   * rolled_back` is a valid state-machine edge, and returns `ok:true` —
   * the decision engine then records the rollback as APPLIED even though
   * the live (v2) active row was untouched. Critical rollback fails open
   * with false success.
   *
   * Post-fix: the drift engine passes `expected_from: 'active'`. When
   * seed wins the lock first and freezes v1, the waiting transition
   * re-reads v1 as `frozen`, sees `frozen !== expected 'active'`, and
   * returns `{ok:false, reason:'stale', expected_from:'active',
   * actual:'frozen'}`. v2 (the new active) is NOT marked rolled_back —
   * the regression is closed.
   */
  it('seedNewActiveAtomic + transition(rolled_back, expected_from:active) → seed-wins surfaces stale, no false rollback', async () => {
    const { operationalProfileVersionsRepo } = await import('../../src/db/repositories.js');
    const { runWithTenantContext } = await import('../../src/db/tenant-context.js');

    // Seed v1 as active so both writers contend on it.
    const c = await pool.connect();
    let v1Id: string;
    try {
      const r1 = await c.query<{ id: string }>(
        `INSERT INTO agent_operational_profile_versions
           (tenant_id, agent_id, version, status, profile_body, proposed_by, proposed_reason,
            approved_by, approved_at, activated_at)
         VALUES ($1, $2, 1, 'active',
                 jsonb_build_object('metadata', jsonb_build_object('previous_version_id', null)),
                 $3, 'seed', $3, now(), now())
         RETURNING id`,
        [T, A, ACTOR],
      );
      v1Id = r1.rows[0]!.id;
    } finally {
      c.release();
    }

    const transitionCall = runWithTenantContext({ tenant_id: T, agent_id: A }, async () =>
      operationalProfileVersionsRepo.transition({
        id: v1Id,
        to: 'rolled_back',
        expected_from: 'active',
        rollback_reason: 'drift_critical_concurrent_with_seed',
      }),
    );

    // PR #202 / issue #208 follow-up: non-initial seed (v1 already exists
    // and was inserted by the test setup above) now REQUIRES
    // `expected_current_active_id` per the contract introduced in
    // cc04b369. Omitting it would short-circuit on
    // `seed_atomic_missing_predecessor_expectation` BEFORE the test ever
    // exercises the parent-lock contention against `transition` that
    // this scenario claims to verify. With `v1Id` declared the test
    // models the realistic migration-script path
    // (`p8d-migration-priorities` reads `getActive()` first and passes
    // the observed active id).
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

    // No promise may reject with a partial-unique-index / duplicate-key
    // error (the symptom the lock prevents). Acceptable: success, or seed
    // throwing `seed_atomic_freeze_failed`/`seed_atomic_stale_active` when
    // it loses the race AND its current-active read snapshot vanished.
    for (const r of results) {
      if (r.status === 'rejected') {
        const msg = String(r.reason);
        expect(msg).not.toMatch(/agent_op_profile_active_uniq/i);
        expect(msg).not.toMatch(/agent_op_profile_version_uq/i);
        expect(msg).not.toMatch(/duplicate key/i);
      }
    }

    // CRITICAL invariant from #177 + PR #182 round 1: read v1's final
    // state. If `transition` won the lock first, v1 MUST be `rolled_back`
    // (and stay that way even if seed ran after, since seed checks for
    // stale active). If `seed` won first, v1 is `frozen` (NOT
    // `rolled_back`) and a v2 is active — AND transition MUST have
    // returned `stale` (not silently flipped v1 to `rolled_back` via the
    // valid frozen→rolled_back edge).
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

      // The transition result tells us which path the system took.
      const transitionRes = results[0];
      const seedRes = results[1];

      if (transitionRes.status === 'fulfilled' && transitionRes.value.ok) {
        // Drift transition won the race → v1 MUST stay rolled_back.
        expect(v1!.status).toBe('rolled_back');
        // PR #202 / issue #208: with `expected_current_active_id: v1Id`
        // declared on the seed, the seed CANNOT silently insert a v2
        // after a successful rollback. When the seed's `FOR UPDATE`
        // re-read wakes after `transition` committed v1→rolled_back,
        // the `status='active'` filter returns zero rows
        // (currentActive=null), the expectation/currentActive mismatch
        // fires `seed_atomic_stale_active`, and the seed tx rolls back.
        // So the seed MUST have rejected and zero new active rows
        // exist after this branch.
        expect(seedRes!.status).toBe('rejected');
        if (seedRes!.status === 'rejected') {
          expect(String(seedRes!.reason)).toMatch(/seed_atomic_stale_active/i);
        }
        const activeRowsAfterRollback = r.rows.filter((row) => row.status === 'active');
        expect(activeRowsAfterRollback.length).toBe(0);
      } else if (
        transitionRes.status === 'fulfilled' &&
        !transitionRes.value.ok &&
        transitionRes.value.reason === 'stale'
      ) {
        // Seed won the race → status changed under transition's lock to
        // `frozen`, expected_from='active' fires `stale` cleanly.
        // CRITICAL REGRESSION CHECK (Codex PR #182 round 1): v1 must be
        // 'frozen' (NOT 'rolled_back' — that would mean transition
        // fail-opened on the frozen→rolled_back edge). v2 is now active.
        expect(transitionRes.value.expected_from).toBe('active');
        expect(transitionRes.value.actual).toBe('frozen');
        expect(v1!.status).toBe('frozen');
        const v2 = r.rows.find((row) => row.status === 'active');
        expect(v2).toBeDefined();
        expect(v2!.version).toBe(2);
        // The new active was NOT marked rolled_back. This is the entire
        // point of the `expected_from` contract.
        expect(v2!.status).toBe('active');
        // PR #202 / issue #208: seed must have fulfilled — it observed
        // v1=active under its FOR UPDATE, the expectation matched, and
        // the freeze+insert ran cleanly.
        expect(seedRes!.status).toBe('fulfilled');
        if (seedRes!.status === 'fulfilled') {
          expect(seedRes!.value.new_active.version).toBe(2);
          expect(seedRes!.value.new_active.status).toBe('active');
        }
      } else if (
        transitionRes.status === 'fulfilled' &&
        !transitionRes.value.ok &&
        transitionRes.value.reason === 'invalid_transition'
      ) {
        // Defense-in-depth path: status predicate guard fired before
        // expected_from check (very narrow window). v1 is frozen, v2 is
        // active. Same end state, also acceptable.
        expect(v1!.status).toBe('frozen');
      } else {
        // Catch-all: log the actual state so a regression is obvious.
        throw new Error(
          `unexpected transition result: ${JSON.stringify(transitionRes)}; ` +
            `seed=${JSON.stringify(seedRes)}; rows=${JSON.stringify(r.rows)}`,
        );
      }

      // Active-slot invariant: there is AT MOST one active row.
      const activeCount = r.rows.filter((row) => row.status === 'active').length;
      expect(activeCount).toBeLessThanOrEqual(1);
    } finally {
      c2.release();
    }
  });

  /**
   * Scenario B: `proposeAndAuditAtomic` racing `transition({ to: 'frozen' })`.
   * proposeAndAuditAtomic only inserts a new `proposed` row (does NOT touch
   * the active row), so the two writers are largely orthogonal — but both
   * serialize on the parent-agent lock now, so it's a non-trivial check that
   * neither path leaks a duplicate-key error and the active row's frozen
   * timestamp is set exactly once.
   */
  it('proposeAndAuditAtomic + transition(frozen) concurrent → no contention errors', async () => {
    const { operationalProfileVersionsRepo } = await import('../../src/db/repositories.js');
    const { runWithTenantContext } = await import('../../src/db/tenant-context.js');

    const c = await pool.connect();
    let v1Id: string;
    try {
      const r1 = await c.query<{ id: string }>(
        `INSERT INTO agent_operational_profile_versions
           (tenant_id, agent_id, version, status, profile_body, proposed_by, proposed_reason,
            approved_by, approved_at, activated_at)
         VALUES ($1, $2, 1, 'active',
                 jsonb_build_object('metadata', jsonb_build_object('previous_version_id', null)),
                 $3, 'seed', $3, now(), now())
         RETURNING id`,
        [T, A, ACTOR],
      );
      v1Id = r1.rows[0]!.id;
    } finally {
      c.release();
    }

    const transitionCall = runWithTenantContext({ tenant_id: T, agent_id: A }, async () =>
      operationalProfileVersionsRepo.transition({
        id: v1Id,
        to: 'frozen',
        expected_from: 'active',
      }),
    );

    const proposeCall = operationalProfileVersionsRepo.proposeAndAuditAtomic({
      tenant_id: T,
      agent_id: A,
      profile_body: { metadata: { previous_version_id: v1Id } } as Parameters<
        typeof operationalProfileVersionsRepo.proposeAndAuditAtomic
      >[0]['profile_body'],
      proposed_by: 'admin',
      proposed_reason: 'concurrent propose during freeze',
      previous_active_id: v1Id,
      actor_id: ACTOR,
      actor_role: 'founder',
    });

    const results = await Promise.allSettled([transitionCall, proposeCall]);

    for (const r of results) {
      if (r.status === 'rejected') {
        const msg = String(r.reason);
        expect(msg).not.toMatch(/agent_op_profile_active_uniq/i);
        expect(msg).not.toMatch(/agent_op_profile_version_uq/i);
        expect(msg).not.toMatch(/duplicate key/i);
      }
    }

    // Both should succeed (orthogonal writes), and v1 must be frozen
    // exactly once.
    const c2 = await pool.connect();
    try {
      const r = await c2.query<{ status: string; frozen_at: Date | null }>(
        `SELECT status, frozen_at FROM agent_operational_profile_versions
          WHERE id = $1`,
        [v1Id],
      );
      expect(r.rows[0]!.status).toBe('frozen');
      expect(r.rows[0]!.frozen_at).not.toBeNull();

      const proposed = await c2.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM agent_operational_profile_versions
          WHERE tenant_id = $1 AND agent_id = $2 AND status = 'proposed'`,
        [T, A],
      );
      // Exactly one proposed row from proposeAndAuditAtomic.
      expect(proposed.rows[0]!.count).toBe('1');
    } finally {
      c2.release();
    }
  });

  /**
   * Scenario C: `approveAndActivateAtomic` racing `transition({ to: 'rolled_back' })`
   * on the SAME proposed row id. Pre-fix: approve and transition could both
   * mutate the proposed row from different lock domains and produce a row
   * with `status='active'` AND `rolled_back_at` set, or undo the rollback.
   * Post-fix: both take `lockParentAgent` first → one wins, the other
   * surfaces `invalid_transition` cleanly.
   */
  it('approveAndActivateAtomic + transition(rolled_back) on same proposed → one wins, other invalid_transition', async () => {
    const { operationalProfileVersionsRepo } = await import('../../src/db/repositories.js');
    const { runWithTenantContext } = await import('../../src/db/tenant-context.js');

    const c = await pool.connect();
    let proposedId: string;
    try {
      const r = await c.query<{ id: string }>(
        `INSERT INTO agent_operational_profile_versions
           (tenant_id, agent_id, version, status, profile_body, proposed_by, proposed_reason)
         VALUES ($1, $2, 1, 'proposed',
                 jsonb_build_object('metadata', jsonb_build_object('previous_version_id', null)),
                 $3, 'concurrent target')
         RETURNING id`,
        [T, A, ACTOR],
      );
      proposedId = r.rows[0]!.id;
    } finally {
      c.release();
    }

    const approveCall = operationalProfileVersionsRepo.approveAndActivateAtomic({
      tenant_id: T,
      agent_id: A,
      id: proposedId,
      actor_id: ACTOR,
      actor_role: 'founder',
      comment: 'approve concurrent with rollback',
    });
    // Codex Adversarial Review of PR #182 round 1: this test originally
    // asserted single-winner but was flaky — pre-fix, if approve won the
    // lock first the row became `active`, and the waiting transition then
    // saw `active` and was allowed to transition active→rolled_back
    // (a valid state-machine edge), so BOTH succeeded. With the new
    // `expected_from` contract the caller declares "I expected proposed"
    // and the post-lock re-read catches the state divergence cleanly.
    const transitionCall = runWithTenantContext({ tenant_id: T, agent_id: A }, async () =>
      operationalProfileVersionsRepo.transition({
        id: proposedId,
        to: 'rolled_back',
        expected_from: 'proposed',
        rollback_reason: 'concurrent rollback',
      }),
    );

    const results = await Promise.allSettled([approveCall, transitionCall]);

    let approveWon = false;
    let transitionWon = false;

    const [approveRes, transitionRes] = results;
    if (approveRes.status === 'fulfilled' && approveRes.value.ok) approveWon = true;
    if (transitionRes.status === 'fulfilled' && transitionRes.value.ok) transitionWon = true;

    // Exactly one writer must have succeeded — single-winner is now the
    // hard contract once `expected_from` is enforced.
    expect(approveWon !== transitionWon).toBe(true);

    // Whichever lost must have surfaced a typed reason (NOT a thrown
    // duplicate-key or 500-class error).
    if (!approveWon) {
      expect(approveRes.status).toBe('fulfilled');
      if (approveRes.status === 'fulfilled' && !approveRes.value.ok) {
        // Expected: approve sees the locked row in `rolled_back` →
        // `invalid_source_status` (the proposed-status precondition no
        // longer holds).
        expect(['invalid_source_status', 'not_found', 'transition_failed']).toContain(
          approveRes.value.reason,
        );
      }
    }
    if (!transitionWon) {
      expect(transitionRes.status).toBe('fulfilled');
      if (transitionRes.status === 'fulfilled' && !transitionRes.value.ok) {
        // Expected (post-fix): approve won the lock first, committed the
        // proposed→active transition, and our `expected_from:'proposed'`
        // catches the state divergence → `stale` with actual='active'.
        // `not_found` is still acceptable if approve somehow deleted/
        // remapped the id (defensive).
        expect(['stale', 'not_found']).toContain(transitionRes.value.reason);
        if (transitionRes.value.reason === 'stale') {
          expect(transitionRes.value.expected_from).toBe('proposed');
          expect(transitionRes.value.actual).toBe('active');
        }
      }
    }

    // Final state: exactly one terminal status on the row (either
    // 'active' from approve or 'rolled_back' from transition). NEVER
    // a hybrid (active + rolled_back_at set).
    const c2 = await pool.connect();
    try {
      const r = await c2.query<{
        status: string;
        rolled_back_at: Date | null;
        activated_at: Date | null;
      }>(
        `SELECT status, rolled_back_at, activated_at
           FROM agent_operational_profile_versions
          WHERE id = $1`,
        [proposedId],
      );
      const row = r.rows[0]!;
      if (approveWon) {
        expect(row.status).toBe('active');
        expect(row.activated_at).not.toBeNull();
        expect(row.rolled_back_at).toBeNull();
      } else {
        expect(row.status).toBe('rolled_back');
        expect(row.rolled_back_at).not.toBeNull();
        // approve never landed → activated_at must NOT be set.
        expect(row.activated_at).toBeNull();
      }
    } finally {
      c2.release();
    }
  });

  /**
   * Scenario D: two concurrent `transition` calls on the SAME row. Pre-fix,
   * both would compute `from` from a non-locked read and could both UPDATE
   * the row to inconsistent terminal/non-terminal states. Post-fix, both
   * serialize on `lockParentAgent` + the status predicate guard rejects
   * the loser cleanly with `invalid_transition`.
   */
  it('two concurrent transition calls on same row → one wins, other invalid_transition', async () => {
    const { operationalProfileVersionsRepo } = await import('../../src/db/repositories.js');
    const { runWithTenantContext } = await import('../../src/db/tenant-context.js');

    const c = await pool.connect();
    let activeId: string;
    try {
      const r = await c.query<{ id: string }>(
        `INSERT INTO agent_operational_profile_versions
           (tenant_id, agent_id, version, status, profile_body, proposed_by, proposed_reason,
            approved_by, approved_at, activated_at)
         VALUES ($1, $2, 1, 'active',
                 jsonb_build_object('metadata', jsonb_build_object('previous_version_id', null)),
                 $3, 'concurrent transition target', $3, now(), now())
         RETURNING id`,
        [T, A, ACTOR],
      );
      activeId = r.rows[0]!.id;
    } finally {
      c.release();
    }

    // Codex Adversarial Review of PR #182 round 1: both callers declare
    // `expected_from: 'active'` reflecting the snapshot they observed
    // before racing. Pre-fix, this test was flaky because the chained
    // transition `active → frozen → rolled_back` was a valid state-machine
    // path, so when freeze won first, the waiting rollback re-read
    // `frozen` and was still allowed to commit (winners=2). With the
    // `expected_from` contract, the loser observes a state different from
    // what it snapshotted and surfaces `stale`.
    const freezeCall = runWithTenantContext({ tenant_id: T, agent_id: A }, async () =>
      operationalProfileVersionsRepo.transition({
        id: activeId,
        to: 'frozen',
        expected_from: 'active',
      }),
    );
    const rollbackCall = runWithTenantContext({ tenant_id: T, agent_id: A }, async () =>
      operationalProfileVersionsRepo.transition({
        id: activeId,
        to: 'rolled_back',
        expected_from: 'active',
        rollback_reason: 'concurrent transition',
      }),
    );

    const results = await Promise.allSettled([freezeCall, rollbackCall]);

    // Both must FULFILL (no throws) — that's the typed-result contract.
    for (const r of results) {
      expect(r.status).toBe('fulfilled');
    }

    let winners = 0;
    let losers = 0;
    for (const r of results) {
      if (r.status === 'fulfilled') {
        if (r.value.ok) winners++;
        else {
          losers++;
          // The loser must report a typed reason. Post-fix the canonical
          // outcome is `stale` (the active state the loser snapshotted
          // no longer holds). `invalid_transition`/`terminal` remain
          // acceptable for the narrow defense-in-depth window where the
          // status changed mid-write.
          expect(['stale', 'invalid_transition', 'terminal']).toContain(r.value.reason);
          if (r.value.reason === 'stale') {
            expect(r.value.expected_from).toBe('active');
            expect(['frozen', 'rolled_back']).toContain(r.value.actual);
          }
        }
      }
    }
    expect(winners).toBe(1);
    expect(losers).toBe(1);

    // Final state: row is in EITHER 'frozen' OR 'rolled_back' — never both.
    const c2 = await pool.connect();
    try {
      const r = await c2.query<{
        status: string;
        frozen_at: Date | null;
        rolled_back_at: Date | null;
      }>(
        `SELECT status, frozen_at, rolled_back_at
           FROM agent_operational_profile_versions
          WHERE id = $1`,
        [activeId],
      );
      const row = r.rows[0]!;
      expect(['frozen', 'rolled_back']).toContain(row.status);
      if (row.status === 'frozen') {
        expect(row.frozen_at).not.toBeNull();
        expect(row.rolled_back_at).toBeNull();
      } else {
        expect(row.rolled_back_at).not.toBeNull();
        // frozen_at MAY be null (rollback ran first); never both set.
      }
    } finally {
      c2.release();
    }
  });
});
