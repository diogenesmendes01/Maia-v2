/**
 * Admin UI Setup — llmSettingsRouter unit tests.
 *
 * Drives the router through tRPC's caller with mocks for:
 *   - withTx (executes the fn with a fake tx that records inserts/upserts)
 *   - getCurrentMainModel / getCurrentFastModel (return seeded values)
 *   - getToolCallingModels (returns a small canned catalog)
 *
 * Verifies:
 *   1. get/catalog/update require role=founder (founderProcedure gate).
 *   2. Non-founder roles get FORBIDDEN.
 *   3. update with both sides unchanged returns BAD_REQUEST (no audit row).
 *   4. update flips both sides + appends an admin_audit_log row with
 *      action='llm_model_changed' and a change_summary containing before/after
 *      and the comment.
 *   5. Audit insert failure rolls back the model upserts atomically — the
 *      next read sees the OLD values, not the half-committed new ones (issue
 *      #183 ports the issue #165 atomicity invariant).
 *   6. update with only one side changed still works (the other side's upsert
 *      is skipped, but the audit row still records both before/after).
 *   7. Input validation: invalid slug characters / oversized comment.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

// Mock the LLM settings helpers BEFORE importing the router so the router
// picks up the mocks at module-load. We mutate the backing state from each
// test via `setMockMain` / `setMockFast`.
let mockMain = 'anthropic/claude-sonnet-4.6';
let mockFast = 'anthropic/claude-haiku-4.5';

vi.mock('@/lib/llm-settings.js', () => ({
  getCurrentMainModel: vi.fn(async () => mockMain),
  getCurrentFastModel: vi.fn(async () => mockFast),
  // setCurrent* helpers aren't called by the router (it inlines the upsert
  // into the tx) — kept as no-op spies for completeness.
  setCurrentMainModel: vi.fn(async () => undefined),
  setCurrentFastModel: vi.fn(async () => undefined),
  envDefaults: vi.fn(() => ({
    main: 'anthropic/claude-sonnet-4.6',
    fast: 'anthropic/claude-haiku-4.5',
    provider: 'openrouter',
  })),
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

// In-memory "tx" recorder: every upsert/insert appends to a typed log so the
// test can assert what got written. `auditShouldFail` triggers an exception
// at the audit-insert step (simulates the real failure mode that the atomic
// pattern protects against — issue #165 ported to issue #183).
type UpsertOp = { table: 'agent_facts'; key: string; model: string };
type AuditOp = {
  table: 'admin_audit_log';
  action: string;
  resource_type: string;
  change_summary: Record<string, unknown> | null;
};
let txLog: Array<UpsertOp | AuditOp> = [];
let auditShouldFail = false;

vi.mock('@/db/client.js', () => ({
  db: {},
  withTx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    // Snapshot pre-tx state so we can simulate ROLLBACK if fn throws.
    const snapshotLog = [...txLog];
    const snapshotMain = mockMain;
    const snapshotFast = mockFast;

    const tx = {
      insert: (_table: { _: { name?: string } } | unknown) => ({
        values: (vals: Record<string, unknown>) => {
          // Sniff the table by which fields the row has (matches the
          // router's payload — agent_facts has `chave`, admin_audit_log
          // has `action`). This is jankier than checking `table` but
          // works against the opaque drizzle table reference.
          if ('chave' in vals && 'valor' in vals) {
            const chave = String(vals.chave);
            const valor = vals.valor as { model?: string };
            return {
              onConflictDoUpdate: (_args: unknown) => {
                txLog.push({
                  table: 'agent_facts',
                  key: chave,
                  model: valor.model ?? '',
                });
                // Reflect the upsert in the mocked "current value" so a
                // subsequent get inside the same test sees it.
                if (chave === 'llm.model.main') mockMain = valor.model ?? '';
                if (chave === 'llm.model.fast') mockFast = valor.model ?? '';
                return Promise.resolve();
              },
            };
          }
          if ('action' in vals) {
            if (auditShouldFail) {
              throw new Error('simulated audit insert failure');
            }
            txLog.push({
              table: 'admin_audit_log',
              action: String(vals.action),
              resource_type: String(vals.resource_type),
              change_summary: vals.change_summary as Record<string, unknown> | null,
            });
            return Promise.resolve();
          }
          return Promise.resolve();
        },
      }),
    };

    try {
      return await fn(tx);
    } catch (err) {
      // ROLLBACK simulation: restore pre-tx state. Real Postgres does this
      // implicitly; here we restore the test mocks so a subsequent get()
      // sees the original values (the invariant we test for).
      txLog = snapshotLog;
      mockMain = snapshotMain;
      mockFast = snapshotFast;
      throw err;
    }
  }),
}));

// Tenant context — the router wraps each procedure in runWithTenantContext.
// The mock just executes the callback directly (no AsyncLocalStorage needed
// since the inner code paths are all mocked).
vi.mock('@/db/tenant-context.js', () => ({
  runWithTenantContext: vi.fn(
    async (_ctx: unknown, fn: () => Promise<unknown>) => fn(),
  ),
  getCurrentTenant: vi.fn(() => 'tenant-test'),
  getCurrentAgent: vi.fn(() => 'default'),
  MissingTenantContextError: class MissingTenantContextError extends Error {},
}));

// Stub schema imports — the router references the table objects but our
// fake tx ignores them (sniffs by row shape instead).
vi.mock('@/db/schema.js', () => ({
  agent_facts: { _: { name: 'agent_facts' } },
  admin_audit_log: { _: { name: 'admin_audit_log' } },
}));

// Now import the router. The async-friendly import path avoids hoisting
// issues with the mocks above.
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
      // tenantsRepo.findById is consulted by protectedProcedure for the
      // suspension check on non-founder roles. Founders bypass it, so for
      // founder tests we don't need this; for the FORBIDDEN tests we DO
      // need the role check to fire before any repo call, so a minimal
      // stub keeps the middleware happy.
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
  txLog = [];
  auditShouldFail = false;
  mockMain = 'anthropic/claude-sonnet-4.6';
  mockFast = 'anthropic/claude-haiku-4.5';
});

describe('llmSettingsRouter.get — founder gate', () => {
  it('founder can read current settings + env defaults', async () => {
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

describe('llmSettingsRouter.update — gate + audit + atomicity', () => {
  it('founder flips both sides, audit row captures before/after + comment', async () => {
    const res = await caller('founder').update({
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

    // Two upserts + one audit row.
    expect(txLog.length).toBe(3);
    expect(txLog[0]).toMatchObject({
      table: 'agent_facts',
      key: 'llm.model.main',
      model: 'openai/gpt-5',
    });
    expect(txLog[1]).toMatchObject({
      table: 'agent_facts',
      key: 'llm.model.fast',
      model: 'openai/gpt-5',
    });
    const auditOp = txLog[2] as AuditOp;
    expect(auditOp.table).toBe('admin_audit_log');
    expect(auditOp.action).toBe('llm_model_changed');
    expect(auditOp.resource_type).toBe('llm_settings');
    expect(auditOp.change_summary).toMatchObject({
      before: {
        main: 'anthropic/claude-sonnet-4.6',
        fast: 'anthropic/claude-haiku-4.5',
      },
      after: { main: 'openai/gpt-5', fast: 'openai/gpt-5' },
      comment: 'Anthropic outage 14:30 UTC, swap to OpenAI',
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
      // No DB writes happened — gate rejected before any tx.
      expect(txLog.length).toBe(0);
    },
  );

  it('BAD_REQUEST when both sides match current (no-op)', async () => {
    await expect(
      caller('founder').update({
        main: 'anthropic/claude-sonnet-4.6',
        fast: 'anthropic/claude-haiku-4.5',
        comment: 'this should be rejected — nothing actually changed',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    // No tx ran, no audit row.
    expect(txLog.length).toBe(0);
  });

  it('only-main changed: still writes audit row with both before/after, skips fast upsert', async () => {
    const res = await caller('founder').update({
      main: 'openai/gpt-5',
      fast: 'anthropic/claude-haiku-4.5', // unchanged
      comment: 'Sonnet flapping, swap main only',
    });
    expect(res.ok).toBe(true);
    // 1 upsert (main only) + 1 audit row.
    expect(txLog.length).toBe(2);
    expect(txLog[0]).toMatchObject({ key: 'llm.model.main' });
    const auditOp = txLog[1] as AuditOp;
    expect(auditOp.change_summary).toMatchObject({
      before: {
        main: 'anthropic/claude-sonnet-4.6',
        fast: 'anthropic/claude-haiku-4.5',
      },
      after: {
        main: 'openai/gpt-5',
        fast: 'anthropic/claude-haiku-4.5',
      },
    });
  });

  // CRITICAL — issue #183 ports issue #165's atomicity invariant.
  //
  // Pre-fix (the legacy /dashboard/llm-settings):
  //   setCurrentMainModel(main)   ← commits immediately
  //   setCurrentFastModel(fast)   ← commits immediately
  //   audit({ ... })              ← if this throws, the model facts are
  //                                  ALREADY persisted with no audit row.
  //                                  Runtime callLLM picks up the new model
  //                                  silently — high-blast-radius change with
  //                                  no forensic trail. Retry after fix would
  //                                  hit no-op BAD_REQUEST and the audit row
  //                                  is lost forever.
  //
  // Post-fix: all three writes inside one withTx. Audit throw → ROLLBACK →
  // both model facts revert. The runtime keeps using the OLD model, and the
  // founder sees an error, can retry, and the audit row IS written.
  it('audit insert failure rolls back both model upserts (atomic, issue #183/#165 pattern)', async () => {
    auditShouldFail = true;

    await expect(
      caller('founder').update({
        main: 'openai/gpt-5',
        fast: 'x-ai/grok-4.1-fast',
        comment: 'audit will fail on this attempt',
      }),
    ).rejects.toThrow(/simulated audit insert failure/);

    // CRITICAL invariants:
    //   - txLog is empty after rollback (our fake tx restores the snapshot).
    //   - Current values are unchanged (next get() returns the OLD models).
    expect(txLog.length).toBe(0);
    expect(mockMain).toBe('anthropic/claude-sonnet-4.6');
    expect(mockFast).toBe('anthropic/claude-haiku-4.5');

    // Subsequent get() confirms the runtime sees the pre-attempt values.
    const after = await caller('founder').get();
    expect(after.main).toBe('anthropic/claude-sonnet-4.6');
    expect(after.fast).toBe('anthropic/claude-haiku-4.5');

    // Retry without the failure trigger — now both upserts + audit commit.
    auditShouldFail = false;
    const res = await caller('founder').update({
      main: 'openai/gpt-5',
      fast: 'x-ai/grok-4.1-fast',
      comment: 'retry after rollback',
    });
    expect(res.ok).toBe(true);
    expect(txLog.length).toBe(3);
    const auditOp = txLog[2] as AuditOp;
    expect(auditOp.change_summary).toMatchObject({
      comment: 'retry after rollback',
    });
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
