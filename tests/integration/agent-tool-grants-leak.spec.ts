/**
 * Issue #408 — agent_tool_grants tenant/agent leak suite + the per-agent
 * grant-uniqueness contract + the default grant at agent creation.
 *
 * Proves:
 *  1. Raw-SQL: a (tenant, agent)-scoped query never returns another
 *     (tenant, agent)'s grant (invariant #1).
 *  2. The (tenant, agent) unique rejects a second grant for the same agent.
 *  3. agentToolGrantsRepo.findForCurrentAgent is scoped via the ALS context
 *     (another agent's grant is invisible).
 *  4. createWithSeedAndAudit persists the DEFAULT ['baseline.core'] grant in the
 *     same tx as the agent (no agent without a grant).
 *
 * Skipped without TEST_DB_URL so unit-only CI lanes pass without Postgres.
 * Cleanup: raw-SQL block ROLLBACKs; repo block tracks + deletes ids in finally.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { runWithTenantContext } from '@/db/tenant-context.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const dRaw = process.env.TEST_DB_URL ? describe : describe.skip;
const dRepo = SHOULD_RUN ? describe : describe.skip;

let pool: pg.Pool;

async function loadRepos(): Promise<typeof import('../../src/db/repositories.js')> {
  return await import('../../src/db/repositories.js');
}

async function ensureTenantAgent(c: pg.PoolClient, tenant: string, agent: string): Promise<void> {
  // tenants.nome and agents.nome are NOT NULL — insert them (matches the other
  // integration specs). No .catch() fallback: inside a BEGIN block a swallowed
  // insert error still ABORTS the transaction (Postgres 25P02) and cascades.
  await c.query(`INSERT INTO tenants(id, nome) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`, [
    tenant,
  ]);
  await c.query(
    `INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING`,
    [agent, tenant],
  );
}

async function mkGrant(
  c: pg.PoolClient,
  args: { tenant: string; agent: string; packs?: string[]; tools?: string[]; denied?: string[] },
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `INSERT INTO agent_tool_grants (tenant_id, agent_id, granted_packs, granted_tools, denied_tools)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      args.tenant,
      args.agent,
      args.packs ?? ['baseline.core'],
      args.tools ?? [],
      args.denied ?? [],
    ],
  );
  return r.rows[0]!.id;
}

dRaw('agent_tool_grants — raw SQL leak + uniqueness (#408)', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('scoped query never returns another (tenant, agent) grant', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await ensureTenantAgent(c, 'tA', 'agA');
      await ensureTenantAgent(c, 'tB', 'agB');
      await mkGrant(c, { tenant: 'tA', agent: 'agA', packs: ['baseline.core', 'domain.finance'] });
      await mkGrant(c, { tenant: 'tB', agent: 'agB', packs: ['baseline.core'] });

      const r = await c.query<{ granted_packs: string[] }>(
        `SELECT granted_packs FROM agent_tool_grants WHERE tenant_id = $1 AND agent_id = $2`,
        ['tA', 'agA'],
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]!.granted_packs).toContain('domain.finance');
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('the (tenant, agent) unique rejects a second grant for the same agent', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await ensureTenantAgent(c, 'tA', 'agZ');
      await mkGrant(c, { tenant: 'tA', agent: 'agZ' });
      await expect(mkGrant(c, { tenant: 'tA', agent: 'agZ' })).rejects.toThrow();
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});

dRepo('agentToolGrantsRepo — ALS-scoped reads + default grant (#408)', () => {
  beforeAll(async () => {
    // Own pool. The dRaw block's afterAll already called pool.end(), so reusing
    // it (`pool ?? …`) would hand back an ENDED pool and every connect() throws.
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
  });
  afterAll(async () => {
    await pool.end().catch(() => undefined);
  });

  it('findForCurrentAgent returns only the current agent grant (other invisible)', async () => {
    const c = await pool.connect();
    const created: string[] = [];
    try {
      await ensureTenantAgent(c, 'primary', 'agentG1');
      await ensureTenantAgent(c, 'primary', 'agentG2');
      created.push(await mkGrant(c, { tenant: 'primary', agent: 'agentG1', packs: ['baseline.core', 'domain.finance'] }));
      created.push(await mkGrant(c, { tenant: 'primary', agent: 'agentG2', packs: ['baseline.core'] }));

      const { agentToolGrantsRepo } = await loadRepos();
      const fromG1 = await runWithTenantContext(
        { tenant_id: 'primary', agent_id: 'agentG1' },
        () => agentToolGrantsRepo.findForCurrentAgent(),
      );
      expect(fromG1?.granted_packs).toContain('domain.finance');
      expect(fromG1?.agent_id).toBe('agentG1');
    } finally {
      if (created.length)
        await c
          .query(`DELETE FROM agent_tool_grants WHERE id = ANY($1)`, [created])
          .catch(() => undefined);
      c.release();
    }
  });

  it('createWithSeedAndAudit persists the default baseline.core grant in-tx', async () => {
    const c = await pool.connect();
    const agentId = `agent-grant-create-${Date.now()}`;
    try {
      const { agentsRepo, agentToolGrantsRepo } = await loadRepos();
      const res = await runWithTenantContext({ tenant_id: 'primary', agent_id: 'primary' }, () =>
        agentsRepo.createWithSeedAndAudit({
          agent: { id: agentId, tenant_id: 'primary', nome: 'Grant Test Agent' },
          seed_profile: {
            profile_body: {
              identity: { role: 'assistant', mission: 'test', tone: 'neutral' },
              capabilities: [],
              boundaries: [],
              escalation_rules: [],
            } as unknown as Parameters<typeof agentsRepo.createWithSeedAndAudit>[0]['seed_profile']['profile_body'],
            proposed_by: 'system',
            proposed_reason: 'grant test',
          },
          audit: { actor_id: 'tester', actor_role: 'owner' },
        }),
      );
      expect(res.ok).toBe(true);

      // The grant row must exist for the new agent, with baseline.core.
      const grant = await runWithTenantContext(
        { tenant_id: 'primary', agent_id: agentId },
        () => agentToolGrantsRepo.findForCurrentAgent(),
      );
      expect(grant).not.toBeNull();
      expect(grant!.granted_packs).toEqual(['baseline.core']);
    } finally {
      await c.query(`DELETE FROM agent_tool_grants WHERE agent_id = $1`, [agentId]).catch(() => undefined);
      await c
        .query(`DELETE FROM agent_operational_profile_versions WHERE agent_id = $1`, [agentId])
        .catch(() => undefined);
      await c.query(`DELETE FROM admin_audit_log WHERE resource_id = $1`, [agentId]).catch(() => undefined);
      await c.query(`DELETE FROM agents WHERE id = $1`, [agentId]).catch(() => undefined);
      c.release();
    }
  });
});
