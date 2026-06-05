/**
 * Issue #407 — agent_audience_profiles tenant/agent leak suite + the per-agent
 * phone-uniqueness contract.
 *
 * Proves:
 *  1. Raw-SQL: a (tenant, agent)-scoped query never returns another
 *     (tenant, agent)'s audience profile (invariant #1).
 *  2. The relaxed composite unique lets the SAME phone exist for two agents
 *     with DISTINCT audience roles (the core #407 capability), while the
 *     composite unique still rejects a duplicate within ONE (tenant, agent).
 *  3. agentAudienceProfilesRepo.findByPessoa / list are scoped via the ALS
 *     context (a profile from another agent is invisible).
 *
 * Skipped without TEST_DB_URL so unit-only CI lanes pass without Postgres.
 * Cleanup: each test runs inside a transaction it ROLLBACKs (raw-SQL block),
 * or tracks + deletes its ids in finally (repo block, which uses the global
 * pool and cannot see uncommitted rows).
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

/**
 * Ensure a (tenant_id, agent_id) pair exists so FK references resolve. The
 * 'default' tenant + agent are seeded by migration 007/009; for non-default
 * pairs we insert idempotently.
 */
async function ensureTenantAgent(c: pg.PoolClient, tenant: string, agent: string): Promise<void> {
  // tenants.nome and agents.nome are NOT NULL — insert them (matches the other
  // integration specs, e.g. issue-298 / issue-316). No fragile .catch() fallback:
  // inside a BEGIN block a swallowed insert error still ABORTS the transaction
  // (Postgres 25P02), which then cascades every following query in the test to
  // fail. The agents insert previously omitted `nome` → CI failure.
  await c.query(`INSERT INTO tenants(id, nome) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`, [
    tenant,
  ]);
  await c.query(
    `INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING`,
    [agent, tenant],
  );
}

