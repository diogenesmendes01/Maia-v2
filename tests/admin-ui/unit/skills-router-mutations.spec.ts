/**
 * Admin UI — skillsRouter MUTATIONS unit tests (Phase 3).
 *
 * Covers the lifecycle write layer added in Phase 3:
 *   - role gate: every mutation is FORBIDDEN for a non-founder; founder allowed
 *     (spec §2 "solo operator" — founder both proposes AND activates).
 *   - propose: the evaluator/allowed_tools cross-field rule is rejected by the
 *     input schema (execution_mode='evaluator' + non-empty allowed_tools).
 *   - activate/deprecate/rollback: call the right repo method with the resolved
 *     tenant + the skill's agent + the reason, inside runWithTenantContext.
 *   - repo errors map to the right TRPCError code (CONFLICT / FORBIDDEN /
 *     NOT_FOUND / BAD_REQUEST).
 *   - an admin_audit_log row is appended per successful mutation (we assert the
 *     audit repo's append is invoked with the right action + resource).
 *
 * Pattern mirrors skills-router.spec.ts: drive the router via createCaller with
 * an in-memory repo. The router wraps repo calls in runWithTenantContext, so
 * the mock repo reads getCurrentTenant/getCurrentAgent and we can assert what
 * context the call ran under.
 */
import { describe, it, expect, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { skillsRouter } from '@/admin-ui/trpc/routers/skills.js';
import { getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';

// A complete, valid propose payload for a NON-evaluator skill. Tests tweak it.
function validProposeInput(overrides: Record<string, unknown> = {}) {
  return {
    agentId: 'agent-x',
    skill_descriptor: 'detect_legal_risk',
    category: 'classify' as const,
    execution_mode: 'prompt_only' as const,
    goal: 'Detect legal risk in a message.',
    when_to_use: 'When the user asks about contracts.',
    procedure: { system_prompt: 'do the thing' },
    constraints: [],
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
    allowed_tools: [],
    policy_descriptors: [],
    success_criteria: [],
    failure_modes: [],
    runtime_hints: {},
    proposed_reason: 'initial authoring of this skill',
    ...overrides,
  };
}

type Captured = {
  proposeArg?: Record<string, unknown>;
  activateArgs?: unknown[];
  deprecateArgs?: unknown[];
  rollbackArgs?: unknown[];
  proposeCtx?: { tenant: string; agent: string };
  activateCtx?: { tenant: string; agent: string };
  auditCalls: Array<Record<string, unknown>>;
};

/**
 * Mock repos. Each lifecycle method records its args + the tenant/agent context
 * it ran under, and returns a believable SkillRow. `behavior` lets a test make a
 * method throw a typed repo error so we can assert the TRPCError mapping. The
 * audit repo records every append.
 */
function makeRepos(
  capture: Captured,
  behavior: {
    activate?: () => never;
    deprecate?: () => never;
    rollback?: () => never;
    propose?: () => never;
  } = {},
) {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'skill-1',
    tenant_id: getCurrentTenant(),
    agent_id: getCurrentAgent(),
    skill_descriptor: 'detect_legal_risk',
    category: 'classify',
    execution_mode: 'prompt_only',
    version: 1,
    status: 'proposed',
    activated_at: null,
    created_at: new Date(),
    ...over,
  });
  return {
    skillsRepo: {
      async getById(_id: string) {
        return row({ status: 'proposed' });
      },
      async propose(input: Record<string, unknown>) {
        capture.proposeArg = input;
        capture.proposeCtx = { tenant: getCurrentTenant(), agent: getCurrentAgent() };
        if (behavior.propose) behavior.propose();
        return row({ status: 'proposed', version: 1 });
      },
      async activate(id: string, approver: string, reason?: string) {
        capture.activateArgs = [id, approver, reason];
        capture.activateCtx = { tenant: getCurrentTenant(), agent: getCurrentAgent() };
        if (behavior.activate) behavior.activate();
        return row({ status: 'active', version: 1 });
      },
      async deprecate(id: string, by: string, reason: string) {
        capture.deprecateArgs = [id, by, reason];
        if (behavior.deprecate) behavior.deprecate();
        return row({ status: 'deprecated', version: 1 });
      },
      async rollback(id: string, reason: string, by: string) {
        capture.rollbackArgs = [id, reason, by];
        if (behavior.rollback) behavior.rollback();
        return row({ status: 'rolled_back', version: 2 });
      },
    },
    adminAuditLogRepo: {
      append: vi.fn(async (entry: Record<string, unknown>) => {
        capture.auditCalls.push(entry);
        return { id: 1, ...entry };
      }),
    },
  };
}

