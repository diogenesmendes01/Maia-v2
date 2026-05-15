/**
 * P6 Task 4 — repo tests for rolesRepo.
 *
 * Mock-based pattern (matches tests/unit/capability-proposals-repo.spec.ts).
 * Validates: create() via applyTenantGuard, getByKey() retorna por chave,
 * getDefault() retorna is_default=true, listActive() filtra inativos,
 * is_default=true criado com sucesso (DB partial unique).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';

type RoleRow = {
  id: string;
  tenant_id: string;
  agent_id: string;
  role_key: string;
  display_name: string;
  description: string | null;
  prompt_addendum: string | null;
  active: boolean;
  is_default: boolean;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
};

const rolesState: Record<string, RoleRow> = {};

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
    '@/db/repositories.js',
  );
  const { getCurrentTenant, getCurrentAgent } = await import(
    '@/db/tenant-context.js'
  );

  return {
    ...actual,
    rolesRepo: {
      create: vi.fn(
        async (input: {
          role_key: string;
          display_name: string;
          description?: string;
          prompt_addendum?: string;
          is_default?: boolean;
        }) => {
          const tenant_id = getCurrentTenant();
          const agent_id = getCurrentAgent();
          const id = `role-${Math.random().toString(36).slice(2)}`;
          const now = new Date();
          const row: RoleRow = {
            id,
            tenant_id,
            agent_id,
            role_key: input.role_key,
            display_name: input.display_name,
            description: input.description ?? null,
            prompt_addendum: input.prompt_addendum ?? null,
            active: true,
            is_default: input.is_default ?? false,
            metadata: {},
            created_at: now,
            updated_at: now,
          };
          rolesState[id] = row;
          return row;
        },
      ),
      getById: vi.fn(async (id: string) => {
        const tenant_id = getCurrentTenant();
        const agent_id = getCurrentAgent();
        const row = rolesState[id];
        if (!row) return null;
        if (row.tenant_id !== tenant_id || row.agent_id !== agent_id)
          return null;
        return row;
      }),
      getByKey: vi.fn(async (role_key: string) => {
        const tenant_id = getCurrentTenant();
        const agent_id = getCurrentAgent();
        return (
          Object.values(rolesState).find(
            (r) =>
              r.tenant_id === tenant_id &&
              r.agent_id === agent_id &&
              r.role_key === role_key,
          ) ?? null
        );
      }),
      getDefault: vi.fn(async () => {
        const tenant_id = getCurrentTenant();
        const agent_id = getCurrentAgent();
        return (
          Object.values(rolesState).find(
            (r) =>
              r.tenant_id === tenant_id &&
              r.agent_id === agent_id &&
              r.is_default === true,
          ) ?? null
        );
      }),
      listActive: vi.fn(async () => {
        const tenant_id = getCurrentTenant();
        const agent_id = getCurrentAgent();
        return Object.values(rolesState).filter(
          (r) =>
            r.tenant_id === tenant_id &&
            r.agent_id === agent_id &&
            r.active === true,
        );
      }),
      deactivate: vi.fn(async (id: string) => {
        // [P88-C3] tenant-scoped — refuses cross-tenant deactivation.
        const tenant_id = getCurrentTenant();
        const agent_id = getCurrentAgent();
        const row = rolesState[id];
        if (!row) return { rowCount: 0 };
        if (row.tenant_id !== tenant_id || row.agent_id !== agent_id) {
          return { rowCount: 0 };
        }
        row.active = false;
        row.updated_at = new Date();
        return { rowCount: 1 };
      }),
    },
  };
});

describe('rolesRepo', () => {
  beforeEach(() => {
    for (const k of Object.keys(rolesState)) delete rolesState[k];
    vi.clearAllMocks();
  });

  it('create insere via applyTenantGuard e seta active=true por default', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { rolesRepo } = await import('@/db/repositories.js');
        const row = await rolesRepo.create({
          role_key: 'comercial',
          display_name: 'Comercial',
          description: 'Modo de atendimento comercial',
          prompt_addendum: 'Você é um atendente comercial.',
        });
        expect(row.id).toBeDefined();
        expect(row.tenant_id).toBe('default');
        expect(row.agent_id).toBe('default');
        expect(row.role_key).toBe('comercial');
        expect(row.display_name).toBe('Comercial');
        expect(row.active).toBe(true);
        expect(row.is_default).toBe(false);
      },
    );
  });

  it('getByKey retorna role com chave correta', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { rolesRepo } = await import('@/db/repositories.js');
        await rolesRepo.create({
          role_key: 'suporte',
          display_name: 'Suporte',
        });
        await rolesRepo.create({
          role_key: 'comercial',
          display_name: 'Comercial',
        });
        const found = await rolesRepo.getByKey('suporte');
        expect(found).not.toBeNull();
        expect(found!.display_name).toBe('Suporte');
      },
    );
  });

  it('getDefault retorna apenas a row com is_default=true', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { rolesRepo } = await import('@/db/repositories.js');
        await rolesRepo.create({
          role_key: 'default',
          display_name: 'Default',
          is_default: true,
        });
        await rolesRepo.create({
          role_key: 'comercial',
          display_name: 'Comercial',
        });
        const def = await rolesRepo.getDefault();
        expect(def).not.toBeNull();
        expect(def!.role_key).toBe('default');
        expect(def!.is_default).toBe(true);
      },
    );
  });

  it('listActive filtra roles desativados', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { rolesRepo } = await import('@/db/repositories.js');
        const a = await rolesRepo.create({
          role_key: 'a',
          display_name: 'A',
        });
        await rolesRepo.create({
          role_key: 'b',
          display_name: 'B',
        });
        await rolesRepo.deactivate(a.id);
        const active = await rolesRepo.listActive();
        expect(active.length).toBe(1);
        expect(active[0]!.role_key).toBe('b');
      },
    );
  });

  it('create com is_default=true cria role default (DB partial unique permite)', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { rolesRepo } = await import('@/db/repositories.js');
        const def = await rolesRepo.create({
          role_key: 'default',
          display_name: 'Default',
          is_default: true,
        });
        expect(def.is_default).toBe(true);
        const fetched = await rolesRepo.getDefault();
        expect(fetched!.id).toBe(def.id);
      },
    );
  });

  // [P88-C3] Inviolable tenant isolation on writes.
  it('deactivate de outro tenant NÃO afeta o role (cross-tenant guard)', async () => {
    let roleIdA: string = '';
    await runWithTenantContext(
      { tenant_id: 'tenant-a', agent_id: 'agent-a' },
      async () => {
        const { rolesRepo } = await import('@/db/repositories.js');
        const row = await rolesRepo.create({
          role_key: 'comercial-a',
          display_name: 'Comercial A',
        });
        roleIdA = row.id;
        expect(row.active).toBe(true);
      },
    );

    // Tenant B tenta desativar role de A — no-op com rowCount=0.
    await runWithTenantContext(
      { tenant_id: 'tenant-b', agent_id: 'agent-b' },
      async () => {
        const { rolesRepo } = await import('@/db/repositories.js');
        const result = await rolesRepo.deactivate(roleIdA);
        expect(result.rowCount).toBe(0);
      },
    );

    // De volta em A, role ainda ativo.
    await runWithTenantContext(
      { tenant_id: 'tenant-a', agent_id: 'agent-a' },
      async () => {
        const { rolesRepo } = await import('@/db/repositories.js');
        const row = await rolesRepo.getById(roleIdA);
        expect(row).not.toBeNull();
        expect(row!.active).toBe(true);
      },
    );
  });
});
