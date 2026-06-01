/**
 * Codex Adversarial Review on PR #171 (issue #166 follow-up):
 *
 * Round 1: `proposeAndAuditAtomic` previously read MAX(version) and inserted
 * max+1 inside the tx without locking the parent agent row, so two concurrent
 * `updateProfile` calls for the same (tenant, agent) under READ COMMITTED
 * could both observe the same MAX and both try to insert the same next
 * version, colliding on `agent_op_profile_version_uq`. The fix locks the
 * parent `agents` row with `SELECT ... FOR UPDATE` before reading MAX.
 *
 * Round 2 (this file extended):
 *   - Predecessor enforcement: `approveAndActivateAtomic` now compares the
 *     proposal's `metadata.previous_version_id` against the freshly-locked
 *     incumbent active id, rejecting with `predecessor_conflict` when a
 *     newer version was approved in between (write-skew). See
 *     'predecessor conflict (real DB)' below.
 *   - Shared version allocator: `proposeAndAuditAtomic`,
 *     `operationalProfileVersionsRepo.create`, and `seedNewActiveAtomic` now
 *     all go through `acquireNextVersionForAgent`, which serializes ALL
 *     writers on the same parent-agent FOR UPDATE lock. See 'mixed-allocator
 *     concurrency (real DB)' below.
 *
 * Skipped without TEST_DB_URL (matches `pending-gate-concurrency.spec.ts`).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';

const SHOULD_RUN = !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T = 'issue166-tenant';
const A = 'issue166-agent';
const ACTOR = 'issue166-actor';

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

// Module-level setup so the three describe blocks below share a single
// pool + tenant/agent fixture. Each test resets the profile_versions table
// before running.
if (SHOULD_RUN) {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    const c = await pool.connect();
    try {
      await c.query(`INSERT INTO tenants(id, nome) VALUES ($1, 'Issue 166 Tenant') ON CONFLICT (id) DO NOTHING`, [T]);
      await c.query(
        `INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, 'Issue 166 Agent') ON CONFLICT (id) DO NOTHING`,
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

d('operationalProfileVersionsRepo.proposeAndAuditAtomic (concurrency, real DB)', () => {

  it('two concurrent proposals commit as distinct sequential versions', async () => {
    const { operationalProfileVersionsRepo } = await import('../../src/db/repositories.js');

    // Seed v1 so concurrent proposals must allocate v2 and v3 (more
    // interesting than the first-version corner case).
    const c0 = await pool.connect();
    try {
      await c0.query(
        `INSERT INTO agent_operational_profile_versions
           (tenant_id, agent_id, version, status, profile_body, proposed_by, proposed_reason)
         VALUES ($1, $2, 1, 'proposed', '{}'::jsonb, $3, 'seed')`,
        [T, A, ACTOR],
      );
    } finally {
      c0.release();
    }

    const baseArgs = {
      tenant_id: T,
      agent_id: A,
      profile_body: {},
      proposed_by: ACTOR,
      previous_active_id: null,
      actor_id: ACTOR,
      actor_role: 'founder',
    };

    const [a, b] = await Promise.all([
      operationalProfileVersionsRepo.proposeAndAuditAtomic({
        ...baseArgs,
        proposed_reason: 'concurrent-1',
      }),
      operationalProfileVersionsRepo.proposeAndAuditAtomic({
        ...baseArgs,
        proposed_reason: 'concurrent-2',
      }),
    ]);

    // Sanity: neither call should have returned `agent_missing` — the
    // agent exists.
    expect('agent_missing' in a).toBe(false);
    expect('agent_missing' in b).toBe(false);
    if ('agent_missing' in a || 'agent_missing' in b) throw new Error('unreachable');

    // The two versions allocated must be distinct AND must be {2, 3} (in
    // some order, since `Promise.all` does not guarantee which goroutine
    // gets the lock first). Crucially, neither attempted to reuse the
    // same number and collided on `agent_op_profile_version_uq`.
    const versions = [a.version.version, b.version.version].sort((x, y) => x - y);
    expect(versions).toEqual([2, 3]);

    // Both audit rows must be present — atomicity invariant.
    const c1 = await pool.connect();
    try {
      const r = await c1.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM admin_audit_log
          WHERE tenant_id = $1
            AND action = 'agent_profile_propose'
            AND resource_id = ANY($2::text[])`,
        [T, [a.version.id, b.version.id]],
      );
      expect(r.rows[0]!.count).toBe('2');
    } finally {
      c1.release();
    }
  });

  it('returns { agent_missing: true } when the parent agent does not exist', async () => {
    const { operationalProfileVersionsRepo } = await import('../../src/db/repositories.js');

    const result = await operationalProfileVersionsRepo.proposeAndAuditAtomic({
      tenant_id: T,
      agent_id: 'issue166-nonexistent-agent',
      profile_body: {},
      proposed_by: ACTOR,
      proposed_reason: 'missing-agent',
      previous_active_id: null,
      actor_id: ACTOR,
      actor_role: 'founder',
    });

    expect('agent_missing' in result).toBe(true);
    if ('agent_missing' in result) {
      expect(result.agent_missing).toBe(true);
    }

    // Nothing was inserted — atomicity invariant under the typed-miss path.
    const c = await pool.connect();
    try {
      const r = await c.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM agent_operational_profile_versions
          WHERE tenant_id = $1 AND agent_id = $2`,
        [T, 'issue166-nonexistent-agent'],
      );
      expect(r.rows[0]!.count).toBe('0');
    } finally {
      c.release();
    }
  });
});

d('operationalProfileVersionsRepo.approveAndActivateAtomic (predecessor conflict, real DB)', () => {
  /**
   * Sequencial scenario reproducing the [high] write-skew Codex round 2 #1
   * found:
   *   - v1 active.
   *   - Bob authors a proposal (v2) referencing v1 as predecessor.
   *   - Alice authors a proposal (v3) ALSO referencing v1 (didn't see Bob).
   *   - Bob's v2 is approved → v1 frozen, v2 active.
   *   - Alice's v3 is approved next.
   *
   * Without enforcement, Alice's v3 silently overwrites Bob's v2 while the
   * audit lineage still claims v1 as predecessor. With enforcement, the
   * second approval must be rejected with `predecessor_conflict`.
   */
  it('rejects approval of v3 when v2 was approved in between', async () => {
    const { operationalProfileVersionsRepo } = await import('../../src/db/repositories.js');

    const c = await pool.connect();
    let v1Id: string;
    let v2Id: string;
    let v3Id: string;
    try {
      // Seed v1 as active.
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

      // Bob proposes v2 with predecessor=v1.
      // (proposed_by is the literal 'bob' here, so v1Id is $3 — passing an
      // unused $3 left PG unable to infer its type: 42P18.)
      const r2 = await c.query<{ id: string }>(
        `INSERT INTO agent_operational_profile_versions
           (tenant_id, agent_id, version, status, profile_body, proposed_by, proposed_reason)
         VALUES ($1, $2, 2, 'proposed',
                 jsonb_build_object('metadata', jsonb_build_object('previous_version_id', $3::text)),
                 'bob', 'bob update')
         RETURNING id`,
        [T, A, v1Id],
      );
      v2Id = r2.rows[0]!.id;

      // Alice proposes v3 ALSO with predecessor=v1 (she didn't see Bob).
      const r3 = await c.query<{ id: string }>(
        `INSERT INTO agent_operational_profile_versions
           (tenant_id, agent_id, version, status, profile_body, proposed_by, proposed_reason)
         VALUES ($1, $2, 3, 'proposed',
                 jsonb_build_object('metadata', jsonb_build_object('previous_version_id', $3::text)),
                 'alice', 'alice update')
         RETURNING id`,
        [T, A, v1Id],
      );
      v3Id = r3.rows[0]!.id;
    } finally {
      c.release();
    }

    // Step 1: Bob's v2 is approved successfully — predecessor matches v1.
    const approveV2 = await operationalProfileVersionsRepo.approveAndActivateAtomic({
      tenant_id: T,
      agent_id: A,
      id: v2Id,
      actor_id: ACTOR,
      actor_role: 'founder',
      comment: 'approve bob v2',
    });
    expect(approveV2.ok).toBe(true);

    // Step 2: Alice's v3 is approved next. Predecessor expects v1 but
    // incumbent is now v2 → MUST reject.
    const approveV3 = await operationalProfileVersionsRepo.approveAndActivateAtomic({
      tenant_id: T,
      agent_id: A,
      id: v3Id,
      actor_id: ACTOR,
      actor_role: 'founder',
      comment: 'approve alice v3',
    });
    expect(approveV3.ok).toBe(false);
    if (!approveV3.ok) {
      expect(approveV3.reason).toBe('predecessor_conflict');
      if (approveV3.reason === 'predecessor_conflict') {
        expect(approveV3.expected).toBe(v1Id);
        expect(approveV3.current).toBe(v2Id);
      }
    }

    // v2 must STILL be active and v3 must STILL be proposed — atomicity
    // invariant under the rejection path.
    const c2 = await pool.connect();
    try {
      const r = await c2.query<{ id: string; status: string }>(
        `SELECT id, status FROM agent_operational_profile_versions
          WHERE tenant_id = $1 AND agent_id = $2`,
        [T, A],
      );
      const byId = Object.fromEntries(r.rows.map((row) => [row.id, row.status]));
      expect(byId[v1Id]).toBe('frozen');
      expect(byId[v2Id]).toBe('active');
      expect(byId[v3Id]).toBe('proposed');
    } finally {
      c2.release();
    }
  });

  it('rejects legacy proposal lacking metadata.previous_version_id', async () => {
    const { operationalProfileVersionsRepo } = await import('../../src/db/repositories.js');

    const c = await pool.connect();
    let legacyId: string;
    try {
      const r = await c.query<{ id: string }>(
        `INSERT INTO agent_operational_profile_versions
           (tenant_id, agent_id, version, status, profile_body, proposed_by, proposed_reason)
         VALUES ($1, $2, 1, 'proposed', '{}'::jsonb, $3, 'legacy proposal')
         RETURNING id`,
        [T, A, ACTOR],
      );
      legacyId = r.rows[0]!.id;
    } finally {
      c.release();
    }

    const res = await operationalProfileVersionsRepo.approveAndActivateAtomic({
      tenant_id: T,
      agent_id: A,
      id: legacyId,
      actor_id: ACTOR,
      actor_role: 'founder',
      comment: 'legacy approval attempt',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('predecessor_conflict');
      if (res.reason === 'predecessor_conflict') {
        expect(res.expected).toBe('unknown');
      }
    }
  });

  /**
   * Codex Adversarial Review of PR #171 round 3 ([high] #173) — migration 061
   * backfilled `metadata.previous_version_id = null` + `migrated_from_legacy:
   * true` for every legacy row. Without the discriminator, the predecessor
   * check would accept that explicit `null` as "no predecessor expected"
   * (valid for seed v1) and a stale migrated proposal could silently
   * activate against an empty active slot. The new `migrated_legacy_proposal`
   * sentinel forces operators to re-propose under the post-migration flow
   * with a real predecessor link.
   */
  it('rejects migrated legacy proposal (explicit null + migrated_from_legacy marker)', async () => {
    const { operationalProfileVersionsRepo } = await import('../../src/db/repositories.js');

    const c = await pool.connect();
    let migratedId: string;
    try {
      // Mirrors exactly what migration 061 writes: the consolidated
      // profile_body with metadata.previous_version_id=null and the
      // migrated_from_legacy=true marker.
      const r = await c.query<{ id: string }>(
        `INSERT INTO agent_operational_profile_versions
           (tenant_id, agent_id, version, status, profile_body, proposed_by, proposed_reason)
         VALUES ($1, $2, 1, 'proposed',
                 jsonb_build_object(
                   'metadata', jsonb_build_object(
                     'previous_version_id', null,
                     'migrated_from_legacy', true
                   )
                 ),
                 $3, 'migrated by 061')
         RETURNING id`,
        [T, A, ACTOR],
      );
      migratedId = r.rows[0]!.id;
    } finally {
      c.release();
    }

    const res = await operationalProfileVersionsRepo.approveAndActivateAtomic({
      tenant_id: T,
      agent_id: A,
      id: migratedId,
      actor_id: ACTOR,
      actor_role: 'founder',
      comment: 'migrated legacy approval attempt',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('migrated_legacy_proposal');
      if (res.reason === 'migrated_legacy_proposal') {
        expect(res.expected).toBeNull();
        expect(res.current).toBeNull();
      }
    }

    // Row must STILL be proposed — atomicity invariant under rejection.
    const c2 = await pool.connect();
    try {
      const r = await c2.query<{ status: string }>(
        `SELECT status FROM agent_operational_profile_versions WHERE id = $1`,
        [migratedId],
      );
      expect(r.rows[0]!.status).toBe('proposed');
    } finally {
      c2.release();
    }
  });

  /**
   * Codex Adversarial Review of PR #171 round 3 — confirms the intentional-
   * seed path still works under real-DB conditions. v1, no incumbent,
   * explicit null predecessor (no migrated marker) → approve succeeds.
   * Matches the `createWithSeedAndAudit → approveProfile` happy path.
   */
  it('approves intentional seed (v1, no incumbent, explicit null predecessor)', async () => {
    const { operationalProfileVersionsRepo } = await import('../../src/db/repositories.js');

    const c = await pool.connect();
    let seedId: string;
    try {
      const r = await c.query<{ id: string }>(
        `INSERT INTO agent_operational_profile_versions
           (tenant_id, agent_id, version, status, profile_body, proposed_by, proposed_reason)
         VALUES ($1, $2, 1, 'proposed',
                 jsonb_build_object(
                   'metadata', jsonb_build_object('previous_version_id', null)
                 ),
                 $3, 'intentional seed v1')
         RETURNING id`,
        [T, A, ACTOR],
      );
      seedId = r.rows[0]!.id;
    } finally {
      c.release();
    }

    const res = await operationalProfileVersionsRepo.approveAndActivateAtomic({
      tenant_id: T,
      agent_id: A,
      id: seedId,
      actor_id: ACTOR,
      actor_role: 'founder',
      comment: 'first activation for this agent',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.frozen_previous).toBeNull();
      expect(res.activated.id).toBe(seedId);
    }
  });
});

