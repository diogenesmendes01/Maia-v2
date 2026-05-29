/**
 * Admin UI Setup — tenantsRouter unit tests.
 *
 * Drives the router through tRPC's caller with an in-memory repo. Verifies:
 *   1. list/create/updateStatus require role=founder (founderProcedure gate).
 *   2. Non-founder roles get FORBIDDEN, even with a valid session.
 *   3. create with a duplicate id returns CONFLICT.
 *   4. updateStatus appends a row to admin_audit_log with from/to status.
 *   5. updateStatus on a missing tenant returns NOT_FOUND.
 *   6. updateStatus to the same status is rejected with BAD_REQUEST.
 *   7. getById refuses to read another tenant for non-founder roles.
 *   8. updateStatus is atomic — if the audit insert throws inside the
 *      tx-aware repo method, the tenant status MUST NOT persist (issue #165).
 *   9. create is atomic — if the audit insert throws inside the tx-aware
 *      repo method, the tenant row MUST NOT persist, and a retry succeeds
 *      WITHOUT hitting CONFLICT (issue #184).
 */
import { describe, it, expect } from 'vitest';
import { TRPCError } from '@trpc/server';
import { tenantsRouter } from '@/admin-ui/trpc/routers/tenants.js';

type Tenant = {
  id: string;
  nome: string;
  status: string;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
};

type AuditRow = {
  tenant_id: string;
  actor_id: string;
  actor_role: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  change_summary: Record<string, unknown> | null;
};

/**
 * Build an in-memory repo surface that mirrors the tx-aware DB semantics.
 *
 * `opts.failAuditOnce`: throw the FIRST time `updateStatusAtomic` reaches the
 * audit-insert step, then succeed on retry. Models the real failure mode that
 * issue #165 fixes (audit insert error mid-tx) — the mock simulates rollback
 * by snapshotting state pre-mutation and restoring it on throw, matching
 * Postgres BEGIN/ROLLBACK semantics.
 *
 * `opts.failCreateAuditOnce`: throw the FIRST time `createWithAuditAtomic`
 * reaches the audit-insert step, then succeed on retry. Models the real
 * failure mode that issue #184 fixes (audit insert error mid-tx, leaving an
 * orphaned tenant row that retry can't recover from due to PK CONFLICT).
 */
