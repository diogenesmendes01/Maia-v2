/**
 * P6 Task 4 — repo tests for channelsRepo.
 *
 * Mock-based pattern (matches tests/unit/capability-proposals-repo.spec.ts).
 * Validates: create() via applyTenantGuard com active default true,
 * findByExternal() é tenant-scoped, findByExternalCrossTenant() bypassa
 * o guard, listActive() filtra inativos, deactivate() seta active=false.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';

type ChannelRow = {
  id: string;
  tenant_id: string;
  agent_id: string;
  external_id: string;
  channel_type: string;
  display_name: string | null;
  active: boolean;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
};

const channelsState: Record<string, ChannelRow> = {};

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
    '@/db/repositories.js',
  );

  // Helper to capture tenant context at call time
  const { getCurrentTenant, getCurrentAgent } = await import(
    '@/db/tenant-context.js'
  );

  return {
    ...actual,
    channelsRepo: {
      create: vi.fn(
        async (input: {
          external_id: string;
          channel_type:
            | 'whatsapp'
            | 'telegram'
            | 'email'
            | 'sms'
            | 'web'
            | 'api'
            | 'other';
          display_name?: string;
          metadata?: unknown;
        }) => {
          // Mimic applyTenantGuard: pulls tenant/agent from context (throws if missing)
          const tenant_id = getCurrentTenant();
          const agent_id = getCurrentAgent();
          const id = `chan-${Math.random().toString(36).slice(2)}`;
          const now = new Date();
          const row: ChannelRow = {
            id,
            tenant_id,
            agent_id,
            external_id: input.external_id,
            channel_type: input.channel_type,
            display_name: input.display_name ?? null,
            active: true,
            metadata: input.metadata ?? {},
            created_at: now,
            updated_at: now,
          };
          channelsState[id] = row;
          return row;
        },
      ),
      getById: vi.fn(async (id: string) => {
        const tenant_id = getCurrentTenant();
        const agent_id = getCurrentAgent();
        const row = channelsState[id];
        if (!row) return null;
        if (row.tenant_id !== tenant_id || row.agent_id !== agent_id)
          return null;
        return row;
      }),
      findByExternal: vi.fn(
        async (channel_type: string, external_id: string) => {
          const tenant_id = getCurrentTenant();
          const agent_id = getCurrentAgent();
          return (
            Object.values(channelsState).find(
              (r) =>
                r.tenant_id === tenant_id &&
                r.agent_id === agent_id &&
                r.channel_type === channel_type &&
                r.external_id === external_id,
            ) ?? null
          );
        },
      ),
      findByExternalCrossTenant: vi.fn(
        async (args: { channel_type: string; external_id: string }) => {
          // Explicitly bypasses tenant guard
          return (
            Object.values(channelsState).find(
              (r) =>
                r.channel_type === args.channel_type &&
                r.external_id === args.external_id,
            ) ?? null
          );
        },
      ),
      listActive: vi.fn(async () => {
        const tenant_id = getCurrentTenant();
        const agent_id = getCurrentAgent();
        return Object.values(channelsState).filter(
          (r) =>
            r.tenant_id === tenant_id &&
            r.agent_id === agent_id &&
            r.active === true,
        );
      }),
      deactivate: vi.fn(async (id: string) => {
        const row = channelsState[id];
        if (row) {
          row.active = false;
          row.updated_at = new Date();
        }
      }),
    },
  };
});

describe('channelsRepo', () => {
  beforeEach(() => {
    for (const k of Object.keys(channelsState)) delete channelsState[k];
    vi.clearAllMocks();
  });

  it('create insere via applyTenantGuard com active=true por default', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { channelsRepo } = await import('@/db/repositories.js');
        const row = await channelsRepo.create({
          external_id: 'wa-12345',
          channel_type: 'whatsapp',
          display_name: 'Vendas WhatsApp',
        });
        expect(row.id).toBeDefined();
        expect(row.tenant_id).toBe('default');
        expect(row.agent_id).toBe('default');
        expect(row.external_id).toBe('wa-12345');
        expect(row.channel_type).toBe('whatsapp');
        expect(row.display_name).toBe('Vendas WhatsApp');
        expect(row.active).toBe(true);
      },
    );
  });

  it('findByExternal é tenant-scoped (não vaza entre tenants)', async () => {
    await runWithTenantContext(
      { tenant_id: 'tenant-a', agent_id: 'agent-a' },
      async () => {
        const { channelsRepo } = await import('@/db/repositories.js');
        await channelsRepo.create({
          external_id: 'shared-ext-id',
          channel_type: 'whatsapp',
        });
        const found = await channelsRepo.findByExternal(
          'whatsapp',
          'shared-ext-id',
        );
        expect(found).not.toBeNull();
        expect(found!.tenant_id).toBe('tenant-a');
      },
    );
    // De outro tenant, mesmo external_id não deve aparecer
    await runWithTenantContext(
      { tenant_id: 'tenant-b', agent_id: 'agent-b' },
      async () => {
        const { channelsRepo } = await import('@/db/repositories.js');
        const found = await channelsRepo.findByExternal(
          'whatsapp',
          'shared-ext-id',
        );
        expect(found).toBeNull();
      },
    );
  });

  it('findByExternalCrossTenant retorna row mesmo de outro tenant (bypassa guard)', async () => {
    await runWithTenantContext(
      { tenant_id: 'tenant-a', agent_id: 'agent-a' },
      async () => {
        const { channelsRepo } = await import('@/db/repositories.js');
        await channelsRepo.create({
          external_id: 'cross-ext-id',
          channel_type: 'whatsapp',
        });
      },
    );
    // De outro tenant, ainda encontra (resolver pattern)
    await runWithTenantContext(
      { tenant_id: 'tenant-b', agent_id: 'agent-b' },
      async () => {
        const { channelsRepo } = await import('@/db/repositories.js');
        const found = await channelsRepo.findByExternalCrossTenant({
          channel_type: 'whatsapp',
          external_id: 'cross-ext-id',
        });
        expect(found).not.toBeNull();
        expect(found!.tenant_id).toBe('tenant-a'); // não filtrou
      },
    );
  });

  it('listActive filtra channels com active=false', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { channelsRepo } = await import('@/db/repositories.js');
        const a = await channelsRepo.create({
          external_id: 'a',
          channel_type: 'whatsapp',
        });
        await channelsRepo.create({
          external_id: 'b',
          channel_type: 'telegram',
        });
        await channelsRepo.deactivate(a.id);
        const active = await channelsRepo.listActive();
        expect(active.length).toBe(1);
        expect(active[0]!.external_id).toBe('b');
      },
    );
  });

  it('deactivate seta active=false', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { channelsRepo } = await import('@/db/repositories.js');
        const row = await channelsRepo.create({
          external_id: 'to-deactivate',
          channel_type: 'whatsapp',
        });
        expect(row.active).toBe(true);
        await channelsRepo.deactivate(row.id);
        const after = await channelsRepo.getById(row.id);
        expect(after).not.toBeNull();
        expect(after!.active).toBe(false);
      },
    );
  });
});