d('cross-allocator concurrency: seedNewActiveAtomic + approveAndActivateAtomic', () => {
  /**
   * Codex Adversarial Review of PR #171 round 3 ([medium]) — `seedNewActiveAtomic`
   * (priorities migration) and `approveAndActivateAtomic` (Admin UI approve)
   * both mutate the `(tenant, agent)` active slot. Until round 3, only
   * `seedNewActiveAtomic` took the parent-agent FOR UPDATE lock; approve
   * only locked the proposed and active ROW tuples. A concurrent migration
   * + approve could race on the freeze/insert and surface a partial-unique-
   * index error as a 500.
   *
   * The fix: `approveAndActivateAtomic` now takes `lockParentAgent` as its
   * FIRST step, before reading proposed/active rows. This test fires both
   * writers concurrently against the same agent and asserts:
   *   - both complete without an unhandled throw,
   *   - one freezes the other's output OR both run sequentially (lock
   *     serialization → no partial-unique-index 500),
   *   - there is exactly one `active` row at the end (invariant preserved).
   */
  it('seedNewActiveAtomic + approveAndActivateAtomic concurrent → serialized, one active', async () => {
    const { operationalProfileVersionsRepo } = await import('../../src/db/repositories.js');
    const { runWithTenantContext } = await import('../../src/db/tenant-context.js');

    // Setup: seed v1 active and v2 proposed (predecessor=v1) — so the
    // approve call has a valid target with a non-null predecessor that
    // matches the incumbent.
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
                 $3, 'seed', $3, now(), now())
         RETURNING id`,
        [T, A, ACTOR],
      );
      v1Id = r1.rows[0]!.id;

      const r2 = await c.query<{ id: string }>(
        `INSERT INTO agent_operational_profile_versions
           (tenant_id, agent_id, version, status, profile_body, proposed_by, proposed_reason)
         VALUES ($1, $2, 2, 'proposed',
                 jsonb_build_object('metadata', jsonb_build_object('previous_version_id', $3::text)),
                 'admin', 'admin update')
         RETURNING id`,
        [T, A, v1Id],
      );
      v2Id = r2.rows[0]!.id;
    } finally {
      c.release();
    }

    // approveAndActivateAtomic: tries to promote v2 (predecessor=v1).
    const approveCall = operationalProfileVersionsRepo.approveAndActivateAtomic({
      tenant_id: T,
      agent_id: A,
      id: v2Id,
      actor_id: ACTOR,
      actor_role: 'founder',
      comment: 'approve v2 concurrently with migration',
    });

    // seedNewActiveAtomic: priorities-migration style call. Allocates next
    // version, freezes current active, inserts new active. Wraps in
    // runWithTenantContext for the AsyncLocalStorage reads.
    const seedCall = runWithTenantContext({ tenant_id: T, agent_id: A }, async () =>
      operationalProfileVersionsRepo.seedNewActiveAtomic({
        profile_body: {
          metadata: { previous_version_id: null },
        } as unknown as Parameters<
          typeof operationalProfileVersionsRepo.seedNewActiveAtomic
        >[0]['profile_body'],
        proposed_by: 'p8d-migration',
        proposed_reason: 'priorities migration concurrent with admin approve',
      }),
    );

    // Both must resolve — no unhandled throws, no partial-unique-index 500.
    // Either outcome is acceptable as long as the invariant (exactly one
    // active row at the end) is preserved:
    //   (a) Approve runs first → v1 frozen, v2 active; then seed allocates
    //       v3, freezes v2, inserts v3 active.
    //   (b) Seed runs first → allocates v2 (oh wait, v2 is taken), so seed
    //       allocates v3, freezes v1, inserts v3 active. Then approve fires
    //       on v2 — predecessor mismatch (expected v1, current v3) → rejects
    //       cleanly with `predecessor_conflict`.
    //
    // Either way: ZERO partial-unique-index errors, exactly one row active.
    const results = await Promise.allSettled([approveCall, seedCall]);

    // Every promise must either fulfill with a result OR reject with the
    // typed `predecessor_conflict` (acceptable serialized outcome). NO
    // promise may reject with a Postgres unique-index error.
    for (const r of results) {
      if (r.status === 'rejected') {
        const msg = String(r.reason);
        // The unique-index violation message we are guarding against.
        expect(msg).not.toMatch(/agent_op_profile_active_uniq/i);
        expect(msg).not.toMatch(/duplicate key/i);
      }
    }

    // Invariant: exactly one `active` row.
    const c2 = await pool.connect();
    try {
      const r = await c2.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM agent_operational_profile_versions
          WHERE tenant_id = $1 AND agent_id = $2 AND status = 'active'`,
        [T, A],
      );
      expect(r.rows[0]!.count).toBe('1');
    } finally {
      c2.release();
    }
  });
});