async function mkPessoaRow(
  c: pg.PoolClient,
  args: { tenant: string; agent: string; phone: string; tipo?: string },
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
     VALUES ($1, $2, 'X', $3, $4, 'ativa') RETURNING id`,
    [args.tenant, args.agent, args.phone, args.tipo ?? 'cliente'],
  );
  return r.rows[0]!.id;
}

async function mkProfileRow(
  c: pg.PoolClient,
  args: {
    tenant: string;
    agent: string;
    pessoa_id: string;
    audience_type: string;
    trust_level?: string;
  },
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `INSERT INTO agent_audience_profiles
       (tenant_id, agent_id, pessoa_id, audience_type, trust_level, status)
     VALUES ($1, $2, $3, $4, $5, 'active') RETURNING id`,
    [args.tenant, args.agent, args.pessoa_id, args.audience_type, args.trust_level ?? 'unverified'],
  );
  return r.rows[0]!.id;
}

dRaw('agent_audience_profiles — raw SQL leak + uniqueness (#407)', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('scoped query never returns another (tenant, agent) profile', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await ensureTenantAgent(c, 'tA', 'agA');
      await ensureTenantAgent(c, 'tB', 'agB');
      const pA = await mkPessoaRow(c, { tenant: 'tA', agent: 'agA', phone: '+5511900000001' });
      const pB = await mkPessoaRow(c, { tenant: 'tB', agent: 'agB', phone: '+5511900000002' });
      await mkProfileRow(c, { tenant: 'tA', agent: 'agA', pessoa_id: pA, audience_type: 'owner' });
      await mkProfileRow(c, {
        tenant: 'tB',
        agent: 'agB',
        pessoa_id: pB,
        audience_type: 'customer',
      });

      const r = await c.query<{ audience_type: string }>(
        `SELECT audience_type FROM agent_audience_profiles WHERE tenant_id = $1 AND agent_id = $2`,
        ['tA', 'agA'],
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]!.audience_type).toBe('owner');
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('SAME phone exists for two agents with DISTINCT audience roles', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await ensureTenantAgent(c, 'tA', 'agX');
      await ensureTenantAgent(c, 'tA', 'agY');
      const phone = '+5511900000099';
      // Same phone, two agents — only possible because migration 074 relaxed
      // the global unique to (tenant_id, agent_id, telefone_whatsapp).
      const pX = await mkPessoaRow(c, { tenant: 'tA', agent: 'agX', phone, tipo: 'cliente' });
      const pY = await mkPessoaRow(c, { tenant: 'tA', agent: 'agY', phone, tipo: 'funcionario' });
      await mkProfileRow(c, {
        tenant: 'tA',
        agent: 'agX',
        pessoa_id: pX,
        audience_type: 'customer',
      });
      await mkProfileRow(c, {
        tenant: 'tA',
        agent: 'agY',
        pessoa_id: pY,
        audience_type: 'employee',
      });

      const x = await c.query<{ audience_type: string }>(
        `SELECT audience_type FROM agent_audience_profiles WHERE tenant_id='tA' AND agent_id='agX'`,
      );
      const y = await c.query<{ audience_type: string }>(
        `SELECT audience_type FROM agent_audience_profiles WHERE tenant_id='tA' AND agent_id='agY'`,
      );
      expect(x.rows[0]!.audience_type).toBe('customer');
      expect(y.rows[0]!.audience_type).toBe('employee');
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('composite unique rejects a duplicate phone within ONE (tenant, agent)', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await ensureTenantAgent(c, 'tA', 'agZ');
      const phone = '+5511900000123';
      await mkPessoaRow(c, { tenant: 'tA', agent: 'agZ', phone });
      await expect(mkPessoaRow(c, { tenant: 'tA', agent: 'agZ', phone })).rejects.toThrow();
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('1:1 unique rejects a second profile for the same (tenant, agent, pessoa)', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await ensureTenantAgent(c, 'tA', 'agW');
      const p = await mkPessoaRow(c, { tenant: 'tA', agent: 'agW', phone: '+5511900000222' });
      await mkProfileRow(c, { tenant: 'tA', agent: 'agW', pessoa_id: p, audience_type: 'owner' });
      await expect(
        mkProfileRow(c, { tenant: 'tA', agent: 'agW', pessoa_id: p, audience_type: 'manager' }),
      ).rejects.toThrow();
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});

dRepo('agentAudienceProfilesRepo — ALS-scoped reads (#407)', () => {
  beforeAll(async () => {
    pool = pool ?? new pg.Pool({ connectionString: process.env.TEST_DB_URL });
  });
  afterAll(async () => {
    // pool closed by the raw-SQL afterAll when both run; guard double-close.
    await pool.end().catch(() => undefined);
  });

  it('findByPessoa returns only the current agent profile (other agent invisible)', async () => {
    const c = await pool.connect();
    const created: { pessoas: string[]; profiles: string[] } = { pessoas: [], profiles: [] };
    try {
      await ensureTenantAgent(c, 'default', 'agentR1');
      await ensureTenantAgent(c, 'default', 'agentR2');
      const p1 = await mkPessoaRow(c, {
        tenant: 'default',
        agent: 'agentR1',
        phone: '+5511900777001',
      });
      const p2 = await mkPessoaRow(c, {
        tenant: 'default',
        agent: 'agentR2',
        phone: '+5511900777001',
      });
      created.pessoas.push(p1, p2);
      const a1 = await mkProfileRow(c, {
        tenant: 'default',
        agent: 'agentR1',
        pessoa_id: p1,
        audience_type: 'owner',
      });
      const a2 = await mkProfileRow(c, {
        tenant: 'default',
        agent: 'agentR2',
        pessoa_id: p2,
        audience_type: 'customer',
      });
      created.profiles.push(a1, a2);

      const { agentAudienceProfilesRepo } = await loadRepos();

      const fromR1 = await runWithTenantContext(
        { tenant_id: 'default', agent_id: 'agentR1' },
        () => agentAudienceProfilesRepo.findByPessoa(p1),
      );
      expect(fromR1?.audience_type).toBe('owner');

      // Agent R1 must NOT see agent R2's pessoa/profile.
      const crossAgent = await runWithTenantContext(
        { tenant_id: 'default', agent_id: 'agentR1' },
        () => agentAudienceProfilesRepo.findByPessoa(p2),
      );
      expect(crossAgent).toBeNull();
    } finally {
      // FK-safe order: profiles (child of pessoas via ON DELETE CASCADE, but
      // delete explicitly anyway), then pessoas.
      if (created.profiles.length)
        await c
          .query(`DELETE FROM agent_audience_profiles WHERE id = ANY($1)`, [created.profiles])
          .catch(() => undefined);
      if (created.pessoas.length)
        await c
          .query(`DELETE FROM pessoas WHERE id = ANY($1)`, [created.pessoas])
          .catch(() => undefined);
      c.release();
    }
  });

  it('list returns only the current agent profiles (cross-agent invisible) (#7)', async () => {
    const c = await pool.connect();
    const created: { pessoas: string[]; profiles: string[] } = { pessoas: [], profiles: [] };
    try {
      await ensureTenantAgent(c, 'default', 'agentL1');
      await ensureTenantAgent(c, 'default', 'agentL2');
      const p1 = await mkPessoaRow(c, { tenant: 'default', agent: 'agentL1', phone: '+5511900888101' });
      const p2 = await mkPessoaRow(c, { tenant: 'default', agent: 'agentL2', phone: '+5511900888102' });
      created.pessoas.push(p1, p2);
      const a1 = await mkProfileRow(c, {
        tenant: 'default',
        agent: 'agentL1',
        pessoa_id: p1,
        audience_type: 'owner',
      });
      const a2 = await mkProfileRow(c, {
        tenant: 'default',
        agent: 'agentL2',
        pessoa_id: p2,
        audience_type: 'customer',
      });
      created.profiles.push(a1, a2);

      const { agentAudienceProfilesRepo } = await loadRepos();
      const fromL1 = await runWithTenantContext(
        { tenant_id: 'default', agent_id: 'agentL1' },
        () => agentAudienceProfilesRepo.list(),
      );
      // Every returned row is the current agent's; the other agent's is invisible.
      expect(fromL1.every((p) => p.agent_id === 'agentL1' && p.tenant_id === 'default')).toBe(true);
      const ids = fromL1.map((p) => p.id);
      expect(ids).toContain(a1);
      expect(ids).not.toContain(a2);
    } finally {
      if (created.profiles.length)
        await c
          .query(`DELETE FROM agent_audience_profiles WHERE id = ANY($1)`, [created.profiles])
          .catch(() => undefined);
      if (created.pessoas.length)
        await c
          .query(`DELETE FROM pessoas WHERE id = ANY($1)`, [created.pessoas])
          .catch(() => undefined);
      c.release();
    }
  });

  it('resolveIdentity carries the per-agent audience and fails closed without a profile (#7)', async () => {
    const c = await pool.connect();
    const created: { pessoas: string[]; profiles: string[] } = { pessoas: [], profiles: [] };
    try {
      await ensureTenantAgent(c, 'default', 'agentRI');
      const withProfile = await mkPessoaRow(c, {
        tenant: 'default',
        agent: 'agentRI',
        phone: '+5511900888201',
      });
      const noProfile = await mkPessoaRow(c, {
        tenant: 'default',
        agent: 'agentRI',
        phone: '+5511900888202',
      });
      created.pessoas.push(withProfile, noProfile);
      created.profiles.push(
        await mkProfileRow(c, {
          tenant: 'default',
          agent: 'agentRI',
          pessoa_id: withProfile,
          audience_type: 'employee',
          trust_level: 'trusted_internal',
        }),
      );

      const { resolveIdentity } = await import('../../src/identity/resolver.js');

      const resolved = await runWithTenantContext(
        { tenant_id: 'default', agent_id: 'agentRI' },
        () => resolveIdentity({ telefone_whatsapp: '+5511900888201' }),
      );
      expect(resolved.kind).toBe('resolved');
      if (resolved.kind === 'resolved') {
        expect(resolved.audience.audience_type).toBe('employee');
        expect(resolved.audience.trust_level).toBe('trusted_internal');
        expect(resolved.audience.agent_id).toBe('agentRI');
      }

      // Known pessoa, NO active audience profile → fail-closed quarantine.
      const blocked = await runWithTenantContext(
        { tenant_id: 'default', agent_id: 'agentRI' },
        () => resolveIdentity({ telefone_whatsapp: '+5511900888202' }),
      );
      expect(blocked.kind).toBe('quarantined');
    } finally {
      // resolveIdentity creates a conversa + audit rows — clean those too.
      if (created.pessoas.length) {
        await c
          .query(`DELETE FROM conversas WHERE pessoa_id = ANY($1)`, [created.pessoas])
          .catch(() => undefined);
        await c
          .query(`DELETE FROM audit_log WHERE pessoa_id = ANY($1)`, [created.pessoas])
          .catch(() => undefined);
      }
      if (created.profiles.length)
        await c
          .query(`DELETE FROM agent_audience_profiles WHERE id = ANY($1)`, [created.profiles])
          .catch(() => undefined);
      if (created.pessoas.length)
        await c
          .query(`DELETE FROM pessoas WHERE id = ANY($1)`, [created.pessoas])
          .catch(() => undefined);
      c.release();
    }
  });
});
