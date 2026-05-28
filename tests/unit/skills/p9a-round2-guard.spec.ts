/**
 * Round-2 review #99 — negative tests for:
 *  Finding 1: tenant-wide skill activation has no admin/owner guard.
 *  Finding 3: tool idempotency keys unstable for retry.
 *
 * Tenant-wide guard (finding 1):
 *  - propose(agent_id=null) from agent context → rejected with tenant_admin_required
 *  - activate(tenant_wide_skill) from agent context → rejected
 *  - deprecate(tenant_wide_skill) from agent context → rejected
 *  - rollback(tenant_wide_skill) from agent context → rejected
 *
 * Idempotency (finding 3):
 *  - toolMediatedMode without turno_id OR conversa_id → throws idempotency_key_unstable
 *  - toolMediatedMode WITH turno_id → stable key, no throw
 *  - same turno_id retried → identical key
 *  - conversa_id alone (no turno_id) → does not throw
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';

// ─── Tenant-wide guard tests ──────────────────────────────────────────────────

// State shared across the mocked DB calls so we can control what each
// select / withTx returns per test.
let nextSelectRows: any[] = [];

vi.mock('@/db/client.js', () => {
  const makeSelect = () => ({
    from: () => ({
      where: () => ({
        orderBy: () => ({
          limit: (n: number) => Promise.resolve(nextSelectRows.slice(0, n)),
        }),
        limit: (n: number) => Promise.resolve(nextSelectRows.slice(0, n)),
        // `.for('update')` row-lock hint (FIX A). No-op in this fake — resolve
        // the staged rows just like awaiting the chain would.
        for: (_mode: string) => Promise.resolve(nextSelectRows.slice()),
      }),
    }),
  });

  const makeWithTx = async (fn: (tx: any) => Promise<any>) => {
    const tx = {
      select: makeSelect,
      update: () => ({
        set: () => ({ where: () => Promise.resolve([]) }),
      }),
    };
    return fn(tx);
  };

  return {
    db: {
      select: makeSelect,
      insert: () => ({
        values: (v: any) => ({
          returning: () => Promise.resolve([{ ...v, id: `ins-${Date.now()}`, created_at: new Date() }]),
        }),
      }),
      update: () => ({
        set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
      }),
    },
    withTx: makeWithTx,
  };
});

import { skillsRepo } from '@/control-plane/skill-registry/skills-repo.js';

function tenantWideRow(status = 'proposed') {
  return {
    id: 'tw-skill-id',
    tenant_id: 'default',
    agent_id: null, // tenant-wide
    skill_descriptor: 'global_skill',
    status,
    version: 1,
    category: 'classify',
    execution_mode: 'prompt_only',
    goal: 'G',
    when_to_use: 'W',
    procedure: {},
    constraints: [],
    input_schema: {},
    output_schema: {},
    allowed_tools: [],
    policy_descriptors: [],
    success_criteria: [],
    failure_modes: [],
    runtime_hints: {},
    proposed_by: 'admin',
    proposed_reason: null,
    approved_by: null,
    approved_at: null,
    activated_at: null,
    deprecated_at: null,
    rolled_back_at: null,
    rollback_reason: null,
    created_at: new Date(),
  };
}

describe('round-2 finding 1 — tenant-wide skill guard (agent context rejected)', () => {
  beforeEach(() => {
    nextSelectRows = [];
    vi.clearAllMocks();
  });

  it('[neg] propose with agent_id=null from agent context → tenant_admin_required', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'agent-A' }, async () => {
      // Guard fires before any DB call, so no rows needed.
      await expect(
        skillsRepo.propose({
          agent_id: null, // explicit tenant-wide — must be rejected
          skill_descriptor: 'global_skill',
          category: 'classify',
          execution_mode: 'prompt_only',
          goal: 'G',
          when_to_use: 'W',
          procedure: {},
          input_schema: {},
          output_schema: {},
          proposed_by: 'agent-A',
        }),
      ).rejects.toThrow('tenant_admin_required');
    });
  });

  it('[neg] activate a tenant-wide skill (agent_id=null) from agent context → tenant_admin_required', async () => {
    // withTx selects the row first, then checks agent scope.
    nextSelectRows = [tenantWideRow('proposed')];

    await runWithTenantContext({ tenant_id: 'default', agent_id: 'agent-A' }, async () => {
      await expect(
        skillsRepo.activate('tw-skill-id', 'agent-A'),
      ).rejects.toThrow('tenant_admin_required');
    });
  });

  it('[neg] deprecate a tenant-wide skill (agent_id=null) from agent context → tenant_admin_required', async () => {
    // deprecate reads the row first (inside withTx since PR #213), then checks
    // scope — the tenant-wide guard fires before the status-conditioned UPDATE.
    nextSelectRows = [tenantWideRow('active')];

    await runWithTenantContext({ tenant_id: 'default', agent_id: 'agent-A' }, async () => {
      await expect(
        skillsRepo.deprecate('tw-skill-id', 'agent-A', 'reason'),
      ).rejects.toThrow('tenant_admin_required');
    });
  });

  it('[neg] rollback a tenant-wide skill (agent_id=null) from agent context → tenant_admin_required', async () => {
    // rollback uses withTx → tx.select returns the row → guard fires.
    nextSelectRows = [tenantWideRow('active')];

    await runWithTenantContext({ tenant_id: 'default', agent_id: 'agent-A' }, async () => {
      await expect(
        skillsRepo.rollback('tw-skill-id', 'bad skill', 'agent-A'),
      ).rejects.toThrow('tenant_admin_required');
    });
  });
});

// ─── Idempotency guard tests ──────────────────────────────────────────────────

vi.mock('@/lib/claude.js', () => ({ callLLM: vi.fn() }));

import { toolMediatedMode, setToolDispatcher } from '@/skills/modes/tool-mediated.js';
import { callLLM } from '@/lib/claude.js';

const baseSkill = {
  id: 'tm-idem-1',
  tenant_id: 'default',
  agent_id: 'agent-A',
  skill_descriptor: 'test_tool_skill',
  version: 1,
  procedure: {
    system_prompt: 'system',
    tool_schemas: [
      { name: 'write_db', description: 'side effect', input_schema: { type: 'object' } },
    ],
  },
  allowed_tools: ['write_db'],
  runtime_hints: {},
} as any;

describe('round-2 finding 3 — tool idempotency key stability', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setToolDispatcher(null);
    // Re-initialize nextSelectRows so DB mock doesn't interfere.
    nextSelectRows = [];
  });

  it('[neg] sem turno_id e sem conversa_id → throws idempotency_key_unstable', async () => {
    setToolDispatcher(async () => ({ ok: true }));

    // callLLM won't even be reached — guard fires before the loop.
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'agent-A' }, async () => {
      await expect(
        toolMediatedMode({
          skill: baseSkill,
          input: {},
          resolvedPolicies: [],
          // No turno_id, no conversa_id — must fail-closed.
        }),
      ).rejects.toThrow('idempotency_key_unstable');
    });
  });

  it('[pos] WITH turno_id → stable key contains tenant+agent+skill+version+turno_id', async () => {
    const dispatchedKeys: string[] = [];
    setToolDispatcher(async (_name, _args, opts) => {
      dispatchedKeys.push(opts?.idempotency_key ?? '');
      return { written: true };
    });

    vi.mocked(callLLM)
      .mockResolvedValueOnce({
        content: null,
        tool_uses: [{ id: 't1', tool: 'write_db', args: { x: 1 } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
        model: 'x',
      })
      .mockResolvedValueOnce({
        content: '{"done":true}',
        tool_uses: [],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
        model: 'x',
      });

    await runWithTenantContext({ tenant_id: 'default', agent_id: 'agent-A' }, async () => {
      const out = await toolMediatedMode({
        skill: baseSkill,
        input: {},
        resolvedPolicies: [],
        turno_id: 'turn-stable-42',
      });
      expect(out.done).toBe(true);
    });

    expect(dispatchedKeys).toHaveLength(1);
    const key = dispatchedKeys[0]!;
    expect(key).toContain('default');      // tenant
    expect(key).toContain('agent-A');      // agent
    expect(key).toContain('tm-idem-1');    // skill id
    expect(key).toContain('turn-stable-42'); // turno_id
  });

  it('[pos] same retry WITH same turno_id → identical idempotency key (dedupe guaranteed)', async () => {
    const dispatchedKeys: string[] = [];
    setToolDispatcher(async (_name, _args, opts) => {
      dispatchedKeys.push(opts?.idempotency_key ?? '');
      return { written: true };
    });

    const makeLLMResponses = () => {
      vi.mocked(callLLM)
        .mockResolvedValueOnce({
          content: null,
          tool_uses: [{ id: 'tu-provider-id', tool: 'write_db', args: { y: 2 } }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 1, output_tokens: 1 },
          model: 'x',
        })
        .mockResolvedValueOnce({
          content: '{"result":"ok"}',
          tool_uses: [],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
          model: 'x',
        });
    };

    await runWithTenantContext({ tenant_id: 'default', agent_id: 'agent-A' }, async () => {
      makeLLMResponses();
      await toolMediatedMode({ skill: baseSkill, input: {}, resolvedPolicies: [], turno_id: 'turn-retry-99' });
      makeLLMResponses();
      await toolMediatedMode({ skill: baseSkill, input: {}, resolvedPolicies: [], turno_id: 'turn-retry-99' });
    });

    expect(dispatchedKeys).toHaveLength(2);
    expect(dispatchedKeys[0]).toBe(dispatchedKeys[1]);
    expect(dispatchedKeys[0]).toContain('turn-retry-99');
  });

  it('[pos] WITH conversa_id only (no turno_id) → does not throw', async () => {
    setToolDispatcher(async () => ({ ok: true }));

    vi.mocked(callLLM)
      .mockResolvedValueOnce({
        content: null,
        tool_uses: [{ id: 't1', tool: 'write_db', args: {} }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
        model: 'x',
      })
      .mockResolvedValueOnce({
        content: '{"ok":true}',
        tool_uses: [],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
        model: 'x',
      });

    await runWithTenantContext({ tenant_id: 'default', agent_id: 'agent-A' }, async () => {
      const out = await toolMediatedMode({
        skill: baseSkill,
        input: {},
        resolvedPolicies: [],
        conversa_id: 'conv-123',
      });
      expect(out.ok).toBe(true);
    });
  });

  // ── Issue #261 (PR #273 review HIGH): cache wrapper contract ─────────────
  //
  // The Codex review of PR #273 flagged that `toolDispatcher` is injected
  // externally and could be wired to bypass `src/tools/_dispatcher.ts`'s
  // tenant-scoped cache. While production never wires `setToolDispatcher`
  // today (deferred to F1 Phase 2 — see docs/skill-execution-f1-spec.md §5),
  // the dispatchKey passed to the dispatcher MUST itself carry tenant+agent
  // so that any future cache-aware dispatcher cannot collide cross-tenant.
  // These tests pin the dispatchKey shape: same skill + same turno_id from
  // distinct tenants → distinct keys (no shared cache bucket).
  it('[pos] same skill + same turno_id from distinct tenants → distinct dispatch keys', async () => {
    const dispatchedKeys: string[] = [];
    setToolDispatcher(async (_name, _args, opts) => {
      dispatchedKeys.push(opts?.idempotency_key ?? '');
      return { ok: true };
    });

    const makeLLMResponses = () => {
      vi.mocked(callLLM)
        .mockResolvedValueOnce({
          content: null,
          tool_uses: [{ id: 't1', tool: 'write_db', args: { x: 1 } }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 1, output_tokens: 1 },
          model: 'x',
        })
        .mockResolvedValueOnce({
          content: '{"done":true}',
          tool_uses: [],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
          model: 'x',
        });
    };

    // Tenant-A dispatches first.
    await runWithTenantContext({ tenant_id: 'tenant-A', agent_id: 'agent-X' }, async () => {
      makeLLMResponses();
      await toolMediatedMode({
        skill: { ...baseSkill, tenant_id: 'tenant-A', agent_id: 'agent-X' },
        input: {},
        resolvedPolicies: [],
        turno_id: 'turn-shared-1',
      });
    });

    // Tenant-B dispatches with IDENTICAL turno_id and same tool args.
    await runWithTenantContext({ tenant_id: 'tenant-B', agent_id: 'agent-X' }, async () => {
      makeLLMResponses();
      await toolMediatedMode({
        skill: { ...baseSkill, tenant_id: 'tenant-B', agent_id: 'agent-X' },
        input: {},
        resolvedPolicies: [],
        turno_id: 'turn-shared-1',
      });
    });

    expect(dispatchedKeys).toHaveLength(2);
    expect(dispatchedKeys[0]).not.toBe(dispatchedKeys[1]);
    // Adversarial regression: tenant token MUST appear; cache bucket cannot
    // be the legacy 'unknown:unknown' shared bucket.
    expect(dispatchedKeys[0]).toContain('tenant-A');
    expect(dispatchedKeys[1]).toContain('tenant-B');
    expect(dispatchedKeys[0]).not.toContain('unknown');
    expect(dispatchedKeys[1]).not.toContain('unknown');
  });

  it('[pos] same tenant, different agents → distinct dispatch keys (per-agent isolation)', async () => {
    const dispatchedKeys: string[] = [];
    setToolDispatcher(async (_name, _args, opts) => {
      dispatchedKeys.push(opts?.idempotency_key ?? '');
      return { ok: true };
    });

    const makeLLMResponses = () => {
      vi.mocked(callLLM)
        .mockResolvedValueOnce({
          content: null,
          tool_uses: [{ id: 't1', tool: 'write_db', args: { x: 2 } }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 1, output_tokens: 1 },
          model: 'x',
        })
        .mockResolvedValueOnce({
          content: '{"done":true}',
          tool_uses: [],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
          model: 'x',
        });
    };

    await runWithTenantContext({ tenant_id: 'tenant-shared', agent_id: 'agent-1' }, async () => {
      makeLLMResponses();
      await toolMediatedMode({
        skill: { ...baseSkill, tenant_id: 'tenant-shared', agent_id: 'agent-1' },
        input: {},
        resolvedPolicies: [],
        turno_id: 'turn-shared-2',
      });
    });

    await runWithTenantContext({ tenant_id: 'tenant-shared', agent_id: 'agent-2' }, async () => {
      makeLLMResponses();
      await toolMediatedMode({
        skill: { ...baseSkill, tenant_id: 'tenant-shared', agent_id: 'agent-2' },
        input: {},
        resolvedPolicies: [],
        turno_id: 'turn-shared-2',
      });
    });

    expect(dispatchedKeys).toHaveLength(2);
    expect(dispatchedKeys[0]).not.toBe(dispatchedKeys[1]);
    expect(dispatchedKeys[0]).toContain('agent-1');
    expect(dispatchedKeys[1]).toContain('agent-2');
  });
});