d('mixed-allocator concurrency: proposeAndAuditAtomic + operationalProfileVersionsRepo.create', () => {
  /**
   * Codex Adversarial Review of PR #171 round 2 #2 — `operationalProfileVersionsRepo.create`
   * previously did `MAX(version)+1` WITHOUT locking the agent row, so it
   * could race against `proposeAndAuditAtomic` (which DOES lock) and produce
   * a unique-index collision. Both writers now go through
   * `acquireNextVersionForAgent` (shared FOR UPDATE on the agents row).
   *
   * This test fires both writers concurrently and asserts they each commit
   * a distinct sequential version with no collision.
   */
  it('proposeAndAuditAtomic + create concurrent against same agent → distinct versions', async () => {
    const { operationalProfileVersionsRepo } = await import('../../src/db/repositories.js');
    const { runWithTenantContext } = await import('../../src/db/tenant-context.js');

    // Seed v1 so concurrent writers must allocate v2 and v3.
    const c0 = await pool.connect();
    try {
      await c0.query(
        `INSERT INTO agent_operational_profile_versions
           (tenant_id, agent_id, version, status, profile_body, proposed_by, proposed_reason)
         VALUES ($1, $2, 1, 'proposed', '{}'::jsonb, $3, 'seed')`,
        [T, A, ACTOR],
      );
    } finally {
      c0.release();
    }

    // `operationalProfileVersionsRepo.create` reads tenant/agent from
    // AsyncLocalStorage — wrap in `runWithTenantContext`.
    const createCall = runWithTenantContext({ tenant_id: T, agent_id: A }, async () =>
      operationalProfileVersionsRepo.create({
        profile_body: {
          metadata: { previous_version_id: null },
        } as unknown as Parameters<typeof operationalProfileVersionsRepo.create>[0]['profile_body'],
        proposed_by: ACTOR,
        proposed_reason: 'create call',
      }),
    );
    const proposeCall = operationalProfileVersionsRepo.proposeAndAuditAtomic({
      tenant_id: T,
      agent_id: A,
      profile_body: {},
      proposed_by: ACTOR,
      proposed_reason: 'propose call',
      previous_active_id: null,
      actor_id: ACTOR,
      actor_role: 'founder',
    });

    const [createRes, proposeRes] = await Promise.all([createCall, proposeCall]);

    expect('agent_missing' in proposeRes).toBe(false);
    if ('agent_missing' in proposeRes) throw new Error('unreachable');

    // Both writers must have produced distinct versions in {2, 3}.
    const versions = [createRes.version, proposeRes.version.version].sort((x, y) => x - y);
    expect(versions).toEqual([2, 3]);

    // And exactly 3 rows total: the seed + the 2 newly-allocated.
    const c1 = await pool.connect();
    try {
      const r = await c1.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM agent_operational_profile_versions
          WHERE tenant_id = $1 AND agent_id = $2`,
        [T, A],
      );
      expect(r.rows[0]!.count).toBe('3');
    } finally {
      c1.release();
    }
  });
});
