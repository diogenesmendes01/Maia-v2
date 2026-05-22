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
   * Before this patch, `getCurrentActiveProfileId` returned `null` (no row
   * had status='active'), the engine compared `null !== v1Id` and took the
   * `active_replaced` path → v1 stayed frozen, the critical rollback was
   * lost.
   *
   * After this patch, `getActiveContextForAgent` returns
   * `{ active_profile_id: null }`, the engine recognises "no replacement
   * holds the active slot", and retries with `expected_from:'frozen'` →
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
});
