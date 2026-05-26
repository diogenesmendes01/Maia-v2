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
import { describe, it, expect, vi, afterEach } from 'vitest';
import { TRPCError } from '@trpc/server';
import { skillsRouter } from '@/admin-ui/trpc/routers/skills.js';
import { getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';
import { featureFlags } from '@/config/feature-flags.js';
import { FeatureFlagName } from '@/types/enums.js';

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
 * method throw a typed repo error so we can assert the TRPCError mapping.
 *
 * PR #213 FIX 1: the audit row is now written INSIDE the repo method (same tx),
 * driven by the optional `audit` payload the router passes. The mock mirrors
 * that: when `audit` is supplied it records the equivalent admin_audit_log
 * entry (merging the before/after status the real repo computes in-tx) into
 * `capture.auditCalls` BEFORE the `behavior.*` throw — EXCEPT the throw models
 * a failed mutation, so we only record the audit if the mutation "succeeds".
 * The separate `adminAuditLogRepo.append` is kept as a spy that the router must
 * NOT call anymore (asserted in a regression test).
 */
type AuditPayload = {
  actor_id: string;
  actor_role: string;
  action: string;
  tenant_id: string;
  change_summary?: Record<string, unknown>;
};

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
  // Mirror the repo's appendSkillAudit: merge descriptor/version/before/after
  // into change_summary, build the full admin_audit_log entry, record it.
  const recordAudit = (
    audit: AuditPayload | undefined,
    r: ReturnType<typeof row>,
    beforeStatus: string | null,
  ) => {
    if (!audit) return;
    capture.auditCalls.push({
      tenant_id: audit.tenant_id,
      actor_id: audit.actor_id,
      actor_role: audit.actor_role,
      action: audit.action,
      resource_type: 'skill',
      resource_id: r.id,
      change_summary: {
        ...(audit.change_summary ?? {}),
        skill_descriptor: r.skill_descriptor,
        version: r.version,
        before_status: beforeStatus,
        after_status: r.status,
      },
    });
  };
  return {
    skillsRepo: {
      async getById(_id: string) {
        return row({ status: 'proposed' });
      },
      async propose(input: Record<string, unknown>, audit?: AuditPayload) {
        capture.proposeArg = input;
        capture.proposeCtx = { tenant: getCurrentTenant(), agent: getCurrentAgent() };
        if (behavior.propose) behavior.propose();
        const r = row({ status: 'proposed', version: 1 });
        recordAudit(audit, r, null);
        return r;
      },
      async activate(id: string, approver: string, reason?: string, audit?: AuditPayload) {
        capture.activateArgs = [id, approver, reason];
        capture.activateCtx = { tenant: getCurrentTenant(), agent: getCurrentAgent() };
        if (behavior.activate) behavior.activate();
        const r = row({ status: 'active', version: 1 });
        recordAudit(audit, r, 'proposed');
        return r;
      },
      async deprecate(id: string, by: string, reason: string, audit?: AuditPayload) {
        capture.deprecateArgs = [id, by, reason];
        if (behavior.deprecate) behavior.deprecate();
        const r = row({ status: 'deprecated', version: 1 });
        recordAudit(audit, r, 'active');
        return r;
      },
      async rollback(id: string, reason: string, by: string, audit?: AuditPayload) {
        capture.rollbackArgs = [id, reason, by];
        if (behavior.rollback) behavior.rollback();
        const r = row({ status: 'rolled_back', version: 2 });
        recordAudit(audit, r, 'active');
        return r;
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

  // PR #213 FIX 2: the repo's lifecycle guards throw typed conflicts; the router
  // must map them to CONFLICT (and NOT append an audit row).
  it('deprecate maps cannot_deprecate_from_<status> → CONFLICT', async () => {
    const capture = freshCapture();
    const repos = makeRepos(capture, {
      deprecate: () => {
        throw new Error('cannot_deprecate_from_rolled_back');
      },
    });
    await expect(
      caller('founder', 'tenant-A', repos).deprecate({
        id: 'skill-1',
        agentId: 'agent-x',
        reason: 'deprecate an already-terminal skill',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(capture.auditCalls).toHaveLength(0);
  });

  it('rollback maps cannot_rollback_from_<status> → CONFLICT', async () => {
    const capture = freshCapture();
    const repos = makeRepos(capture, {
      rollback: () => {
        throw new Error('cannot_rollback_from_proposed');
      },
    });
    await expect(
      caller('founder', 'tenant-A', repos).rollback({
        id: 'skill-1',
        agentId: 'agent-x',
        reason: 'rollback a non-active skill',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(capture.auditCalls).toHaveLength(0);
  });
});

// PR #213 FIX 3: the server rejects allowed_tools that name a tool which is not
// currently enabled (gating flag off) or is unknown. The propose router builds
// the enabled-set from the SAME generated catalog + FLAG_TO_CONFIG the
// tools-catalog router uses. In the test env all gating flags default to false,
// so `generate_report` (gated by FEATURE_PDF_REPORTS) is a reliably-disabled
// tool and `register_transaction` (ungated) is reliably enabled.
describe('skillsRouter.propose — disabled/unknown tool rejection (FIX 3)', () => {
  it('rejects allowed_tools containing a disabled (flag-off) tool with BAD_REQUEST', async () => {
    const capture = freshCapture();
    const repos = makeRepos(capture);
    await expect(
      caller('founder', 'tenant-A', repos).propose(
        validProposeInput({ allowed_tools: ['generate_report'] }),
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    // Rejected BEFORE the repo runs — no skill row, no audit row.
    expect(capture.proposeArg).toBeUndefined();
    expect(capture.auditCalls).toHaveLength(0);
  });

  it('rejects allowed_tools containing an unknown tool with BAD_REQUEST', async () => {
    const capture = freshCapture();
    const repos = makeRepos(capture);
    await expect(
      caller('founder', 'tenant-A', repos).propose(
        validProposeInput({ allowed_tools: ['no_such_tool_xyz'] }),
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(capture.proposeArg).toBeUndefined();
  });

  it('allows allowed_tools containing only enabled (ungated) tools', async () => {
    const capture = freshCapture();
    const repos = makeRepos(capture);
    const res = await caller('founder', 'tenant-A', repos).propose(
      validProposeInput({ allowed_tools: ['register_transaction'] }),
    );
    expect(res.item).toBeDefined();
    expect(capture.proposeArg?.allowed_tools).toEqual(['register_transaction']);
  });
});

// PR #213 round-2 FIX B: the enabled-set MUST be resolved through the runtime
// `featureFlags.isEnabled()` path (kill switches / overrides) — the SAME gate
// the dispatcher uses — NOT static `config.FEATURE_*`. `register_custom_holiday`
// is gated by the `calendar_v2` FeatureFlagName flag. In the test env the
// CONFIG default for FEATURE_CALENDAR_V2 is false; we drive the runtime
// singleton directly to prove `propose` tracks it (and not a frozen config
// snapshot). afterEach resets the shared singleton so other tests are clean.
describe('skillsRouter.propose — runtime feature-flag gate (FIX B)', () => {
  afterEach(() => {
    featureFlags.reset();
  });

  it('ACCEPTS a FeatureFlagName-gated tool when a runtime OVERRIDE turns it on (config default is off)', async () => {
    const capture = freshCapture();
    const repos = makeRepos(capture);
    // Runtime override ON — even though config.FEATURE_CALENDAR_V2 defaults
    // false. A static-config gate would still reject; the runtime gate lets
    // it through, matching the dispatcher.
    featureFlags.override(FeatureFlagName.CALENDAR_V2, true);
    const res = await caller('founder', 'tenant-A', repos).propose(
      validProposeInput({ allowed_tools: ['register_custom_holiday'] }),
    );
    expect(res.item).toBeDefined();
    expect(capture.proposeArg?.allowed_tools).toEqual(['register_custom_holiday']);
  });

  it('REJECTS a runtime-KILLED FeatureFlagName-gated tool with BAD_REQUEST even though static config has the flag ON', async () => {
    const capture = freshCapture();
    const repos = makeRepos(capture);
    // Simulate "config says on" via a runtime override=true, then flip the
    // kill switch (max precedence). isEnabled() now returns false, so propose
    // must reject — proving it reads the runtime path, not the override/config
    // value. A static-config gate would have ACCEPTED here (the FIX B bug).
    featureFlags.override(FeatureFlagName.CALENDAR_V2, true);
    featureFlags.killSwitch(FeatureFlagName.CALENDAR_V2);
    await expect(
      caller('founder', 'tenant-A', repos).propose(
        validProposeInput({ allowed_tools: ['register_custom_holiday'] }),
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    // Rejected BEFORE the repo runs — no skill row, no audit row.
    expect(capture.proposeArg).toBeUndefined();
    expect(capture.auditCalls).toHaveLength(0);
  });
});

describe('skillsRouter mutations — audit row per mutation', () => {
  it('propose appends a skill_proposed audit row for the new skill (in-tx)', async () => {
    const capture = freshCapture();
    const repos = makeRepos(capture);
    await caller('founder', 'tenant-A', repos).propose(validProposeInput());
    // FIX 1: the audit row is written inside the repo's propose tx (via the
    // audit payload), NOT via a separate post-commit append.
    expect(repos.adminAuditLogRepo.append).not.toHaveBeenCalled();
    expect(capture.auditCalls).toHaveLength(1);
    expect(capture.auditCalls[0]).toMatchObject({
      action: 'skill_proposed',
      resource_type: 'skill',
      resource_id: 'skill-1',
      actor_id: 'u1',
      tenant_id: 'tenant-A',
    });
  });

  it('activate appends a skill_activated audit row with before/after status (in-tx)', async () => {
    const capture = freshCapture();
    const repos = makeRepos(capture);
    await caller('founder', 'tenant-A', repos).activate({
      id: 'skill-1',
      agentId: 'agent-x',
      reason: 'approving this version',
    });
    expect(repos.adminAuditLogRepo.append).not.toHaveBeenCalled();
    expect(capture.auditCalls).toHaveLength(1);
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
