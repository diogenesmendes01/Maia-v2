/**
 * Issue #409 — SkillRunner gate ~4.6 (LATE, fail-closed usage-policy re-check).
 *
 * Proves the execution gate that closes the TOCTOU window between the
 * SkillSelector candidate filter (early) and execution: re-evaluating the
 * skill's `usage_policy` against the resolved audience, refusing execution with
 * a typed `SkillFailureReason` and emitting the `skill_blocked_by_*` /
 * `skill_allowed` audit (invariant #4). DB-free: every collaborator is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';

vi.mock('@/config/feature-flags.js', () => ({
  featureFlags: { isEnabled: vi.fn(() => true) },
}));

const { skillRowState } = vi.hoisted(() => ({
  skillRowState: { row: null as Record<string, unknown> | null },
}));
const { auditMock } = vi.hoisted(() => ({ auditMock: vi.fn(async () => undefined) }));

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
    '@/db/repositories.js',
  );
  return {
    ...actual,
    skillsRepo: {
      findActive: vi.fn(async () => skillRowState.row),
      listByCategory: vi.fn(async () => []),
      propose: vi.fn(),
      activate: vi.fn(),
      deprecate: vi.fn(),
      rollback: vi.fn(),
      getById: vi.fn(),
      getByDescriptor: vi.fn(),
      listVersions: vi.fn(async () => []),
    },
  };
});

vi.mock('@/governance/audit.js', () => ({ audit: auditMock }));

vi.mock('@/cognition/runner.js', async () => {
  const actual = await vi.importActual<typeof import('@/cognition/runner.js')>(
    '@/cognition/runner.js',
  );
  return {
    ...actual,
    runCognitiveModule: vi.fn(async (_opts: unknown, fn: () => Promise<unknown>) => {
      const out = await fn();
      return { output: out, status: 'success', fallback_triggered: false, latency_ms: 1 };
    }),
  };
});

vi.mock('@/control-plane/policy/policy-descriptor-resolver.js', () => ({
  policyDescriptorResolver: {
    resolveDescriptors: vi.fn(async () => ({ resolved: [], unresolved: [] })),
  },
}));

vi.mock('@/skills/modes/prompt-only.js', () => ({
  promptOnlyMode: vi.fn(async () => ({ reply: 'ok' })),
  parseJsonResponse: vi.fn(),
}));
vi.mock('@/skills/modes/procedure-adapter.js', () => ({
  procedureAdapterMode: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/skills/modes/tool-mediated.js', () => ({
  toolMediatedMode: vi.fn(async () => ({ ok: true })),
  setToolDispatcher: vi.fn(),
}));
vi.mock('@/skills/modes/evaluator.js', () => ({
  evaluatorMode: vi.fn(async () => ({ verdict: 'pass' })),
  parseEvaluatorOutput: vi.fn(),
}));

import { runSkill } from '@/skills/skill-runner.js';
import type { SkillExecutionInput } from '@/skills/types.js';

const DAILY_BUSINESS_SUMMARY = {
  allowed_audience: ['owner', 'manager'],
  blocked_audience: ['customer', 'lead', 'vendor'],
  data_scope: ['financial_summary', 'operations_summary'],
  exposure_policy: 'internal_only',
  requires_auth_level: 'trusted_internal',
  requires_confirmation: false,
};

function mkRow(usage_policy: unknown): Record<string, unknown> {
  return {
    id: 'skill-1',
    tenant_id: 'default',
    agent_id: null,
    skill_descriptor: 'daily_business_summary',
    category: 'compose',
    execution_mode: 'prompt_only',
    goal: 'summary',
    when_to_use: 'when owner asks',
    procedure: {},
    constraints: [],
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
    allowed_tools: [],
    policy_descriptors: [],
    success_criteria: [],
    failure_modes: [],
    runtime_hints: {},
    usage_policy,
    status: 'active',
    version: 1,
    proposed_by: 'system',
    proposed_reason: null,
    approved_by: 'system',
    approved_at: new Date(),
    activated_at: new Date(),
    deprecated_at: null,
    rolled_back_at: null,
    rollback_reason: null,
    created_at: new Date(),
  };
}

const ownerAudience: NonNullable<SkillExecutionInput['audience']> = {
  audience_type: 'owner',
  trust_level: 'trusted_internal',
  channel_type: 'whatsapp',
  allowed_data_scope: [
    'internal_business_summary',
    'financial_summary',
    'operations_summary',
    'own_customer_data_only',
    'public_info',
  ],
};
const customerAudience: NonNullable<SkillExecutionInput['audience']> = {
  audience_type: 'customer',
  trust_level: 'known_external',
  channel_type: 'whatsapp',
  allowed_data_scope: ['own_customer_data_only', 'public_info'],
};

function run(audience?: SkillExecutionInput['audience']) {
  return runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, () =>
    runSkill({
      skill_descriptor: 'daily_business_summary',
      input: {},
      triggered_by: 'user_message',
      expected_skill_id: 'skill-1',
      expected_skill_version: 1,
      ...(audience ? { audience } : {}),
    }),
  );
}

beforeEach(() => {
  auditMock.mockClear();
  skillRowState.row = mkRow(DAILY_BUSINESS_SUMMARY);
});

describe('SkillRunner gate 4.6 — usage-policy execution re-check (#409)', () => {
  it('ALLOWS an owner and runs the skill (skill_allowed audited)', async () => {
    const r = await run(ownerAudience);
    expect(r.ok).toBe(true);
    expect(auditMock.mock.calls.some((c) => c[0].acao === 'skill_allowed')).toBe(true);
  });

  it('BLOCKS a customer with reason audience_blocked (fail-closed, audited)', async () => {
    const r = await run(customerAudience);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('audience_blocked');
    const blocked = auditMock.mock.calls.find(
      (c) => c[0].acao === 'skill_blocked_by_audience',
    );
    expect(blocked).toBeTruthy();
    expect(blocked?.[0].metadata.enforcement_point).toBe('skill_runner_gate_4_6');
  });

  it('BLOCKS on data_scope when the skill exceeds the audience-allowed classes', async () => {
    // A skill that allows customer but declares financial_summary; the customer
    // audience may only receive own_customer_data_only/public_info.
    skillRowState.row = mkRow({
      allowed_audience: ['customer'],
      data_scope: ['financial_summary'],
      exposure_policy: 'subject_only',
      requires_auth_level: 'known_external',
      requires_confirmation: false,
    });
    const r = await run(customerAudience);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('data_scope_blocked');
    expect(
      auditMock.mock.calls.some((c) => c[0].acao === 'skill_blocked_by_data_scope'),
    ).toBe(true);
  });

  it('BLOCKS on channel when the turn channel is not allowed', async () => {
    skillRowState.row = mkRow({
      allowed_audience: ['owner'],
      allowed_channels: ['whatsapp'],
      data_scope: ['internal_business_summary'],
      exposure_policy: 'internal_only',
      requires_auth_level: 'trusted_internal',
      requires_confirmation: false,
    });
    const r = await run({ ...ownerAudience, channel_type: 'web' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('channel_blocked');
  });

  it('fails CLOSED on a malformed usage_policy (audience_blocked)', async () => {
    skillRowState.row = mkRow({ allowed_audience: [] });
    const r = await run(ownerAudience);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('audience_blocked');
  });

  it('a NULL usage_policy uses the conservative default — owner runs, customer blocked', async () => {
    skillRowState.row = mkRow(null);
    const ownerRun = await run(ownerAudience);
    expect(ownerRun.ok).toBe(true);

    skillRowState.row = mkRow(null);
    const customerRun = await run(customerAudience);
    expect(customerRun.ok).toBe(false);
    expect(customerRun.reason).toBe('audience_blocked');
  });

  it('gate 4.6 is SKIPPED when no audience is supplied (legacy callers run)', async () => {
    skillRowState.row = mkRow(DAILY_BUSINESS_SUMMARY);
    const r = await run(); // no audience
    expect(r.ok).toBe(true);
    // No usage-policy audit emitted at the runner.
    expect(
      auditMock.mock.calls.some((c) => String(c[0].acao).startsWith('skill_')),
    ).toBe(false);
  });
});
