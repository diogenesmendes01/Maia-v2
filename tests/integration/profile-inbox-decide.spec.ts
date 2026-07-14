/**
 * Spec perfil-inbox v4 §4 (integração) — decisão de perfil pelo MOTOR
 * UNIFICADO (`proposalsUnifiedRepo.decideAtomically` → primitivos InTx):
 *
 *   - aprovar via inbox ATIVA a proposta e CONGELA o incumbente na MESMA tx;
 *   - invariante 1b: falha de guard (predecessor_conflict) NÃO deixa estado
 *     parcial — approval e audit inseridos antes da transição são desfeitos
 *     pelo rollback, e o retry NÃO é bloqueado como duplicado;
 *   - reject ⇒ proposed → rolled_back (terminal);
 *   - dual high exige aprovadores DISTINTOS (1ª assinatura não transiciona);
 *   - invariante 5/§1.6: decisão sem escopo completo é rejeitada pelo CHECK
 *     de pareamento NULL no DB.
 *
 * Skipped without TEST_DB_URL (matches sibling profile concurrency specs).
 */
// A flag precisa estar no env ANTES do primeiro import de config/env.js
// (parse eager) — os repos são importados dinamicamente dentro dos testes.
process.env.FEATURE_PROFILE_INBOX_SOURCE = 'true';

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';

const SHOULD_RUN = !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T = 'profinbox-tenant';
const A = 'profinbox-agent';
const OWNER = 'profinbox-owner';
const FOUNDER = 'profinbox-founder';

let pool: pg.Pool;

async function reset(): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query(`DELETE FROM proposal_approvals WHERE tenant_id = $1`, [T]);
    await c.query(`DELETE FROM admin_audit_log WHERE tenant_id = $1`, [T]);
    await c.query(`DELETE FROM agent_operational_profile_versions WHERE tenant_id = $1`, [T]);
    await c.query(`DELETE FROM capability_proposals WHERE tenant_id = $1`, [T]);
  } finally {
    c.release();
  }
}

