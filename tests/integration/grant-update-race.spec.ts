/**
 * PR #494 review [medium] — agentToolGrantsRepo.updateWithAudit concurrency.
 *
 * The read-modify-write used to read the current grant OUTSIDE the tx: two
 * concurrent writers (e.g. /setup/mcp toggling a pack while the capabilities
 * modal saves) could read the same snapshot and the last full-array upsert
 * clobbered the other's change — and the audit `previous` recorded the stale
 * snapshot. The helper now takes a pure `compute(current)` callback and reads
 * `current` under SELECT ... FOR UPDATE inside the tx (with a single retry on
 * the first-write 23505 race).
 *
 * This spec proves against live Postgres:
 *   1. Two concurrent pack additions BOTH survive (no lost update).
 *   2. Two audit rows exist, and one of them records the other's pack in its
 *      `previous` (i.e., the second writer saw the first's committed state).
 *   3. Concurrent FIRST write (no row yet): both complete, row contains both
 *      packs, exactly two audit rows (the 23505 loser retried serialized).
 *
 * Skipped without TEST_DB_URL (matches channel-role-create-with-audit.spec.ts).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T = 'pr494-tenant';
const A = 'pr494-agent';
const ACTOR = 'pr494-actor';

let pool: pg.Pool;

async function wipe(): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query(`DELETE FROM admin_audit_log WHERE tenant_id = $1`, [T]);
    await c.query(`DELETE FROM agent_tool_grants WHERE tenant_id = $1`, [T]);
  } finally {
    c.release();
  }
}

function addPackCompute(pack: string) {
  return (current: { granted_packs: string[]; granted_tools: string[]; denied_tools: string[] } | null) => ({
    ok: true as const,
    granted_packs: [...new Set([...(current?.granted_packs ?? ['baseline.core']), pack])],
    granted_tools: current?.granted_tools ?? [],
    denied_tools: current?.denied_tools ?? [],
  });
}

if (SHOULD_RUN) {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    const c = await pool.connect();
    try {
      await c.query(
        `INSERT INTO tenants(id, nome) VALUES ($1, 'PR 494 Tenant') ON CONFLICT (id) DO NOTHING`,
        [T],
      );
      await c.query(
        `INSERT INTO agents(id, tenant_id, nome, status) VALUES ($1, $2, 'PR 494 Agent', 'active') ON CONFLICT (id) DO NOTHING`,
        [A, T],
      );
    } finally {
      c.release();
    }
  });

  afterAll(async () => {
    await wipe();
    const c = await pool.connect();
    try {
      await c.query(`DELETE FROM agents WHERE tenant_id = $1`, [T]);
      await c.query(`DELETE FROM tenants WHERE id = $1`, [T]);
    } finally {
      c.release();
      await pool.end();
    }
  });

  beforeEach(async () => {
    await wipe();
  });
}

d('agentToolGrantsRepo.updateWithAudit (concurrent writers, real DB)', () => {
  it('two concurrent pack additions on an EXISTING row: no lost update, previous chains', async () => {
    const { agentToolGrantsRepo } = await import('../../src/db/repositories.js');

    // Seed a base row so both writers lock the same row (no insert race).
    const seed = await agentToolGrantsRepo.updateWithAudit({
      tenant_id: T,
      agent_id: A,
      compute: addPackCompute('domain.calendar'),
      granted_by: ACTOR,
      reason: 'seed base grant for race test',
      audit: { actor_id: ACTOR, actor_role: 'owner', action: 'agent_capabilities_update' },
    });
    expect(seed.ok).toBe(true);
    await pool.query(`DELETE FROM admin_audit_log WHERE tenant_id = $1`, [T]);

    const [r1, r2] = await Promise.all([
      agentToolGrantsRepo.updateWithAudit({
        tenant_id: T,
        agent_id: A,
        compute: addPackCompute('domain.finance'),
        granted_by: ACTOR,
        reason: 'writer A adds finance',
        audit: { actor_id: ACTOR, actor_role: 'owner', action: 'agent_capabilities_update' },
      }),
      agentToolGrantsRepo.updateWithAudit({
        tenant_id: T,
        agent_id: A,
        compute: addPackCompute('domain.support'),
        granted_by: ACTOR,
        reason: 'writer B adds support',
        audit: { actor_id: ACTOR, actor_role: 'owner', action: 'agent_capabilities_update' },
      }),
    ]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    const rows = await pool.query(
      `SELECT granted_packs FROM agent_tool_grants WHERE tenant_id = $1 AND agent_id = $2`,
      [T, A],
    );
    expect(rows.rows.length).toBe(1);
    const packs: string[] = rows.rows[0]!.granted_packs;
    // The whole point: NEITHER addition was clobbered by the other.
    expect(packs).toContain('domain.finance');
    expect(packs).toContain('domain.support');

    const audits = await pool.query(
      `SELECT change_summary FROM admin_audit_log WHERE tenant_id = $1 ORDER BY id`,
      [T],
    );
    expect(audits.rows.length).toBe(2);
    // The second writer's `previous` must include the first writer's pack —
    // proof it read the committed state under lock, not a stale snapshot.
    const second = audits.rows[1]!.change_summary as {
      previous: { granted_packs: string[] };
      next: { granted_packs: string[] };
    };
    const firstNext = (audits.rows[0]!.change_summary as {
      next: { granted_packs: string[] };
    }).next.granted_packs;
    const firstAdded = firstNext.includes('domain.finance')
      ? 'domain.finance'
      : 'domain.support';
    expect(second.previous.granted_packs).toContain(firstAdded);
  });

  it('two concurrent FIRST writes (no row yet): 23505 loser retries, both packs land', async () => {
    const { agentToolGrantsRepo } = await import('../../src/db/repositories.js');

    const [r1, r2] = await Promise.all([
      agentToolGrantsRepo.updateWithAudit({
        tenant_id: T,
        agent_id: A,
        compute: addPackCompute('domain.finance'),
        granted_by: ACTOR,
        reason: 'first-writer A (finance)',
        audit: { actor_id: ACTOR, actor_role: 'owner', action: 'agent_capabilities_update' },
      }),
      agentToolGrantsRepo.updateWithAudit({
        tenant_id: T,
        agent_id: A,
        compute: addPackCompute('domain.support'),
        granted_by: ACTOR,
        reason: 'first-writer B (support)',
        audit: { actor_id: ACTOR, actor_role: 'owner', action: 'agent_capabilities_update' },
      }),
    ]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    const rows = await pool.query(
      `SELECT granted_packs FROM agent_tool_grants WHERE tenant_id = $1 AND agent_id = $2`,
      [T, A],
    );
    expect(rows.rows.length).toBe(1);
    const packs: string[] = rows.rows[0]!.granted_packs;
    expect(packs).toContain('domain.finance');
    expect(packs).toContain('domain.support');

    const audits = await pool.query(
      `SELECT id FROM admin_audit_log WHERE tenant_id = $1`,
      [T],
    );
    expect(audits.rows.length).toBe(2);
  });
});
