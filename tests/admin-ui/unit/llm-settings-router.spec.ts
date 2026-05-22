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
// Codex round 4 on PR #188 [high]: source-aware read. The UI uses
// these to decide whether to pass null vs the observed value as
// expected_*. Default 'global' so the existing tests keep their
// pre-round-4 behavior.
let mockMainSource: 'global' | 'legacy' | 'env' = 'global';
let mockFastSource: 'global' | 'legacy' | 'env' = 'global';

type AtomicCall = {
  main: string;
  fast: string;
  // Codex round 3 on PR #188 [P2]: optimistic concurrency. Tests now
  // exercise the expected_* round-trip from router input to helper
  // call, including the conflict-mode mock below.
  // Codex round 4 [high]: nullable for fresh-install path.
  expected_main: string | null;
  expected_fast: string | null;
  updated_by: string;
  actor_role: string;
  tenant_id: string;
  comment: string;
};
const atomicCalls: AtomicCall[] = [];
let atomicMode: 'flip' | 'no_changes' | 'throw' | 'conflict' = 'flip';
let atomicThrow: Error = new Error('simulated atomic failure');
let conflictPayload: {
  field: 'main' | 'fast';
  expected: string | null;
  current: string | null;
} = { field: 'main', expected: 'X', current: 'Y' };
let mockProvider: 'openrouter' | 'anthropic' = 'openrouter';