function makeRepos(
  seed: Tenant[] = [],
  opts: { failAuditOnce?: boolean; failCreateAuditOnce?: boolean } = {},
) {
  const tenants: Record<string, Tenant> = {};
  for (const t of seed) tenants[t.id] = { ...t };
  const audit: AuditRow[] = [];
  let auditShouldFail = opts.failAuditOnce ?? false;
  let createAuditShouldFail = opts.failCreateAuditOnce ?? false;

  return {
    tenantsRepo: {
      // Clone on read so callers cannot accidentally observe an in-place mutation
      // performed by a later updateStatus call (matches DB semantics).
      async findById(id: string) {
        return tenants[id] ? { ...tenants[id]! } : null;
      },
      async list() {
        return Object.values(tenants)
          .map((t) => ({ ...t }))
          .sort((a, b) => a.id.localeCompare(b.id));
      },
      // DEPRECATED for the router path; kept so test setup (and any non-router
      // caller) can seed tenants without dragging an audit fixture along.
      async create(input: { id: string; nome: string; status?: string }) {
        const row: Tenant = {
          id: input.id,
          nome: input.nome,
          status: input.status ?? 'active',
          metadata: {},
          created_at: new Date(),
          updated_at: new Date(),
        };
        tenants[input.id] = row;
        return { ...row };
      },
      // Atomic create + audit. Mock emulates `withTx` rollback: if the audit
      // step throws, the tenant row inserted earlier is removed. Mirrors the
      // real-DB invariant tested in #184.
      async createWithAuditAtomic(input: {
        tenant: { id: string; nome: string; status?: string };
        audit: { tenant_id: string; actor_id: string; actor_role: string };
      }) {
        // (1) Duplicate-id check — the real method relies on the PRIMARY KEY
        //     constraint to surface 23505, which we translate to a typed
        //     reason. Mirror that in the mock so the router sees the same
        //     contract on conflict.
        if (tenants[input.tenant.id]) {
          return { ok: false as const, reason: 'duplicate_id' as const };
        }

        // (2) Tentatively insert the tenant row (would be INSERT ... RETURNING
        //     in DB). Snapshot is implicit — the row didn't exist before.
        const created: Tenant = {
          id: input.tenant.id,
          nome: input.tenant.nome,
          status: input.tenant.status ?? 'active',
          metadata: {},
          created_at: new Date(),
          updated_at: new Date(),
        };
        tenants[input.tenant.id] = created;

        // (3) Audit step — may throw to model a mid-tx audit insert failure.
        try {
          if (createAuditShouldFail) {
            createAuditShouldFail = false;
            throw new Error('simulated create audit insert failure');
          }
          audit.push({
            tenant_id: input.audit.tenant_id,
            actor_id: input.audit.actor_id,
            actor_role: input.audit.actor_role,
            action: 'tenant_create',
            resource_type: 'tenant',
            resource_id: created.id,
            change_summary: {
              target_tenant_id: created.id,
              nome: created.nome,
              status: created.status,
            },
          });
        } catch (err) {
          // ROLLBACK: undo the INSERT. This is the invariant the test asserts —
          // if audit throws, the tenant row DOES NOT persist (mirrors withTx).
          delete tenants[input.tenant.id];
          throw err;
        }

        return { ok: true as const, tenant: { ...created } };
      },
      // Kept for any direct caller; the router uses updateStatusAtomic below.
      async updateStatus(id: string, status: string) {
        const row = tenants[id];
        if (!row) return null;
        row.status = status;
        row.updated_at = new Date();
        return { ...row };
      },
      // Mirrors the real tx-aware repo path (issue #165):
      //   1. Lock + re-read tenant.
      //   2. Re-check status inside the "tx".
      //   3. Flip status.
      //   4. Audit. If this throws, restore the pre-flip snapshot (Postgres
      //      ROLLBACK equivalent) so the test can verify the status DIDN'T
      //      persist on retry.
      async updateStatusAtomic(input: {
        id: string;
        status: string;
        audit: {
          tenant_id: string;
          actor_id: string;
          actor_role: string;
          comment: string;
        };
      }) {
        const before = tenants[input.id];
        if (!before) return { ok: false as const, reason: 'not_found' as const };
        if (before.status === input.status) {
          return { ok: false as const, reason: 'already_in_status' as const };
        }

        // Snapshot for rollback simulation.
        const snapshot: Tenant = { ...before };

        // Tentatively apply the mutation (would be UPDATE ... RETURNING in DB).
        const after: Tenant = {
          ...before,
          status: input.status,
          updated_at: new Date(),
        };
        tenants[input.id] = after;

        // Audit step — may throw to model a mid-tx audit insert failure.
        try {
          if (auditShouldFail) {
            auditShouldFail = false;
            throw new Error('simulated audit insert failure');
          }
          audit.push({
            tenant_id: input.audit.tenant_id,
            actor_id: input.audit.actor_id,
            actor_role: input.audit.actor_role,
            action: 'tenant_update_status',
            resource_type: 'tenant',
            resource_id: after.id,
            change_summary: {
              target_tenant_id: after.id,
              from_status: before.status,
              to_status: after.status,
              reason: input.audit.comment,
            },
          });
        } catch (err) {
          // ROLLBACK: restore pre-mutation snapshot, then re-throw so the
          // router sees the failure (mirrors withTx behavior).
          tenants[input.id] = snapshot;
          throw err;
        }

        return {
          ok: true as const,
          before: { ...snapshot },
          after: { ...after },
        };
      },
    },
    adminAuditLogRepo: {
      async append(entry: AuditRow) {
        audit.push(entry);
        return { ...entry, id: audit.length, created_at: new Date() } as AuditRow & {
          id: number;
          created_at: Date;
        };
      },
    },
    _inspect: { tenants, audit },
  };
}

