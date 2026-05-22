/**
 * Admin UI Setup — llmSettingsRouter unit tests.
 *
 * Storage history:
 *   PR #183 originally stored model picks in `agent_facts` scoped by
 *   (tenant_id, agent_id='default'). PR #188 Codex round 1 [high] showed
 *   that silently meant the founder UI only affected the founder's
 *   `default` agent — every other agent and every other tenant kept
 *   using the env model. The fix moved storage to `global_settings`
 *   (process-wide singleton; see migration 062), so we no longer mock
 *   agent_facts here. Atomic before/after under SELECT FOR UPDATE is
 *   exercised in tests/integration/global-settings-repo.spec.ts.
 *
 * Mocks in this file:
 *   - getCurrentMainModel / getCurrentFastModel (return seeded values).
 *   - setGlobalLLMSettingsAtomic (records the call shape and returns a
 *     fake before/after / no_changes / throws on demand).
 *   - getToolCallingModels (canned 2-item catalog).
 *
 * Verifies (router-layer concerns):
 *   1. get/catalog/update require role=founder (founderProcedure gate).
 *   2. Non-founder roles get FORBIDDEN.
 *   3. update with both sides unchanged returns BAD_REQUEST (no audit row).
 *   4. update forwards comment + actor metadata into setGlobalLLMSettingsAtomic.
 *   5. update maps a thrown error from the atomic helper through to tRPC
 *      (the actual rollback semantics live in the repo integration test).
 *   6. update fills null `before.main/fast` slots with env defaults so the
 *      UI doesn't need a second round-trip.
 *   7. Input validation: invalid slug characters / oversized comment.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

let mockMain = 'anthropic/claude-sonnet-4.6';
let mockFast = 'anthropic/claude-haiku-4.5';

type AtomicCall = {
  main: string;
  fast: string;
  updated_by: string;
  actor_role: string;
  tenant_id: string;
  comment: string;
};
const atomicCalls: AtomicCall[] = [];
let atomicMode: 'flip' | 'no_changes' | 'throw' = 'flip';
let atomicThrow: Error = new Error('simulated atomic failure');

vi.mock('@/lib/llm-settings.js', () => ({
  getCurrentMainModel: vi.fn(async () => mockMain),
  getCurrentFastModel: vi.fn(async () => mockFast),
  envDefaults: vi.fn(() => ({
    main: 'anthropic/claude-sonnet-4.6',
    fast: 'anthropic/claude-haiku-4.5',
    provider: 'openrouter',
  })),
  setGlobalLLMSettingsAtomic: vi.fn(async (input: AtomicCall) => {
    atomicCalls.push(input);
    if (atomicMode === 'throw') {
      throw atomicThrow;
    }
    if (atomicMode === 'no_changes') {
      return {
        ok: false as const,
        reason: 'no_changes' as const,
        before: { main: mockMain, fast: mockFast },
      };
    }
    const before = { main: mockMain, fast: mockFast };
    mockMain = input.main;
    mockFast = input.fast;
    return {
      ok: true as const,
      applied_at: new Date('2026-05-22T14:30:00Z'),
      before,
      after: { main: input.main, fast: input.fast },
    };
  }),
}));

vi.mock('@/lib/openrouter-models.js', () => ({
  getToolCallingModels: vi.fn(async () => [
    {
      id: 'anthropic/claude-sonnet-4.6',
      name: 'Anthropic: Claude Sonnet 4.6',
      context_length: 200000,
      pricing: { prompt_per_million: 3, completion_per_million: 15 },
      supports_tools: true,
    },
    {
      id: 'openai/gpt-5',
      name: 'OpenAI: GPT-5',
      context_length: 200000,
      pricing: { prompt_per_million: 5, completion_per_million: 15 },
      supports_tools: true,
    },
  ]),
}));

// Import the router after mocks are in place.
const { llmSettingsRouter } = await import(
  '@/admin-ui/trpc/routers/llmSettings.js'
);

function caller(role: string, tenantId = 'tenant-test', userId = 'user-1') {
  const ctx = {
    session: { user: { id: userId, role, tenant_id: tenantId } },
    userId,
    userRole: role,
    tenantId,
    repos: {
      tenantsRepo: {
        findById: async (_id: string) => ({
          id: tenantId,
          status: 'active',
          nome: 'test',
          metadata: {},
          created_at: new Date(),
          updated_at: new Date(),
        }),
      },
    } as unknown as typeof import('@/db/repositories.js'),
    assertTenant: () => {},
    assertRole: () => {},
  };
  return llmSettingsRouter.createCaller(ctx);
}

beforeEach(() => {
  atomicCalls.length = 0;
  atomicMode = 'flip';
  mockMain = 'anthropic/claude-sonnet-4.6';
  mockFast = 'anthropic/claude-haiku-4.5';
});

describe('llmSettingsRouter.get — founder gate', () => {
  it('founder can read current settings + env defaults (no tenant context wrap)', async () => {
    const res = await caller('founder').get();
    expect(res.main).toBe('anthropic/claude-sonnet-4.6');
    expect(res.fast).toBe('anthropic/claude-haiku-4.5');
    expect(res.env.provider).toBe('openrouter');
  });

  it.each(['owner', 'compliance_officer', 'analyst', 'viewer'])(
    '%s gets FORBIDDEN on get',
    async (role) => {
      await expect(caller(role).get()).rejects.toThrow(TRPCError);
    },
  );
});

describe('llmSettingsRouter.catalog — founder gate', () => {
  it('founder can fetch the model catalog', async () => {
    const res = await caller('founder').catalog();
    expect(res.items.length).toBe(2);
    expect(res.items[0]!.id).toBe('anthropic/claude-sonnet-4.6');
  });

  it.each(['owner', 'compliance_officer', 'analyst', 'viewer'])(
    '%s gets FORBIDDEN on catalog',
    async (role) => {
      await expect(caller(role).catalog()).rejects.toThrow(TRPCError);
    },
  );
});

describe('llmSettingsRouter.update — gate + delegate + atomic semantics', () => {
  it('founder flips both sides; atomic helper receives actor metadata + comment', async () => {
    const res = await caller('founder', 'tenant-x', 'founder-1').update({
      main: 'openai/gpt-5',
      fast: 'openai/gpt-5',
      comment: 'Anthropic outage 14:30 UTC, swap to OpenAI',
    });
    expect(res.ok).toBe(true);
    expect(res.applied_at).toBeInstanceOf(Date);
    expect(res.before).toEqual({
      main: 'anthropic/claude-sonnet-4.6',
      fast: 'anthropic/claude-haiku-4.5',
    });
    expect(res.after).toEqual({
      main: 'openai/gpt-5',
      fast: 'openai/gpt-5',
    });

    expect(atomicCalls).toHaveLength(1);
    expect(atomicCalls[0]).toMatchObject({
      main: 'openai/gpt-5',
      fast: 'openai/gpt-5',
      comment: 'Anthropic outage 14:30 UTC, swap to OpenAI',
      updated_by: 'founder-1',
      actor_role: 'founder',
      tenant_id: 'tenant-x',
    });
  });

  it.each(['owner', 'compliance_officer', 'analyst', 'viewer'])(
    '%s cannot update (FORBIDDEN)',
    async (role) => {
      await expect(
        caller(role).update({
          main: 'openai/gpt-5',
          fast: 'openai/gpt-5',
          comment: 'trying to bypass the founder gate',
        }),
      ).rejects.toThrow(TRPCError);
      // No atomic helper call — gate rejected before any tx.
      expect(atomicCalls).toHaveLength(0);
    },
  );

  it('BAD_REQUEST when atomic helper reports no_changes', async () => {
    atomicMode = 'no_changes';
    await expect(
      caller('founder').update({
        main: 'anthropic/claude-sonnet-4.6',
        fast: 'anthropic/claude-haiku-4.5',
        comment: 'this should be rejected — nothing actually changed',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(atomicCalls).toHaveLength(1); // helper WAS called; it returned no_changes
  });

  // The actual rollback semantics live in tests/integration/global-settings-repo.spec.ts
  // (real Postgres + concurrent founder regression). At the router layer we
  // just need to confirm that a thrown error propagates instead of being
  // swallowed into a misleading success — the legacy bug class was a
  // committed model change with no audit row.
  it('propagates an atomic helper failure (no fake success on the wire)', async () => {
    atomicMode = 'throw';
    atomicThrow = new Error('simulated audit insert failure');

    await expect(
      caller('founder').update({
        main: 'openai/gpt-5',
        fast: 'x-ai/grok-4.1-fast',
        comment: 'audit will fail on this attempt',
      }),
    ).rejects.toThrow(/simulated audit insert failure/);
  });

  it('null `before.main/fast` from the helper is filled with env defaults', async () => {
    // Simulate first-ever update where no global_settings rows exist yet:
    // the helper would normally return before={main:null, fast:null}. We
    // bypass the mock's normal flip path and craft the return shape directly.
    const llmModule = await import('@/lib/llm-settings.js');
    const spy = vi
      .spyOn(llmModule, 'setGlobalLLMSettingsAtomic')
      .mockResolvedValueOnce({
        ok: true as const,
        applied_at: new Date('2026-05-22T14:30:00Z'),
        before: { main: null, fast: null },
        after: { main: 'openai/gpt-5', fast: 'openai/gpt-5' },
      });

    const res = await caller('founder').update({
      main: 'openai/gpt-5',
      fast: 'openai/gpt-5',
      comment: 'fresh DB, no global_settings rows yet',
    });
    expect(res.ok).toBe(true);
    // Router fills the null with env defaults so the UI's "Previously" line
    // is always meaningful without a separate round-trip.
    expect(res.before).toEqual({
      main: 'anthropic/claude-sonnet-4.6',
      fast: 'anthropic/claude-haiku-4.5',
    });
    spy.mockRestore();
  });
});

describe('llmSettingsRouter.update — input validation', () => {
  it('rejects slug with invalid characters', async () => {
    await expect(
      caller('founder').update({
        main: 'has spaces and !punct',
        fast: 'openai/gpt-5',
        comment: 'should be rejected by zod schema',
      }),
    ).rejects.toThrow();
  });

  it('rejects comment shorter than 10 chars', async () => {
    await expect(
      caller('founder').update({
        main: 'openai/gpt-5',
        fast: 'openai/gpt-5',
        comment: 'short',
      }),
    ).rejects.toThrow();
  });

  it('rejects comment over 1000 chars', async () => {
    await expect(
      caller('founder').update({
        main: 'openai/gpt-5',
        fast: 'openai/gpt-5',
        comment: 'x'.repeat(1001),
      }),
    ).rejects.toThrow();
  });

  it('rejects empty main slug', async () => {
    await expect(
      caller('founder').update({
        main: '',
        fast: 'openai/gpt-5',
        comment: 'main slug must be non-empty',
      }),
    ).rejects.toThrow();
  });
});