vi.mock('@/lib/llm-settings.js', () => ({
  // Codex round 4 [high]: router now uses getCurrentLLMSettings
  // (source-aware) instead of the single-value getters. Both helpers
  // remain mocked because the integration tests still reach for the
  // legacy names.
  getCurrentLLMSettings: vi.fn(async () => ({
    main: { value: mockMain, source: mockMainSource },
    fast: { value: mockFast, source: mockFastSource },
  })),
  getCurrentMainModel: vi.fn(async () => mockMain),
  getCurrentFastModel: vi.fn(async () => mockFast),
  envDefaults: vi.fn(() => ({
    main: 'anthropic/claude-sonnet-4.6',
    fast: 'anthropic/claude-haiku-4.5',
    provider: mockProvider,
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
    if (atomicMode === 'conflict') {
      return {
        ok: false as const,
        reason: 'optimistic_conflict' as const,
        field: conflictPayload.field,
        expected: conflictPayload.expected,
        current: conflictPayload.current,
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
  mockProvider = 'openrouter';
  mockMain = 'anthropic/claude-sonnet-4.6';
  mockFast = 'anthropic/claude-haiku-4.5';
  mockMainSource = 'global';
  mockFastSource = 'global';
});

describe('llmSettingsRouter.get — founder gate', () => {
  it('founder can read current settings + env defaults (no tenant context wrap)', async () => {
    const res = await caller('founder').get();
    expect(res.main).toBe('anthropic/claude-sonnet-4.6');
    expect(res.fast).toBe('anthropic/claude-haiku-4.5');
    expect(res.env.provider).toBe('openrouter');
    // Codex round 4 [high]: source flags surface to the UI so it knows
    // whether to send `expected_*: null` (no global_settings row) or
    // the observed value (global row exists, race-checkable).
    expect(res.mainSource).toBe('global');
    expect(res.fastSource).toBe('global');
  });

  // Codex round 4 [high]: fresh install — source='env' surfaces so the
  // UI knows to pass `expected_*: null`. Without this, the first-ever
  // update on a fresh DB loops forever on optimistic_conflict.
  it('founder sees source=env when no global_settings row exists', async () => {
    mockMainSource = 'env';
    mockFastSource = 'env';
    const res = await caller('founder').get();
    expect(res.mainSource).toBe('env');
    expect(res.fastSource).toBe('env');
  });

  it('founder sees source=legacy when legacy agent_facts fallback fires', async () => {
    mockMainSource = 'legacy';
    mockFastSource = 'env';
    const res = await caller('founder').get();
    expect(res.mainSource).toBe('legacy');
    expect(res.fastSource).toBe('env');
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
  it('founder flips both sides; atomic helper receives actor metadata + comment + expected_*', async () => {
    const res = await caller('founder', 'tenant-x', 'founder-1').update({
      main: 'openai/gpt-5',
      fast: 'openai/gpt-5',
      expected_main: 'anthropic/claude-sonnet-4.6',
      expected_fast: 'anthropic/claude-haiku-4.5',
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
      expected_main: 'anthropic/claude-sonnet-4.6',
      expected_fast: 'anthropic/claude-haiku-4.5',
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
          expected_main: 'anthropic/claude-sonnet-4.6',
          expected_fast: 'anthropic/claude-haiku-4.5',
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
        expected_main: 'anthropic/claude-sonnet-4.6',
        expected_fast: 'anthropic/claude-haiku-4.5',
        comment: 'this should be rejected — nothing actually changed',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(atomicCalls).toHaveLength(1); // helper WAS called; it returned no_changes
  });

  // Codex round 3 on PR #188 [P2]: optimistic-conflict mapping. Helper
  // returns reason='optimistic_conflict' → router maps to 409 CONFLICT
  // with a message including the field/expected/current diagnostics.
  it('CONFLICT when atomic helper reports optimistic_conflict (main)', async () => {
    atomicMode = 'conflict';
    conflictPayload = {
      field: 'main',
      expected: 'anthropic/claude-sonnet-4.6',
      current: 'openai/gpt-5',
    };
    await expect(
      caller('founder').update({
        main: 'x-ai/grok-4.1-fast',
        fast: 'anthropic/claude-haiku-4.5',
        expected_main: 'anthropic/claude-sonnet-4.6', // founder thought main was sonnet
        expected_fast: 'anthropic/claude-haiku-4.5',
        comment: 'race with another founder — should 409',
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(atomicCalls).toHaveLength(1);
  });

  it('CONFLICT when atomic helper reports optimistic_conflict (fast)', async () => {
    atomicMode = 'conflict';
    conflictPayload = {
      field: 'fast',
      expected: 'anthropic/claude-haiku-4.5',
      current: 'x-ai/grok-4.1-fast',
    };
    await expect(
      caller('founder').update({
        main: 'anthropic/claude-sonnet-4.6',
        fast: 'openai/gpt-5',
        expected_main: 'anthropic/claude-sonnet-4.6',
        expected_fast: 'anthropic/claude-haiku-4.5',
        comment: 'race on the fast side — should 409',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
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
        expected_main: 'anthropic/claude-sonnet-4.6',
        expected_fast: 'anthropic/claude-haiku-4.5',
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
      expected_main: 'anthropic/claude-sonnet-4.6',
      expected_fast: 'anthropic/claude-haiku-4.5',
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

// Codex round 4 on PR #188 [high]: provider gate is now STRICTER. The
// runtime AnthropicProvider passes the stored slug straight to the
// Anthropic SDK, which requires the native short ID form
// (`claude-sonnet-4-6`, NOT `anthropic/claude-sonnet-4.6`). Round 3
// accepted both; round 4 only accepts native (no slash). The catalog
// in Anthropic mode now NORMALIZES openrouter-format anthropic
// entries to their native form, dropping non-anthropic vendors.
describe('llmSettingsRouter — provider gate (Codex round 4)', () => {
  it('catalog normalizes anthropic/* slugs to native form when provider=anthropic', async () => {
    mockProvider = 'anthropic';
    const res = await caller('founder').catalog();
    expect(res.provider).toBe('anthropic');
    // Mock catalog has two items:
    //   - anthropic/claude-sonnet-4.6 → normalized to claude-sonnet-4-6
    //   - openai/gpt-5 → dropped entirely (can't be normalized)
    expect(res.items.map((m) => m.id)).toEqual(['claude-sonnet-4-6']);
  });

  it('catalog returns full unfiltered set when provider=openrouter', async () => {
    mockProvider = 'openrouter';
    const res = await caller('founder').catalog();
    expect(res.provider).toBe('openrouter');
    expect(res.items.map((m) => m.id)).toEqual([
      'anthropic/claude-sonnet-4.6',
      'openai/gpt-5',
    ]);
  });

  it('update rejects openai/* slug when provider=anthropic (main side)', async () => {
    mockProvider = 'anthropic';
    await expect(
      caller('founder').update({
        main: 'openai/gpt-5',
        fast: 'claude-haiku-4-5-20251001',
        expected_main: 'claude-sonnet-4-6',
        expected_fast: 'claude-haiku-4-5-20251001',
        comment: 'should be rejected — openai slug with anthropic provider',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    // Atomic helper must NOT be called — rejection happens before the
    // tx so no audit row gets written for the bad attempt.
    expect(atomicCalls).toHaveLength(0);
  });

  it('update rejects x-ai/* slug when provider=anthropic (fast side)', async () => {
    mockProvider = 'anthropic';
    await expect(
      caller('founder').update({
        main: 'claude-sonnet-4-6',
        fast: 'x-ai/grok-4.1-fast',
        expected_main: 'claude-sonnet-4-6',
        expected_fast: 'claude-haiku-4-5-20251001',
        comment: 'should be rejected — x-ai slug with anthropic provider',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(atomicCalls).toHaveLength(0);
  });

  // Codex round 4 [high]: this is the regression we're guarding
  // against. `anthropic/claude-sonnet-4.6` is the OpenRouter canonical
  // form, but AnthropicProvider passes the slug straight to the SDK,
  // which only accepts the native short ID (`claude-sonnet-4-6`).
  // Allowing the prefixed form to be persisted bricks every runtime
  // LLM call until a founder switches back.
  it('update REJECTS anthropic/* slug when provider=anthropic (round 4 tightening)', async () => {
    mockProvider = 'anthropic';
    await expect(
      caller('founder').update({
        main: 'anthropic/claude-sonnet-4.6',
        fast: 'claude-haiku-4-5-20251001',
        expected_main: 'claude-sonnet-4-6',
        expected_fast: 'claude-haiku-4-5-20251001',
        comment: 'should be rejected — openrouter-format anthropic slug',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(atomicCalls).toHaveLength(0);
  });

  it('update accepts Anthropic short ID (no slash) when provider=anthropic', async () => {
    mockProvider = 'anthropic';
    const res = await caller('founder').update({
      main: 'claude-sonnet-4-6',
      fast: 'claude-haiku-4-5-20251001',
      expected_main: 'claude-sonnet-4-6',
      expected_fast: 'claude-haiku-4-5-20251001',
      comment: 'anthropic-native short ID should pass the gate',
    });
    expect(res.ok).toBe(true);
    expect(atomicCalls).toHaveLength(1);
  });

  // Round 4 [high]: dots are rejected in Anthropic mode too. The SDK
  // format is hyphens (`claude-sonnet-4-6`) not dots (`claude-sonnet-4.6`).
  it('update rejects dot-form short ID when provider=anthropic', async () => {
    mockProvider = 'anthropic';
    await expect(
      caller('founder').update({
        main: 'claude-sonnet-4.6',
        fast: 'claude-haiku-4-5-20251001',
        expected_main: 'claude-sonnet-4-6',
        expected_fast: 'claude-haiku-4-5-20251001',
        comment: 'dots are not part of native Anthropic IDs',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(atomicCalls).toHaveLength(0);
  });

  it('update accepts any slug when provider=openrouter', async () => {
    mockProvider = 'openrouter';
    const res = await caller('founder').update({
      main: 'openai/gpt-5',
      fast: 'x-ai/grok-4.1-fast',
      expected_main: 'anthropic/claude-sonnet-4.6',
      expected_fast: 'anthropic/claude-haiku-4.5',
      comment: 'openrouter accepts every vendor prefix',
    });
    expect(res.ok).toBe(true);
  });
});

describe('llmSettingsRouter.update — input validation', () => {
  it('rejects slug with invalid characters', async () => {
    await expect(
      caller('founder').update({
        main: 'has spaces and !punct',
        fast: 'openai/gpt-5',
        expected_main: 'anthropic/claude-sonnet-4.6',
        expected_fast: 'anthropic/claude-haiku-4.5',
        comment: 'should be rejected by zod schema',
      }),
    ).rejects.toThrow();
  });

  it('rejects comment shorter than 10 chars', async () => {
    await expect(
      caller('founder').update({
        main: 'openai/gpt-5',
        fast: 'openai/gpt-5',
        expected_main: 'anthropic/claude-sonnet-4.6',
        expected_fast: 'anthropic/claude-haiku-4.5',
        comment: 'short',
      }),
    ).rejects.toThrow();
  });

  // Codex round 2 on PR #188 [P3]: the previous schema validated raw
  // character count, so a 10-space comment slipped through and the audit
  // row was forensically empty. The schema now trims before min-length
  // check.
  it('rejects whitespace-only comment (10 spaces, was a bypass pre-trim)', async () => {
    await expect(
      caller('founder').update({
        main: 'openai/gpt-5',
        fast: 'x-ai/grok-4.1-fast',
        expected_main: 'anthropic/claude-sonnet-4.6',
        expected_fast: 'anthropic/claude-haiku-4.5',
        comment: '          ', // 10 spaces — would have passed pre-trim
      }),
    ).rejects.toThrow();
    expect(atomicCalls).toHaveLength(0); // never reached the atomic helper
  });

  it('rejects tab/newline-only comment (whitespace audit reason is useless)', async () => {
    await expect(
      caller('founder').update({
        main: 'openai/gpt-5',
        fast: 'x-ai/grok-4.1-fast',
        expected_main: 'anthropic/claude-sonnet-4.6',
        expected_fast: 'anthropic/claude-haiku-4.5',
        comment: '\t\t\n\n  \t  \n  \t', // mixed whitespace, > 10 chars
      }),
    ).rejects.toThrow();
    expect(atomicCalls).toHaveLength(0);
  });

  it('rejects comment over 1000 chars', async () => {
    await expect(
      caller('founder').update({
        main: 'openai/gpt-5',
        fast: 'openai/gpt-5',
        expected_main: 'anthropic/claude-sonnet-4.6',
        expected_fast: 'anthropic/claude-haiku-4.5',
        comment: 'x'.repeat(1001),
      }),
    ).rejects.toThrow();
  });

  it('rejects empty main slug', async () => {
    await expect(
      caller('founder').update({
        main: '',
        fast: 'openai/gpt-5',
        expected_main: 'anthropic/claude-sonnet-4.6',
        expected_fast: 'anthropic/claude-haiku-4.5',
        comment: 'main slug must be non-empty',
      }),
    ).rejects.toThrow();
  });

  // Codex round 3 on PR #188 [P2]: schema requires expected_*; missing
  // them is a hard validation error (no defaults, no implicit skip).
  it('rejects missing expected_main (zod validation)', async () => {
    await expect(
      caller('founder').update({
        main: 'openai/gpt-5',
        fast: 'openai/gpt-5',
        // expected_main intentionally omitted
        expected_fast: 'anthropic/claude-haiku-4.5',
        comment: 'expected_main must be present',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    ).rejects.toThrow();
    expect(atomicCalls).toHaveLength(0);
  });

  it('rejects missing expected_fast (zod validation)', async () => {
    await expect(
      caller('founder').update({
        main: 'openai/gpt-5',
        fast: 'openai/gpt-5',
        expected_main: 'anthropic/claude-sonnet-4.6',
        // expected_fast intentionally omitted
        comment: 'expected_fast must be present',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    ).rejects.toThrow();
    expect(atomicCalls).toHaveLength(0);
  });

  // Codex round 4 [high]: expected_* must accept null (fresh-install
  // path). The UI sends null when source is 'env' or 'legacy' so the
  // first-ever update doesn't loop forever on optimistic_conflict.
  it('accepts expected_main=null + expected_fast=null (fresh install)', async () => {
    const res = await caller('founder').update({
      main: 'openai/gpt-5',
      fast: 'openai/gpt-5',
      expected_main: null,
      expected_fast: null,
      comment: 'fresh install — first ever update from env defaults',
    });
    expect(res.ok).toBe(true);
    // The atomic helper sees nulls — it's the helper's job to map
    // those into the repo's `expected: null` request shape.
    expect(atomicCalls).toHaveLength(1);
    expect(atomicCalls[0]!.expected_main).toBeNull();
    expect(atomicCalls[0]!.expected_fast).toBeNull();
  });

  // Round 4 — mixed: one side null, one side string.
  it('accepts expected_main=null + expected_fast=<observed>', async () => {
    const res = await caller('founder').update({
      main: 'openai/gpt-5',
      fast: 'openai/gpt-5',
      expected_main: null,
      expected_fast: 'anthropic/claude-haiku-4.5',
      comment: 'main is env default, fast has a global row',
    });
    expect(res.ok).toBe(true);
    expect(atomicCalls[0]!.expected_main).toBeNull();
    expect(atomicCalls[0]!.expected_fast).toBe('anthropic/claude-haiku-4.5');
  });
});