function caller(role: string, tenantId: string, userId: string, repos: ReturnType<typeof makeRepos>) {
  const ctx = {
    session: { user: { id: userId, role, tenant_id: tenantId } },
    userId,
    userRole: role,
    tenantId,
    repos: repos as unknown as typeof import('@/db/repositories.js'),
    assertTenant: () => {},
    assertRole: () => {},
  };
  return tenantsRouter.createCaller(ctx);
}

describe('tenantsRouter.list — founder gate', () => {
  it('founder can list', async () => {
    const repos = makeRepos([
      {
        id: 'tenant-a',
        nome: 'A',
        status: 'active',
        metadata: {},
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);
    const res = await caller('founder', 'tenant-a', 'u1', repos).list();
    expect(res.items.length).toBe(1);
  });

  it.each(['owner', 'compliance_officer', 'analyst', 'viewer'])(
    '%s gets FORBIDDEN',
    async (role) => {
      const repos = makeRepos();
      await expect(caller(role, 'tenant-a', 'u1', repos).list()).rejects.toThrow(
        TRPCError,
      );
    },
  );
});

describe('tenantsRouter.create — founder gate + audit', () => {
  it('founder creates tenant and audits', async () => {
    const repos = makeRepos();
    const res = await caller('founder', 'home-tenant', 'founder-1', repos).create({
      id: 'tenant-new',
      nome: 'New Tenant',
    });
    expect(res.id).toBe('tenant-new');
    expect(repos._inspect.tenants['tenant-new']).toBeDefined();
    expect(repos._inspect.audit.length).toBe(1);
    expect(repos._inspect.audit[0]!.action).toBe('tenant_create');
    expect(repos._inspect.audit[0]!.tenant_id).toBe('home-tenant');
    expect(repos._inspect.audit[0]!.change_summary?.target_tenant_id).toBe(
      'tenant-new',
    );
  });

  it.each(['owner', 'compliance_officer', 'analyst', 'viewer'])(
    '%s cannot create',
    async (role) => {
      const repos = makeRepos();
      await expect(
        caller(role, 'tenant-a', 'u1', repos).create({
          id: 'tenant-x',
          nome: 'X',
        }),
      ).rejects.toThrow(TRPCError);
    },
  );

  it('duplicate id returns CONFLICT', async () => {
    const repos = makeRepos([
      {
        id: 'dup',
        nome: 'D',
        status: 'active',
        metadata: {},
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);
    await expect(
      caller('founder', 'home', 'f1', repos).create({ id: 'dup', nome: 'X' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects malformed id (uppercase)', async () => {
    const repos = makeRepos();
    await expect(
      caller('founder', 'home', 'f1', repos).create({ id: 'BAD', nome: 'X' }),
    ).rejects.toThrow();
  });

  // Issue #184 — Codex Adversarial Review on PR #180.
  //
  // Pre-fix: the router called `tenantsRepo.create` followed by a separate
  // `adminAuditLogRepo.append`. If the audit insert failed in the window
  // between them, the tenant row was already committed but no audit record
  // existed. Retry then hit a duplicate-primary-key CONFLICT
  // ("Tenant 'x' already exists") and the forensic row was lost forever —
  // violating the append-only mutation-trail invariant for admin_audit_log
  // on tenant provisioning.
  //
  // Post-fix: `tenantsRepo.createWithAuditAtomic` wraps the tenant insert
  // and audit insert in one tx. If the audit step throws, the tenant INSERT
  // rolls back and no tenant row exists. A subsequent retry succeeds
  // normally — both rows commit together with no CONFLICT.
  it('audit insert failure rolls back the tenant insert (atomic, issue #184)', async () => {
    const repos = makeRepos([], { failCreateAuditOnce: true });

    // First attempt — audit insert throws; the router surfaces it as an
    // INTERNAL_SERVER_ERROR (or whatever tRPC wraps the raw Error into).
    await expect(
      caller('founder', 'home', 'f1', repos).create({
        id: 'tenant-new',
        nome: 'New Tenant',
      }),
    ).rejects.toThrow(/simulated create audit insert failure/);

    // CRITICAL invariant: the tenant row MUST NOT exist. Pre-fix, it would
    // have been committed with no audit row, blocking any retry on CONFLICT.
    expect(repos._inspect.tenants['tenant-new']).toBeUndefined();
    expect(repos._inspect.audit.length).toBe(0);

    // Retry: now the audit step succeeds; both rows commit atomically.
    // No CONFLICT because the rolled-back insert left no orphaned tenant row.
    const res = await caller('founder', 'home', 'f1', repos).create({
      id: 'tenant-new',
      nome: 'New Tenant',
    });
    expect(res.id).toBe('tenant-new');
    expect(repos._inspect.tenants['tenant-new']).toBeDefined();
    expect(repos._inspect.audit.length).toBe(1);
    expect(repos._inspect.audit[0]!.action).toBe('tenant_create');
    expect(repos._inspect.audit[0]!.change_summary?.target_tenant_id).toBe(
      'tenant-new',
    );
  });
});

describe('tenantsRouter.updateStatus — gate + audit + invariants', () => {
  const seed: Tenant = {
    id: 'tenant-a',
    nome: 'A',
    status: 'active',
    metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
  };

  it('founder suspends, audits with from/to', async () => {
    const repos = makeRepos([seed]);
    const res = await caller('founder', 'home', 'f1', repos).updateStatus({
      id: 'tenant-a',
      status: 'suspended',
      comment: 'suspending for billing',
    });
    expect(res.status).toBe('suspended');
    const audit = repos._inspect.audit[0]!;
    expect(audit.action).toBe('tenant_update_status');
    expect(audit.change_summary?.from_status).toBe('active');
    expect(audit.change_summary?.to_status).toBe('suspended');
  });

  it.each(['owner', 'compliance_officer', 'analyst', 'viewer'])(
    '%s cannot updateStatus',
    async (role) => {
      const repos = makeRepos([seed]);
      await expect(
        caller(role, 'tenant-a', 'u1', repos).updateStatus({
          id: 'tenant-a',
          status: 'suspended',
          comment: 'trying anyway',
        }),
      ).rejects.toThrow(TRPCError);
    },
  );

  it('NOT_FOUND when tenant missing', async () => {
    const repos = makeRepos();
    await expect(
      caller('founder', 'home', 'f1', repos).updateStatus({
        id: 'ghost',
        status: 'suspended',
        comment: 'no such tenant',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('BAD_REQUEST when status is already the target', async () => {
    const repos = makeRepos([seed]);
    await expect(
      caller('founder', 'home', 'f1', repos).updateStatus({
        id: 'tenant-a',
        status: 'active',
        comment: 'already active',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  // Issue #165 — Codex Adversarial Review round 3 on PR #163.
  //
  // Pre-fix: the router called `tenantsRepo.updateStatus` followed by a
  // separate `adminAuditLogRepo.append`. If the audit insert failed in the
  // window between them, the tenant was already suspended/reactivated but
  // no audit record existed. Retry hit the "Tenant is already X" BAD_REQUEST
  // branch and the forensic row was lost forever — violating the append-only
  // mutation-trail invariant for admin_audit_log.
  //
  // Post-fix: `tenantsRepo.updateStatusAtomic` wraps update + audit insert in
  // one tx. If the audit step throws, the UPDATE rolls back and the tenant
  // status stays at its original value. A subsequent retry succeeds normally
  // and the audit row IS written.
  it('audit insert failure rolls back the status change (atomic, issue #165)', async () => {
    const repos = makeRepos([seed], { failAuditOnce: true });

    // First attempt — audit insert throws; the router surfaces it as an
    // INTERNAL_SERVER_ERROR (or whatever tRPC wraps the raw Error into).
    await expect(
      caller('founder', 'home', 'f1', repos).updateStatus({
        id: 'tenant-a',
        status: 'suspended',
        comment: 'first attempt — audit fails mid-tx',
      }),
    ).rejects.toThrow(/simulated audit insert failure/);

    // CRITICAL invariant: the tenant status MUST still be 'active'. Pre-fix,
    // it would have been 'suspended' with no audit row.
    expect(repos._inspect.tenants['tenant-a']!.status).toBe('active');
    expect(repos._inspect.audit.length).toBe(0);

    // Retry: now the audit step succeeds; both rows commit atomically.
    const res = await caller('founder', 'home', 'f1', repos).updateStatus({
      id: 'tenant-a',
      status: 'suspended',
      comment: 'retry after rollback',
    });
    expect(res.status).toBe('suspended');
    expect(repos._inspect.tenants['tenant-a']!.status).toBe('suspended');
    expect(repos._inspect.audit.length).toBe(1);
    expect(repos._inspect.audit[0]!.change_summary?.from_status).toBe('active');
    expect(repos._inspect.audit[0]!.change_summary?.to_status).toBe('suspended');
    expect(repos._inspect.audit[0]!.change_summary?.reason).toBe(
      'retry after rollback',
    );
  });
});

describe('protectedProcedure — tenant suspension enforcement', () => {
  // Verifies the fix for the Codex review #162 [high] finding: when a founder
  // suspends a tenant via tenants.updateStatus, NON-founder sessions must stop
  // working immediately. We exercise this through tenantsRouter.getById since
  // it's protectedProcedure (not founder-only) and we already have the right
  // mock surface here.
  const suspended: Tenant = {
    id: 'tenant-suspended',
    nome: 'Suspended Co',
    status: 'suspended',
    metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
  };

  it('owner of a suspended tenant gets FORBIDDEN on every protected call', async () => {
    const repos = makeRepos([suspended]);
    await expect(
      caller('owner', 'tenant-suspended', 'u1', repos).getById({
        id: 'tenant-suspended',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('founder of a suspended tenant CAN still call protected routes (recovery)', async () => {
    const repos = makeRepos([suspended]);
    // Founders bypass the suspension check so they can reactivate the tenant.
    const result = await caller('founder', 'tenant-suspended', 'f1', repos).getById({
      id: 'tenant-suspended',
    });
    expect(result.id).toBe('tenant-suspended');
  });
});

describe('tenantsRouter.getById — tenant isolation for non-founders', () => {
  it('owner can read their own tenant', async () => {
    const seed: Tenant = {
      id: 'tenant-a',
      nome: 'A',
      status: 'active',
      metadata: {},
      created_at: new Date(),
      updated_at: new Date(),
    };
    const repos = makeRepos([seed]);
    const res = await caller('owner', 'tenant-a', 'u1', repos).getById({
      id: 'tenant-a',
    });
    expect(res.id).toBe('tenant-a');
  });

  it('owner FORBIDDEN on another tenant', async () => {
    const repos = makeRepos([
      {
        id: 'tenant-b',
        nome: 'B',
        status: 'active',
        metadata: {},
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);
    await expect(
      caller('owner', 'tenant-a', 'u1', repos).getById({ id: 'tenant-b' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('founder can read any tenant', async () => {
    const repos = makeRepos([
      {
        id: 'tenant-b',
        nome: 'B',
        status: 'active',
        metadata: {},
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);
    const res = await caller('founder', 'home', 'f1', repos).getById({
      id: 'tenant-b',
    });
    expect(res.id).toBe('tenant-b');
  });
});
