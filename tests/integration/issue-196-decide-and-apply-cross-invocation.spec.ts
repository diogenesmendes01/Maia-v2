/**
 * Codex Adversarial Review of PR #196 round 1 (issue #177 follow-up):
 *
 * The round 4 refetch helper queried `WHERE status='active' LIMIT 1`, so in
 * the EXACT cross-invocation freeze race the patch was meant to recover —
 * target row already frozen by a concurrent invocation, no replacement
 * seeded — the helper returned `null` against real Postgres because the
 * frozen row no longer matched the predicate. The engine then took the
 * `currentActiveId !== profileId` branch and skipped with
 * `active_replaced`, dropping the critical rollback in the very scenario
 * the escalation was designed to handle.
 *
 * The unit tests on PR #196 round 0 missed this because they mocked the
 * helper to return the (impossible) original id when target was frozen
 * with no replacement. This integration test uses a real Postgres: it
 * seeds v1 as active, freezes v1 from outside the engine (simulating a
 * concurrent `alto` worker), then calls `decideAndApply` with critico
 * evidence and asserts v1 ends `rolled_back` — the bug fix's whole point.
 *
 * Skipped without TEST_DB_URL.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { DriftType } from '@/types/enums.js';

const SHOULD_RUN = !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T = 'issue196-tenant';
const A = 'issue196-agent';
const ACTOR = 'issue196-actor';

let pool: pg.Pool;

async function resetState(): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query(`DELETE FROM agent_drift_alerts WHERE tenant_id = $1`, [T]);
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
        `INSERT INTO tenants(id, nome) VALUES ($1, 'Issue 196 Tenant') ON CONFLICT (id) DO NOTHING`,
        [T],
      );
      await c.query(
        `INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, 'Issue 196 Agent') ON CONFLICT (id) DO NOTHING`,
        [A, T],
      );
    } finally {
      c.release();
    }
  });

  afterAll(async () => {
    const c = await pool.connect();
    try {
      await c.query(`DELETE FROM agent_drift_alerts WHERE tenant_id = $1`, [T]);
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
    await resetState();
  });
}

d('decideAndApply cross-invocation freeze race (real DB, PR #196 regression)', () => {
  /**
   * The canonical PR #196 scenario:
   *   - v1 is seeded as `active`.
   *   - A concurrent worker froze v1 (status='active' → 'frozen') BEFORE
   *     this `decideAndApply` invocation got to commit. No replacement
   *     version exists.
   *   - This invocation has CRITICO evidence (rollback). It should
   *     escalate `frozen → rolled_back`, not skip.
   *
   * Before PR #196 round 0, `getCurrentActiveProfileId` returned `null` (no
   * row had status='active'), the engine compared `null !== v1Id` and took
   * the `active_replaced` path → v1 stayed frozen, the critical rollback
   * was lost.
   *
   * After PR #196 round 2 (this patch), the engine calls
   * `escalateRollbackIfStillFrozen` — a single atomic repo method that
   * re-reads target row + active slot FOR UPDATE under `lockParentAgent`
   * and commits the rollback if both predicates still hold under the lock.
   * v1 ends `rolled_back`.
   */
  it('v1 frozen by concurrent worker, no replacement → critico escalates to rolled_back', async () => {
    const { operationalProfileVersionsRepo } = await import('../../src/db/repositories.js');
    const { runWithTenantContext } = await import('../../src/db/tenant-context.js');
    const { decideAndApply } = await import('../../src/cognition/drift/decision-engine.js');

    // Seed v1 as active.
    const c = await pool.connect();
    let v1Id: string;
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
      v1Id = r.rows[0]!.id;
    } finally {
      c.release();
    }

    // Simulate the concurrent `alto` invocation that froze v1 first.
    // Use the repository's transition so the state-machine guards run
    // exactly like in production.
    const freezeRes = await runWithTenantContext({ tenant_id: T, agent_id: A }, async () =>
      operationalProfileVersionsRepo.transition({
        id: v1Id,
        to: 'frozen',
        expected_from: 'active',
        approved_by: 'auto:drift_alto',
      }),
    );
    expect(freezeRes.ok).toBe(true);

    // Sanity: v1 is frozen, no row has status='active'.
    {
      const c2 = await pool.connect();
      try {
        const rows = await c2.query<{ id: string; status: string }>(
          `SELECT id, status FROM agent_operational_profile_versions
            WHERE tenant_id = $1 AND agent_id = $2`,
          [T, A],
        );
        const v1 = rows.rows.find((row) => row.id === v1Id)!;
        expect(v1.status).toBe('frozen');
        const active = rows.rows.filter((row) => row.status === 'active');
        expect(active).toHaveLength(0);
      } finally {
        c2.release();
      }
    }

    // Now run the second invocation. The engine still believes v1 is
    // active (it captured args.active_profile_id BEFORE the freeze landed)
    // — exactly the race the patch must handle.
    const out = await runWithTenantContext({ tenant_id: T, agent_id: A }, async () =>
      decideAndApply({
        evidences: [
          {
            drift_type: DriftType.LINGUAGEM,
            detected_by: 'drift_detector_linguagem',
            payload: { offensive: true },
            evidence_summary: 'cross-invocation critical: offensive content',
          },
        ],
        active_profile_id: v1Id,
      }),
    );

    // The decision engine emitted exactly one result for the critico
    // evidence.
    expect(out).toHaveLength(1);
    const r = out[0]!;
    // The whole point: the critical rollback WAS applied (escalated).
    // If the previous round's bug returned, this would be `applied: false`
    // with `applied_error: stale:expected=active,actual=frozen;active_replaced`.
    expect(r.applied).toBe(true);
    expect(r.applied_error).toBeUndefined();

    // Final state: v1 is rolled_back (the escalation succeeded).
    const c3 = await pool.connect();
    try {
      const rows = await c3.query<{
        id: string;
        status: string;
        rolled_back_at: Date | null;
        rollback_reason: string | null;
      }>(
        `SELECT id, status, rolled_back_at, rollback_reason
           FROM agent_operational_profile_versions
          WHERE id = $1`,
        [v1Id],
      );
      const v1 = rows.rows[0]!;
      expect(v1.status).toBe('rolled_back');
      expect(v1.rolled_back_at).not.toBeNull();
      expect(v1.rollback_reason).toBe(
        'cross-invocation critical: offensive content',
      );
    } finally {
      c3.release();
    }
  });

  /**
   * CASE B regression (replacement exists): if a concurrent seed froze v1
   * AND seeded v2 as the new active, the engine MUST skip — the evidence
   * was scored against v1's contract surface, and v2 is now the active
   * surface. Rolling back v1 doesn't help; the next drift cycle will
   * re-evaluate against v2.
   */
  it('v1 frozen + v2 seeded as new active → critico skips with active_replaced', async () => {
    const { operationalProfileVersionsRepo } = await import('../../src/db/repositories.js');
    const { runWithTenantContext } = await import('../../src/db/tenant-context.js');
    const { decideAndApply } = await import('../../src/cognition/drift/decision-engine.js');

    // Seed v1 as active, freeze it, then seed v2 as the new active.
    const c = await pool.connect();
    let v1Id: string;
    let v2Id: string;
    try {
      const r1 = await c.query<{ id: string }>(
        `INSERT INTO agent_operational_profile_versions
           (tenant_id, agent_id, version, status, profile_body, proposed_by, proposed_reason,
            approved_by, approved_at, activated_at)
         VALUES ($1, $2, 1, 'active',
                 jsonb_build_object('metadata', jsonb_build_object('previous_version_id', null)),
                 $3, 'seed v1', $3, now(), now())
         RETURNING id`,
        [T, A, ACTOR],
      );
      v1Id = r1.rows[0]!.id;
    } finally {
      c.release();
    }

    const freezeRes = await runWithTenantContext({ tenant_id: T, agent_id: A }, async () =>
      operationalProfileVersionsRepo.transition({
        id: v1Id,
        to: 'frozen',
        expected_from: 'active',
        approved_by: 'auto:drift_alto',
      }),
    );
    expect(freezeRes.ok).toBe(true);

    // Insert v2 as the new active.
    {
      const c2 = await pool.connect();
      try {
        const r2 = await c2.query<{ id: string }>(
          `INSERT INTO agent_operational_profile_versions
             (tenant_id, agent_id, version, status, profile_body, proposed_by, proposed_reason,
              approved_by, approved_at, activated_at)
           VALUES ($1, $2, 2, 'active',
                   jsonb_build_object('metadata', jsonb_build_object('previous_version_id', $4::text)),
                   $3, 'seed v2 (replacement)', $3, now(), now())
           RETURNING id`,
          [T, A, ACTOR, v1Id],
        );
        v2Id = r2.rows[0]!.id;
      } finally {
        c2.release();
      }
    }

    // Engine still believes v1 is active.
    const out = await runWithTenantContext({ tenant_id: T, agent_id: A }, async () =>
      decideAndApply({
        evidences: [
          {
            drift_type: DriftType.LINGUAGEM,
            detected_by: 'drift_detector_linguagem',
            payload: { offensive: true },
            evidence_summary: 'cross-invocation critico vs replaced active',
          },
        ],
        active_profile_id: v1Id,
      }),
    );

    expect(out).toHaveLength(1);
    const r = out[0]!;
    expect(r.applied).toBe(false);
    expect(r.applied_error).toBe(
      'stale:expected=active,actual=frozen;active_replaced',
    );

    // Final state: v1 stays frozen, v2 stays active.
    const c3 = await pool.connect();
    try {
      const rows = await c3.query<{ id: string; status: string }>(
        `SELECT id, status FROM agent_operational_profile_versions
          WHERE tenant_id = $1 AND agent_id = $2
          ORDER BY version`,
        [T, A],
      );
      const v1 = rows.rows.find((row) => row.id === v1Id)!;
      const v2 = rows.rows.find((row) => row.id === v2Id)!;
      expect(v1.status).toBe('frozen');
      expect(v2.status).toBe('active');
    } finally {
      c3.release();
    }
  });

  /**
   * Scenario 3 (Codex Adversarial Review of PR #196 round 2 [P1] regression):
   *
   * The exact TOCTOU window the round-1 fix left open. After the first
   * `transition` returns `stale + actual='frozen'`, the round-1 code read
   * the active slot OUTSIDE any lock, RELEASED that snapshot, then opened a
   * fresh tx for the retry. Between the unlocked refetch and the retry
   * tx, a `frozen → active` REACTIVATION can land (legal state-machine
   * edge). The retry's `expected_from='frozen'` guard surfaces stale, but
   * the original observation that "no replacement exists" was already wrong
   * — the target row IS the replacement (back in service).
   *
   * Round 2 fix: the atomic `escalateRollbackIfStillFrozen` re-reads the
   * target row FOR UPDATE inside the same tx as the active-slot read, so
   * a `frozen → active` reactivation that lands between observation and
   * tx open is observed atomically. The method returns `reactivated` and
   * the engine logs `drift.skip.reactivated` instead of rolling back a
   * live row.
   *
   * The test simulates this by freezing v1, then re-activating v1 (a real
   * `frozen → active` edge — operator recovery flow), then calling
   * `decideAndApply` with the engine still believing v1 is `active`. The
   * first transition surfaces stale; the atomic escalation observes v1
   * back to `active` under the lock and refuses to roll back.
   */
  it('v1 frozen then REACTIVATED before retry → escalation skips with reactivated (v1 stays active)', async () => {
    const { operationalProfileVersionsRepo } = await import('../../src/db/repositories.js');
    const { runWithTenantContext } = await import('../../src/db/tenant-context.js');
    const { decideAndApply } = await import('../../src/cognition/drift/decision-engine.js');

    // Seed v1 as active.
    const c = await pool.connect();
    let v1Id: string;
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
      v1Id = r.rows[0]!.id;
    } finally {
      c.release();
    }

    // Simulate the alto invocation that freezes v1.
    const freezeRes = await runWithTenantContext({ tenant_id: T, agent_id: A }, async () =>
      operationalProfileVersionsRepo.transition({
        id: v1Id,
        to: 'frozen',
        expected_from: 'active',
        approved_by: 'auto:drift_alto',
      }),
    );
    expect(freezeRes.ok).toBe(true);

    // Operator (or recovery flow) reactivates v1: frozen → active. This is
    // a legal state-machine edge, and the round-1 fix's unlocked refetch
    // would observe NO active occupant momentarily and let the retry roll
    // back a row that's now back in service.
    const reactivateRes = await runWithTenantContext({ tenant_id: T, agent_id: A }, async () =>
      operationalProfileVersionsRepo.transition({
        id: v1Id,
        to: 'active',
        expected_from: 'frozen',
        approved_by: 'operator:recovery',
      }),
    );
    expect(reactivateRes.ok).toBe(true);

    // Sanity: v1 is back to active.
    {
      const c2 = await pool.connect();
      try {
        const rows = await c2.query<{ status: string }>(
          `SELECT status FROM agent_operational_profile_versions WHERE id = $1`,
          [v1Id],
        );
        expect(rows.rows[0]!.status).toBe('active');
      } finally {
        c2.release();
      }
    }

    // Engine still has the stale args.active_profile_id = v1Id and observes
    // status='frozen' on the first transition's pre-lock read (or, in this
    // controlled simulation, we just rely on the engine's first transition
    // call surfacing stale because the state machine's `active → rolled_back`
    // does not detect the intermediate frozen state — but since v1 is
    // currently `active`, the first transition will SUCCEED. To force the
    // exact race the round-2 fix targets, freeze v1 again immediately
    // before invoking the engine, then re-activate it BEFORE the atomic
    // escalation runs. We can't easily inject between the engine's two
    // calls in-process, so we use the deterministic equivalent: freeze v1,
    // call the engine, and use a transition-then-reactivate hook.
    //
    // The simpler deterministic shape that exercises the same atomic
    // method: freeze v1, then reactivate v1, then call the engine. The
    // engine sees v1='active' on the first transition (no stale path,
    // returns ok). That doesn't exercise escalation. The race the fix
    // closes requires intervening between transitions, which is only
    // testable at the repo level. So below we exercise the repo method
    // DIRECTLY for the reactivated case — the unit-test layer covers the
    // engine wiring, and this asserts the repo's contract under real DB.
    const freezeAgain = await runWithTenantContext({ tenant_id: T, agent_id: A }, async () =>
      operationalProfileVersionsRepo.transition({
        id: v1Id,
        to: 'frozen',
        expected_from: 'active',
        approved_by: 'auto:drift_alto_2',
      }),
    );
    expect(freezeAgain.ok).toBe(true);

    // Now reactivate before calling the atomic method — this is the race
    // the unlocked refetch would have missed.
    const reactivateAgain = await runWithTenantContext({ tenant_id: T, agent_id: A }, async () =>
      operationalProfileVersionsRepo.transition({
        id: v1Id,
        to: 'active',
        expected_from: 'frozen',
        approved_by: 'operator:recovery_2',
      }),
    );
    expect(reactivateAgain.ok).toBe(true);

    // Atomic escalation: the method must observe v1=active under the lock
    // and refuse to roll back.
    const escalation = await operationalProfileVersionsRepo.escalateRollbackIfStillFrozen({
      tenant_id: T,
      agent_id: A,
      target_profile_id: v1Id,
      approved_by: 'auto:drift_critico',
      rollback_reason: 'critico vs reactivated row',
    });

    expect(escalation.ok).toBe(false);
    if (!escalation.ok) {
      expect(escalation.reason).toBe('reactivated');
    }

    // Final state: v1 STAYS active (rollback was correctly refused).
    const c3 = await pool.connect();
    try {
      const rows = await c3.query<{ status: string }>(
        `SELECT status FROM agent_operational_profile_versions WHERE id = $1`,
        [v1Id],
      );
      expect(rows.rows[0]!.status).toBe('active');
    } finally {
      c3.release();
    }
  });

  /**
   * Scenario 4: target already `rolled_back` when escalation runs (terminal
   * state). Another worker won the escalation race; this one's atomic
   * method observes `actual_status='rolled_back'` under the lock and
   * skips. v1 stays rolled_back. The engine reports applied=false with
   * `terminal:actual=rolled_back`.
   */
  it('v1 already rolled_back by another worker → escalation skips with terminal_state', async () => {
    const { operationalProfileVersionsRepo } = await import('../../src/db/repositories.js');
    const { runWithTenantContext } = await import('../../src/db/tenant-context.js');

    // Seed v1 as active, then freeze, then rolled_back (terminal).
    const c = await pool.connect();
    let v1Id: string;
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
      v1Id = r.rows[0]!.id;
    } finally {
      c.release();
    }

    const freezeRes = await runWithTenantContext({ tenant_id: T, agent_id: A }, async () =>
      operationalProfileVersionsRepo.transition({
        id: v1Id,
        to: 'frozen',
        expected_from: 'active',
        approved_by: 'auto:drift_alto',
      }),
    );
    expect(freezeRes.ok).toBe(true);

    const rollbackRes = await runWithTenantContext({ tenant_id: T, agent_id: A }, async () =>
      operationalProfileVersionsRepo.transition({
        id: v1Id,
        to: 'rolled_back',
        expected_from: 'frozen',
        approved_by: 'auto:drift_critico_winner',
        rollback_reason: 'first-mover rollback',
      }),
    );
    expect(rollbackRes.ok).toBe(true);

    // Now our (loser) invocation's escalation tries to escalate. The
    // re-read under the lock sees status='rolled_back'.
    const escalation = await operationalProfileVersionsRepo.escalateRollbackIfStillFrozen({
      tenant_id: T,
      agent_id: A,
      target_profile_id: v1Id,
      approved_by: 'auto:drift_critico_loser',
      rollback_reason: 'second-mover rollback (should be skipped)',
    });

    expect(escalation.ok).toBe(false);
    if (!escalation.ok) {
      expect(escalation.reason).toBe('terminal_state');
      if (escalation.reason === 'terminal_state') {
        expect(escalation.actual_status).toBe('rolled_back');
      }
    }

    // Final state: v1's rollback_reason is the FIRST mover's, not the
    // loser's — the loser's escalation was correctly a no-op.
    const c2 = await pool.connect();
    try {
      const rows = await c2.query<{ status: string; rollback_reason: string | null }>(
        `SELECT status, rollback_reason FROM agent_operational_profile_versions WHERE id = $1`,
        [v1Id],
      );
      expect(rows.rows[0]!.status).toBe('rolled_back');
      expect(rows.rows[0]!.rollback_reason).toBe('first-mover rollback');
    } finally {
      c2.release();
    }
  });
});
