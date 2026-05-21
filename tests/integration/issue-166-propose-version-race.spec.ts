/**
 * Codex Adversarial Review on PR #171 (issue #166 follow-up):
 * `proposeAndAuditAtomic` previously read MAX(version) and inserted max+1
 * inside the tx without locking the parent agent row, so two concurrent
 * `updateProfile` calls for the same (tenant, agent) under READ COMMITTED
 * could both observe the same MAX and both try to insert the same next
 * version, colliding on `agent_op_profile_version_uq`. The fix locks the
 * parent `agents` row with `SELECT ... FOR UPDATE` before reading MAX.
 *
 * This spec proves the fix end-to-end against a real Postgres by firing
 * two concurrent `proposeAndAuditAtomic` calls with `Promise.all` and
 * asserting:
 *   1. Both promises resolve (no unhandled 500/throw).
 *   2. Both commit distinct, sequential versions (N+1 and N+2 — no
 *      collision, no version reused).
 *   3. Both leave an `admin_audit_log` row.
 *
 * A separate scenario exercises a missing agent (deleted between the
 * router's findById and the lock acquisition) and asserts the helper
 * returns the typed `{ agent_missing: true }` sentinel instead of throwing.
 *
 * Skipped without TEST_DB_URL (matches `pending-gate-concurrency.spec.ts`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const SHOULD_RUN = !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T = 'issue166-tenant';
const A = 'issue166-agent';
const ACTOR = 'issue166-actor';

let pool: pg.Pool;

d('operationalProfileVersionsRepo.proposeAndAuditAtomic (concurrency, real DB)', () => {
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
