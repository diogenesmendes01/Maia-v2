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

function makeRepos(seed: Tenant[] = []) {
  const tenants: Record<string, Tenant> = {};
  for (const t of seed) tenants[t.id] = { ...t };
  const audit: AuditRow[] = [];

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
      async updateStatus(id: string, status: string) {
        const row = tenants[id];
        if (!row) return null;
        row.status = status;
        row.updated_at = new Date();
        return { ...row };
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