async function seedActiveV1(): Promise<string> {
  const c = await pool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO agent_operational_profile_versions
         (tenant_id, agent_id, version, status, profile_body, proposed_by, approved_at, activated_at)
       VALUES ($1, $2, 1, 'active', '{}'::jsonb, $3, now(), now())
       RETURNING id`,
      [T, A, OWNER],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

async function insertProposedV(version: number, previousId: string | null): Promise<string> {
  const c = await pool.connect();
  try {
    const body = { metadata: { previous_version_id: previousId } };
    const r = await c.query<{ id: string }>(
      `INSERT INTO agent_operational_profile_versions
         (tenant_id, agent_id, version, status, profile_body, proposed_by)
       VALUES ($1, $2, $3, 'proposed', $4::jsonb, $5)
       RETURNING id`,
      [T, A, version, JSON.stringify(body), OWNER],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

async function statusOf(id: string): Promise<string> {
  const c = await pool.connect();
  try {
    const r = await c.query<{ status: string }>(
      `SELECT status FROM agent_operational_profile_versions WHERE id = $1`,
      [id],
    );
    return r.rows[0]!.status;
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
        `INSERT INTO tenants(id, nome) VALUES ($1, 'Profile Inbox Tenant') ON CONFLICT (id) DO NOTHING`,
        [T],
      );
      await c.query(
        `INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, 'Profile Inbox Agent') ON CONFLICT (id) DO NOTHING`,
        [A, T],
      );
    } finally {
      c.release();
    }
  });

  afterAll(async () => {
    await reset();
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
    await reset();
  });
}

d('proposalsUnifiedRepo.decideAtomically — operational_profile (real DB)', () => {
  it('aprovar via inbox ativa a proposta e congela o incumbente na MESMA tx', async () => {
    const { proposalsUnifiedRepo } = await import('../../src/db/repositories.js');
    const v1 = await seedActiveV1();
    const v2 = await insertProposedV(2, v1);

    const result = await proposalsUnifiedRepo.decideAtomically({
      tenantId: T,
      proposalId: v2,
      type: 'operational_profile',
      approvalClass: 'operational_profile_change',
      actorId: OWNER,
      actorRole: 'owner',
      decision: 'approved',
      comment: 'aprovado via inbox',
      dualComplete: false,
      gateParams: { dualRequired: false, requiredRoles: ['owner'], allLocks: [] },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.sourceTransitioned).toBe(true);
    expect(result.finalStatus).toBe('activated');
    expect(await statusOf(v2)).toBe('active');
    expect(await statusOf(v1)).toBe('frozen');

    // Escopo completo gravado na approval (invariante 5).
    const c = await pool.connect();
    try {
      const r = await c.query(
        `SELECT agent_id, proposal_source FROM proposal_approvals
          WHERE tenant_id = $1 AND proposal_id = $2`,
        [T, v2],
      );
      expect(r.rows).toEqual([{ agent_id: A, proposal_source: 'operational_profile' }]);
    } finally {
      c.release();
    }
  });

  it('invariante 1b: predecessor_conflict via inbox NÃO grava approval nem audit; retry não é bloqueado', async () => {
    const { proposalsUnifiedRepo } = await import('../../src/db/repositories.js');
    const v1 = await seedActiveV1();
    // v2 aponta um predecessor que NÃO é o incumbente → guard dispara.
    const v2 = await insertProposedV(2, '00000000-0000-4000-8000-00000000dead');
    void v1;

    const attempt = await proposalsUnifiedRepo.decideAtomically({
      tenantId: T,
      proposalId: v2,
      type: 'operational_profile',
      approvalClass: 'operational_profile_change',
      actorId: OWNER,
      actorRole: 'owner',
      decision: 'approved',
      comment: 'primeira tentativa',
      dualComplete: false,
      gateParams: { dualRequired: false, requiredRoles: ['owner'], allLocks: [] },
    });
    expect(attempt).toMatchObject({
      ok: false,
      reason: 'profile_transition_failed',
      detail: { reason: 'predecessor_conflict' },
    });

    // Rollback TOTAL: nada em proposal_approvals nem em admin_audit_log.
    const c = await pool.connect();
    try {
      const approvals = await c.query(
        `SELECT COUNT(*)::int AS n FROM proposal_approvals WHERE tenant_id = $1 AND proposal_id = $2`,
        [T, v2],
      );
      expect(approvals.rows[0]!.n).toBe(0);
      const audits = await c.query(
        `SELECT COUNT(*)::int AS n FROM admin_audit_log
          WHERE tenant_id = $1 AND resource_id = $2`,
        [T, v2],
      );
      expect(audits.rows[0]!.n).toBe(0);
    } finally {
      c.release();
    }

    // Retry do MESMO operador: não pode ser bloqueado como already_approved.
    const retry = await proposalsUnifiedRepo.decideAtomically({
      tenantId: T,
      proposalId: v2,
      type: 'operational_profile',
      approvalClass: 'operational_profile_change',
      actorId: OWNER,
      actorRole: 'owner',
      decision: 'approved',
      comment: 'retry após refresh',
      dualComplete: false,
      gateParams: { dualRequired: false, requiredRoles: ['owner'], allLocks: [] },
    });
    expect(retry).toMatchObject({
      ok: false,
      reason: 'profile_transition_failed',
      detail: { reason: 'predecessor_conflict' },
    });
  });

  it('reject via inbox ⇒ proposed → rolled_back (terminal)', async () => {
    const { proposalsUnifiedRepo } = await import('../../src/db/repositories.js');
    const v1 = await seedActiveV1();
    const v2 = await insertProposedV(2, v1);

    const result = await proposalsUnifiedRepo.decideAtomically({
      tenantId: T,
      proposalId: v2,
      type: 'operational_profile',
      approvalClass: 'operational_profile_change',
      actorId: OWNER,
      actorRole: 'owner',
      decision: 'rejected',
      comment: 'rejeitado via inbox',
      dualComplete: true,
    });
    expect(result.ok).toBe(true);
    expect(await statusOf(v2)).toBe('rolled_back');
    expect(await statusOf(v1)).toBe('active');
  });

  it('dual high: 1ª assinatura NÃO transiciona; 2ª por papel distinto ativa (invariante 2)', async () => {
    const { proposalsUnifiedRepo } = await import('../../src/db/repositories.js');
    const v1 = await seedActiveV1();
    const v2 = await insertProposedV(2, v1);
    const gate = {
      dualRequired: true,
      requiredRoles: ['owner', 'founder'],
      allLocks: [] as string[],
    };

    const first = await proposalsUnifiedRepo.decideAtomically({
      tenantId: T,
      proposalId: v2,
      type: 'operational_profile',
      approvalClass: 'operational_profile_change_high',
      actorId: OWNER,
      actorRole: 'owner',
      decision: 'approved',
      comment: 'primeira assinatura',
      dualComplete: false,
      gateParams: gate,
    });
    expect(first).toMatchObject({ ok: true, sourceTransitioned: false, dualComplete: false });
    expect(await statusOf(v2)).toBe('proposed');

    // Mesmo papel de novo ⇒ bloqueado (aprovadores distintos).
    const sameRole = await proposalsUnifiedRepo.decideAtomically({
      tenantId: T,
      proposalId: v2,
      type: 'operational_profile',
      approvalClass: 'operational_profile_change_high',
      actorId: 'profinbox-owner-2',
      actorRole: 'owner',
      decision: 'approved',
      comment: 'mesmo papel',
      dualComplete: false,
      gateParams: gate,
    });
    expect(sameRole).toMatchObject({ ok: false, reason: 'already_approved_by_role' });

    const second = await proposalsUnifiedRepo.decideAtomically({
      tenantId: T,
      proposalId: v2,
      type: 'operational_profile',
      approvalClass: 'operational_profile_change_high',
      actorId: FOUNDER,
      actorRole: 'founder',
      decision: 'approved',
      comment: 'segunda assinatura',
      dualComplete: false,
      gateParams: gate,
    });
    expect(second).toMatchObject({ ok: true, sourceTransitioned: true, dualComplete: true });
    expect(await statusOf(v2)).toBe('active');
    expect(await statusOf(v1)).toBe('frozen');
  });

  it('§1.6: decisão com source e SEM agent_id é rejeitada pelo CHECK de pareamento', async () => {
    const v1 = await seedActiveV1();
    void v1;
    const c = await pool.connect();
    try {
      await expect(
        c.query(
          `INSERT INTO proposal_approvals
             (tenant_id, proposal_source, proposal_id, approval_class, approver_user_id, approver_role, decision)
           VALUES ($1, 'operational_profile', gen_random_uuid(), 'operational_profile_change', $2, 'owner', 'approved')`,
          [T, OWNER],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      c.release();
    }
  });

  it('list: sources INTERCALAM por recência e o cursor composto pagina até o fim (review #496 médio 8)', async () => {
    const { proposalsUnifiedRepo } = await import('../../src/db/repositories.js');
    const c = await pool.connect();
    try {
      // Timeline (desc): cap-3 > prof-2 > cap-2 > prof-1 > cap-1. Antes do
      // fix, capabilities entravam primeiro no array: com limit=2 a página 1
      // seria [cap-3, cap-2] e NENHUM perfil apareceria enquanto houvesse
      // >= limit capabilities pendentes (e o cursor era ignorado — página 2
      // repetia a 1).
      const at = (min: number) => `now() - interval '${min} minutes'`;
      const cap = async (title: string, minAgo: number) => {
        await c.query(
          `INSERT INTO capability_proposals
             (tenant_id, agent_id, capability_type, title, description, motivation, status, created_at)
           VALUES ($1, $2, 'skill', $3, 'd', 'm', 'submitted', ${at(minAgo)})`,
          [T, A, title],
        );
      };
      const prof = async (version: number, minAgo: number) => {
        await c.query(
          `INSERT INTO agent_operational_profile_versions
             (tenant_id, agent_id, version, status, profile_body, proposed_by, created_at)
           VALUES ($1, $2, $3, 'proposed', '{"metadata":{"previous_version_id":null}}'::jsonb, $4, ${at(minAgo)})`,
          [T, A, version, OWNER],
        );
      };
      await cap('cap-1', 50);
      await prof(1, 40);
      await cap('cap-2', 30);
      await prof(2, 20);
      await cap('cap-3', 10);

      const page1 = await proposalsUnifiedRepo.list({ tenantId: T, limit: 2 });
      expect(page1.items.map((i) => i.type)).toEqual([
        'capability_proposal',
        'operational_profile',
      ]);
      expect(page1.items[0]!.descriptor).toBe('cap-3');
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await proposalsUnifiedRepo.list({
        tenantId: T,
        limit: 2,
        cursor: page1.nextCursor,
      });
      expect(page2.items.map((i) => i.descriptor)).toEqual([
        'cap-2',
        expect.stringContaining('Perfil operacional v1'),
      ]);
      expect(page2.hasMore).toBe(true);

      const page3 = await proposalsUnifiedRepo.list({
        tenantId: T,
        limit: 2,
        cursor: page2.nextCursor,
      });
      expect(page3.items.map((i) => i.descriptor)).toEqual(['cap-1']);
      expect(page3.hasMore).toBe(false);
      expect(page3.nextCursor).toBeNull();

      // Nenhum item repetido/perdido entre páginas.
      const all = [...page1.items, ...page2.items, ...page3.items].map((i) => i.id);
      expect(new Set(all).size).toBe(5);

      // Cursor ilegível ⇒ primeira página (nunca lança).
      const garbage = await proposalsUnifiedRepo.list({
        tenantId: T,
        limit: 2,
        cursor: '###not-base64###',
      });
      expect(garbage.items).toHaveLength(2);
    } finally {
      c.release();
    }
  });
});