function caller(role: string, sessionTenant: string, repos: ReturnType<typeof makeRepos>) {
  const ctx = {
    session: { user: { id: 'u1', role, tenant_id: sessionTenant } },
    userId: 'u1',
    userRole: role,
    tenantId: sessionTenant,
    repos: repos as unknown as typeof import('@/db/repositories.js'),
    assertTenant: () => {},
    assertRole(...allowed: string[]) {
      if (!allowed.includes(role)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'role' });
      }
    },
  };
  return skillsRouter.createCaller(ctx);
}

function freshCapture(): Captured {
  return { auditCalls: [] };
}

describe('skillsRouter mutations — founder role gate (spec §2 solo operator)', () => {
  const NON_FOUNDER = ['owner', 'compliance_officer', 'analyst', 'viewer'];

  it.each(NON_FOUNDER)('propose is FORBIDDEN for role=%s', async (role) => {
    const repos = makeRepos(freshCapture());
    await expect(
      caller(role, 'tenant-A', repos).propose(validProposeInput()),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it.each(NON_FOUNDER)('activate is FORBIDDEN for role=%s', async (role) => {
    const repos = makeRepos(freshCapture());
    await expect(
      caller(role, 'tenant-A', repos).activate({
        id: 'skill-1',
        agentId: 'agent-x',
        reason: 'activate it now please',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it.each(NON_FOUNDER)('deprecate is FORBIDDEN for role=%s', async (role) => {
    const repos = makeRepos(freshCapture());
    await expect(
      caller(role, 'tenant-A', repos).deprecate({
        id: 'skill-1',
        agentId: 'agent-x',
        reason: 'deprecating this skill',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it.each(NON_FOUNDER)('rollback is FORBIDDEN for role=%s', async (role) => {
    const repos = makeRepos(freshCapture());
    await expect(
      caller(role, 'tenant-A', repos).rollback({
        id: 'skill-1',
        agentId: 'agent-x',
        reason: 'rolling this back now',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('founder is allowed to propose (no separation of duties)', async () => {
    const repos = makeRepos(freshCapture());
    const res = await caller('founder', 'tenant-A', repos).propose(validProposeInput());
    expect(res.item.status).toBe('proposed');
  });

  it('founder is allowed to activate (proposer can also activate)', async () => {
    const repos = makeRepos(freshCapture());
    const res = await caller('founder', 'tenant-A', repos).activate({
      id: 'skill-1',
      agentId: 'agent-x',
      reason: 'reviewed and approved',
    });
    expect(res.item.status).toBe('active');
  });
});

describe('skillsRouter.propose — evaluator/allowed_tools cross-field rule', () => {
  it('rejects execution_mode=evaluator with non-empty allowed_tools (BAD_REQUEST)', async () => {
    const repos = makeRepos(freshCapture());
    await expect(
      caller('founder', 'tenant-A', repos).propose(
        validProposeInput({
          execution_mode: 'evaluator',
          allowed_tools: ['send_message'],
        }),
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('allows execution_mode=evaluator with empty allowed_tools', async () => {
    const repos = makeRepos(freshCapture());
    const res = await caller('founder', 'tenant-A', repos).propose(
      validProposeInput({ execution_mode: 'evaluator', allowed_tools: [] }),
    );
    expect(res.item).toBeDefined();
  });
});

describe('skillsRouter mutations — repo call wiring + tenant/agent context', () => {
  it('propose forwards the contract + proposed_by + runs in the resolved tenant/agent', async () => {
    const capture = freshCapture();
    const repos = makeRepos(capture);
    await caller('founder', 'home', repos).propose(
      validProposeInput({ tenantId: 'tenant-Z', agentId: 'agent-x' }),
    );
    expect(capture.proposeCtx).toEqual({ tenant: 'tenant-Z', agent: 'agent-x' });
    expect(capture.proposeArg?.proposed_by).toBe('u1');
    expect(capture.proposeArg?.skill_descriptor).toBe('detect_legal_risk');
    // The repo derives agent_id from context; the router must NOT pass agent_id.
    expect(capture.proposeArg?.agent_id).toBeUndefined();
  });

  it('activate calls repo.activate(id, approver=userId, reason) in the right context', async () => {
    const capture = freshCapture();
    const repos = makeRepos(capture);
    await caller('founder', 'home', repos).activate({
      id: 'skill-1',
      tenantId: 'tenant-Z',
      agentId: 'agent-x',
      reason: 'approving this version',
    });
    expect(capture.activateArgs).toEqual(['skill-1', 'u1', 'approving this version']);
    expect(capture.activateCtx).toEqual({ tenant: 'tenant-Z', agent: 'agent-x' });
  });

  it('deprecate calls repo.deprecate(id, by=userId, reason)', async () => {
    const capture = freshCapture();
    const repos = makeRepos(capture);
    await caller('founder', 'tenant-A', repos).deprecate({
      id: 'skill-1',
      agentId: 'agent-x',
      reason: 'no longer needed here',
    });
    expect(capture.deprecateArgs).toEqual(['skill-1', 'u1', 'no longer needed here']);
  });

  it('rollback calls repo.rollback(id, reason, by=userId) — note arg order', async () => {
    const capture = freshCapture();
    const repos = makeRepos(capture);
    await caller('founder', 'tenant-A', repos).rollback({
      id: 'skill-1',
      agentId: 'agent-x',
      reason: 'reverting the bad version',
    });
    expect(capture.rollbackArgs).toEqual(['skill-1', 'reverting the bad version', 'u1']);
  });
});

describe('skillsRouter mutations — repo error → TRPCError mapping', () => {
  it('activate on a non-proposed skill maps cannot_activate_from_* → CONFLICT', async () => {
    const repos = makeRepos(freshCapture(), {
      activate: () => {
        throw new Error('cannot_activate_from_active');
      },
    });
    await expect(
      caller('founder', 'tenant-A', repos).activate({
        id: 'skill-1',
        agentId: 'agent-x',
        reason: 'trying to activate again',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('activate on a cross-agent skill maps agent_scope_violation → FORBIDDEN', async () => {
    const repos = makeRepos(freshCapture(), {
      activate: () => {
        throw new Error('agent_scope_violation: target agent agent-y vs context agent-x');
      },
    });
    await expect(
      caller('founder', 'tenant-A', repos).activate({
        id: 'skill-1',
        agentId: 'agent-x',
        reason: 'activate cross agent skill',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('deprecate on a missing skill maps skill_not_found → NOT_FOUND', async () => {
    const repos = makeRepos(freshCapture(), {
      deprecate: () => {
        throw new Error('skill_not_found');
      },
    });
    await expect(
      caller('founder', 'tenant-A', repos).deprecate({
        id: 'skill-1',
        agentId: 'agent-x',
        reason: 'deprecate a ghost skill',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rollback on a tenant-wide skill maps tenant_admin_required → FORBIDDEN', async () => {
    const repos = makeRepos(freshCapture(), {
      rollback: () => {
        throw new Error('tenant_admin_required: tenant-wide skills cannot be rolled back');
      },
    });
    await expect(
      caller('founder', 'tenant-A', repos).rollback({
        id: 'skill-1',
        agentId: 'agent-x',
        reason: 'rollback a tenant-wide skill',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('skillsRouter mutations — audit row per mutation', () => {
  it('propose appends a skill_proposed audit row for the new skill', async () => {
    const capture = freshCapture();
    const repos = makeRepos(capture);
    await caller('founder', 'tenant-A', repos).propose(validProposeInput());
    expect(repos.adminAuditLogRepo.append).toHaveBeenCalledTimes(1);
    expect(capture.auditCalls[0]).toMatchObject({
      action: 'skill_proposed',
      resource_type: 'skill',
      resource_id: 'skill-1',
      actor_id: 'u1',
      tenant_id: 'tenant-A',
    });
  });

  it('activate appends a skill_activated audit row with before/after status', async () => {
    const capture = freshCapture();
    const repos = makeRepos(capture);
    await caller('founder', 'tenant-A', repos).activate({
      id: 'skill-1',
      agentId: 'agent-x',
      reason: 'approving this version',
    });
    expect(repos.adminAuditLogRepo.append).toHaveBeenCalledTimes(1);
    expect(capture.auditCalls[0]).toMatchObject({
      action: 'skill_activated',
      resource_type: 'skill',
    });
    expect(capture.auditCalls[0]?.change_summary).toMatchObject({
      before_status: 'proposed',
      after_status: 'active',
    });
  });

  it('deprecate appends a skill_deprecated audit row', async () => {
    const capture = freshCapture();
    const repos = makeRepos(capture);
    await caller('founder', 'tenant-A', repos).deprecate({
      id: 'skill-1',
      agentId: 'agent-x',
      reason: 'deprecating this skill',
    });
    expect(capture.auditCalls[0]).toMatchObject({ action: 'skill_deprecated' });
  });

  it('rollback appends a skill_rolled_back audit row', async () => {
    const capture = freshCapture();
    const repos = makeRepos(capture);
    await caller('founder', 'tenant-A', repos).rollback({
      id: 'skill-1',
      agentId: 'agent-x',
      reason: 'rolling this back now',
    });
    expect(capture.auditCalls[0]).toMatchObject({ action: 'skill_rolled_back' });
  });

  it('does NOT append an audit row when the repo call fails', async () => {
    const capture = freshCapture();
    const repos = makeRepos(capture, {
      activate: () => {
        throw new Error('cannot_activate_from_deprecated');
      },
    });
    await expect(
      caller('founder', 'tenant-A', repos).activate({
        id: 'skill-1',
        agentId: 'agent-x',
        reason: 'attempt to activate',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(repos.adminAuditLogRepo.append).not.toHaveBeenCalled();
  });
});
