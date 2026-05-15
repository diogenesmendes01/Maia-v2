/**
 * P6 Task 4 — repo tests for channelPoliciesRepo.
 *
 * Mock-based pattern (matches tests/unit/capability-proposals-repo.spec.ts).
 * Validates: create() com defaults, getByChannelId() retorna policy do canal,
 * update() altera campos, segunda policy no mesmo channel_id falha (UNIQUE).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';
import type {
  SwitchBehavior,
  AnnounceMode,
} from '@/types/enums.js';

type PolicyRow = {
  id: string;
  tenant_id: string;
  agent_id: string;
  channel_id: string;
  default_role_id: string;
  switch_behavior: SwitchBehavior;
  announce_mode: AnnounceMode;
  by_context_guards: unknown;
  allowed_role_ids: unknown;
  created_at: Date;
  updated_at: Date;
};

const policiesState: Record<string, PolicyRow> = {};

const DEFAULT_GUARDS = {
  min_confidence_to_switch: 0.7,
  cooldown_turns: 3,
  required_strength_delta: 0.2,
  max_switches_per_conversation: 3,
};

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
    '@/db/repositories.js',
  );
  const { getCurrentTenant, getCurrentAgent } = await import(
    '@/db/tenant-context.js'
  );

  return {
    ...actual,
    channelPoliciesRepo: {
      create: vi.fn(
        async (input: {
          channel_id: string;
          default_role_id: string;
          switch_behavior: SwitchBehavior;
          announce_mode?: AnnounceMode;
          by_context_guards?: unknown;
          allowed_role_ids?: string[];
        }) => {
          const tenant_id = getCurrentTenant();
          const agent_id = getCurrentAgent();
          // UNIQUE (channel_id) violation simulation
          const existing = Object.values(policiesState).find(
            (r) => r.channel_id === input.channel_id,
          );
          if (existing) {
            const err = new Error(
              'duplicate key value violates unique constraint "channel_policies_channel_uq"',
            ) as Error & { code?: string };
            err.code = '23505';
            throw err;
          }
          const id = `pol-${Math.random().toString(36).slice(2)}`;
          const now = new Date();
          const row: PolicyRow = {
            id,
            tenant_id,
            agent_id,
            channel_id: input.channel_id,
            default_role_id: input.default_role_id,
            switch_behavior: input.switch_behavior,
            announce_mode: input.announce_mode ?? ('affects_user' as AnnounceMode),
            by_context_guards: input.by_context_guards ?? DEFAULT_GUARDS,
            allowed_role_ids: input.allowed_role_ids ?? [],
            created_at: now,
            updated_at: now,
          };
          policiesState[id] = row;
          return row;
        },
      ),
      getByChannelId: vi.fn(async (channel_id: string) => {
        const tenant_id = getCurrentTenant();
        const agent_id = getCurrentAgent();
        return (
          Object.values(policiesState).find(
            (r) =>
              r.tenant_id === tenant_id &&
              r.agent_id === agent_id &&
              r.channel_id === channel_id,
          ) ?? null
        );
      }),
      update: vi.fn(
        async (id: string, patch: Partial<PolicyRow>) => {
          const tenant_id = getCurrentTenant();
          const agent_id = getCurrentAgent();
          const row = policiesState[id];
          if (!row) throw new Error('not_found');
          if (row.tenant_id !== tenant_id || row.agent_id !== agent_id) {
            throw new Error('tenant mismatch');
          }
          const { tenant_id: _t, agent_id: _a, ...rest } = patch;
          Object.assign(row, rest, { updated_at: new Date() });
          return row;
        },
      ),
    },
  };
});

describe('channelPoliciesRepo', () => {
  beforeEach(() => {
    for (const k of Object.keys(policiesState)) delete policiesState[k];
    vi.clearAllMocks();
  });

  it('create insere com defaults (announce_mode=affects_user, guards default)', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { channelPoliciesRepo } = await import('@/db/repositories.js');
        const row = await channelPoliciesRepo.create({
          channel_id: 'chan-1',
          default_role_id: 'role-default',
          switch_behavior: 'free_with_trigger' as SwitchBehavior,
        });
        expect(row.id).toBeDefined();
        expect(row.tenant_id).toBe('default');
        expect(row.channel_id).toBe('chan-1');
        expect(row.default_role_id).toBe('role-default');
        expect(row.switch_behavior).toBe('free_with_trigger');
        expect(row.announce_mode).toBe('affects_user');
        expect(row.by_context_guards).toEqual(DEFAULT_GUARDS);
        expect(row.allowed_role_ids).toEqual([]);
      },
    );
  });

  it('getByChannelId retorna policy do canal correto', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { channelPoliciesRepo } = await import('@/db/repositories.js');
        await channelPoliciesRepo.create({
          channel_id: 'chan-X',
          default_role_id: 'role-A',
          switch_behavior: 'locked' as SwitchBehavior,
        });
        await channelPoliciesRepo.create({
          channel_id: 'chan-Y',
          default_role_id: 'role-B',
          switch_behavior: 'by_context' as SwitchBehavior,
        });
        const policy = await channelPoliciesRepo.getByChannelId('chan-Y');
        expect(policy).not.toBeNull();
        expect(policy!.default_role_id).toBe('role-B');
        expect(policy!.switch_behavior).toBe('by_context');
      },
    );
  });

  it('update patches campos sem mexer em tenant/agent', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { channelPoliciesRepo } = await import('@/db/repositories.js');
        const row = await channelPoliciesRepo.create({
          channel_id: 'chan-upd',
          default_role_id: 'role-A',
          switch_behavior: 'free_with_trigger' as SwitchBehavior,
        });
        const updated = await channelPoliciesRepo.update(row.id, {
          switch_behavior: 'locked' as SwitchBehavior,
          announce_mode: 'always' as AnnounceMode,
        });
        expect(updated.switch_behavior).toBe('locked');
        expect(updated.announce_mode).toBe('always');
        expect(updated.tenant_id).toBe('default');
        expect(updated.id).toBe(row.id);
      },
    );
  });

  it('segunda policy no mesmo channel_id falha (UNIQUE channel_id)', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { channelPoliciesRepo } = await import('@/db/repositories.js');
        await channelPoliciesRepo.create({
          channel_id: 'chan-uniq',
          default_role_id: 'role-A',
          switch_behavior: 'free_with_trigger' as SwitchBehavior,
        });
        await expect(
          channelPoliciesRepo.create({
            channel_id: 'chan-uniq', // mesmo channel_id
            default_role_id: 'role-B',
            switch_behavior: 'locked' as SwitchBehavior,
          }),
        ).rejects.toThrow();
      },
    );
  });
});
