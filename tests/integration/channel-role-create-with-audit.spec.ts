/**
 * PR #491 review (high) — channelsRepo.createWithAudit / rolesRepo.createWithAudit.
 *
 * The router used to persist the channel/role first and append the
 * admin_audit_log row afterwards, OUTSIDE the transaction: an audit-insert
 * failure would leave a governance change with no trail ("audit every
 * decision" violated). The atomic helpers wrap both writes in one tx —
 * this spec exercises them against a live Postgres:
 *
 *   1. Happy path: channel/role row AND its audit row land together.
 *   2. Duplicate: typed `{ ok: false, reason: 'duplicate' }` (not a raw pg
 *      error), and NO audit row is left behind (the tx rolled back).
 *   3. Role default resolution happens inside the tx: first active role
 *      becomes the default; the second one does not.
 *
 * Skipped without TEST_DB_URL (matches issue-184-agents-create-race.spec.ts).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T = 'pr491-tenant';
const A = 'pr491-agent';
const ACTOR = 'pr491-actor';

let pool: pg.Pool;

async function wipe(): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query(`DELETE FROM admin_audit_log WHERE tenant_id = $1`, [T]);
    await c.query(`DELETE FROM channel_policies WHERE tenant_id = $1`, [T]);
    await c.query(`DELETE FROM channels WHERE tenant_id = $1`, [T]);
    await c.query(`DELETE FROM roles WHERE tenant_id = $1`, [T]);
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
        `INSERT INTO tenants(id, nome) VALUES ($1, 'PR 491 Tenant') ON CONFLICT (id) DO NOTHING`,
        [T],
      );
      await c.query(
        `INSERT INTO agents(id, tenant_id, nome, status) VALUES ($1, $2, 'PR 491 Agent', 'active') ON CONFLICT (id) DO NOTHING`,
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

d('channelsRepo.createWithAudit (real DB)', () => {
  it('creates the channel and its audit row atomically (whatsapp nasce DECLARADO/inativo)', async () => {
    const { channelsRepo } = await import('../../src/db/repositories.js');

    // Spec roteamento v4 §1.5/§2: linha whatsapp é E.164 com '+' e o canal
    // novo nasce INATIVO ('declarado') — ativação só via pareamento.
    const result = await channelsRepo.createWithAudit({
      tenant_id: T,
      agent_id: A,
      channel: {
        channel_type: 'whatsapp',
        external_id: '+5511900014911',
        display_name: 'Linha 1',
      },
      audit: { actor_id: ACTOR, actor_role: 'owner', reason: 'integration happy path' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.channel.external_id).toBe('+5511900014911');
    expect(result.channel.active).toBe(false);
    const audit = await pool.query(
      `SELECT action, resource_type, resource_id FROM admin_audit_log WHERE tenant_id = $1`,
      [T],
    );
    expect(audit.rows).toEqual([
      { action: 'channel_create', resource_type: 'channel', resource_id: result.channel.id },
    ]);
  });

  it('whatsapp com external_id que não é linha E.164 → typed invalid_line, nada persiste', async () => {
    const { channelsRepo } = await import('../../src/db/repositories.js');

    const result = await channelsRepo.createWithAudit({
      tenant_id: T,
      agent_id: A,
      channel: { channel_type: 'whatsapp', external_id: 'pr491-line-1' },
      audit: { actor_id: ACTOR, actor_role: 'owner', reason: 'invalid line' },
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_line' });

    const [channels, audit] = await Promise.all([
      pool.query(`SELECT id FROM channels WHERE tenant_id = $1`, [T]),
      pool.query(`SELECT id FROM admin_audit_log WHERE tenant_id = $1`, [T]),
    ]);
    expect(channels.rows.length).toBe(0);
    expect(audit.rows.length).toBe(0);
  });

  it('duplicate (channel_type, external_id) → typed duplicate, tx rolled back, no audit row', async () => {
    const { channelsRepo } = await import('../../src/db/repositories.js');

    const args = {
      tenant_id: T,
      agent_id: A,
      channel: { channel_type: 'whatsapp' as const, external_id: '+5511900014912' },
      audit: { actor_id: ACTOR, actor_role: 'owner', reason: 'integration duplicate' },
    };
    const first = await channelsRepo.createWithAudit(args);
    expect(first.ok).toBe(true);

    const second = await channelsRepo.createWithAudit(args);
    expect(second).toEqual({ ok: false, reason: 'duplicate' });

    const [channels, audit] = await Promise.all([
      pool.query(`SELECT id FROM channels WHERE tenant_id = $1`, [T]),
      pool.query(`SELECT id FROM admin_audit_log WHERE tenant_id = $1`, [T]),
    ]);
    expect(channels.rows.length).toBe(1);
    expect(audit.rows.length).toBe(1);
  });
});

d('rolesRepo.createWithAudit (real DB)', () => {
  it('first role becomes default, second does not; both audited', async () => {
    const { rolesRepo } = await import('../../src/db/repositories.js');

    const first = await rolesRepo.createWithAudit({
      tenant_id: T,
      agent_id: A,
      role: { role_key: 'comercial', display_name: 'Comercial' },
      audit: { actor_id: ACTOR, actor_role: 'owner', reason: 'first role default' },
    });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.role.is_default).toBe(true);

    const second = await rolesRepo.createWithAudit({
      tenant_id: T,
      agent_id: A,
      role: { role_key: 'suporte', display_name: 'Suporte' },
      audit: { actor_id: ACTOR, actor_role: 'owner', reason: 'second role not default' },
    });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.role.is_default).toBe(false);

    const audit = await pool.query(
      `SELECT action FROM admin_audit_log WHERE tenant_id = $1 ORDER BY id`,
      [T],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['role_create', 'role_create']);
  });

  it('duplicate role_key → typed duplicate, no orphan audit row', async () => {
    const { rolesRepo } = await import('../../src/db/repositories.js');

    const args = {
      tenant_id: T,
      agent_id: A,
      role: { role_key: 'comercial', display_name: 'Comercial' },
      audit: { actor_id: ACTOR, actor_role: 'owner', reason: 'duplicate role key' },
    };
    const first = await rolesRepo.createWithAudit(args);
    expect(first.ok).toBe(true);

    const second = await rolesRepo.createWithAudit(args);
    expect(second).toEqual({ ok: false, reason: 'duplicate' });

    const [roles, audit] = await Promise.all([
      pool.query(`SELECT id FROM roles WHERE tenant_id = $1`, [T]),
      pool.query(`SELECT id FROM admin_audit_log WHERE tenant_id = $1`, [T]),
    ]);
    expect(roles.rows.length).toBe(1);
    expect(audit.rows.length).toBe(1);
  });
});
