/**
 * P9a Task 5 — SkillRunner 7-gate flow tests.
 *
 * Mocks: feature flag, skillsRepo.findActive, runCognitiveModule wrapper,
 * policyDescriptorResolver, mode handlers. Each gate is exercised in
 * isolation; the final test exercises the full happy path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';

vi.mock('@/config/feature-flags.js', () => ({
  featureFlags: { isEnabled: vi.fn(() => true) },
}));

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
    '@/db/repositories.js',
  );
  return {
    ...actual,
    skillsRepo: {
      findActive: vi.fn(async () => null),
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

vi.mock('@/cognition/runner.js', async () => {
  const actual = await vi.importActual<typeof import('@/cognition/runner.js')>(
    '@/cognition/runner.js',
  );
  return {
    ...actual,
    // Pass-through wrapper: runs fn directly, captures status.
    runCognitiveModule: vi.fn(async (_opts: any, fn: any) => {
      try {
        const out = await fn();
        return { output: out, status: 'success', fallback_triggered: false, latency_ms: 1 };
      } catch (err) {
        const e = err as Error;
        if (e.message === 'timeout') {
          return { output: null, status: 'timeout', fallback_triggered: true, latency_ms: 1 };
        }
        return { output: null, status: 'error', fallback_triggered: true, latency_ms: 1 };
      }
    }),
  };
});

vi.mock('@/control-plane/policy/policy-descriptor-resolver.js', () => ({
  policyDescriptorResolver: {
    resolveDescriptors: vi.fn(async () => ({ resolved: [], unresolved: [] })),
  },
}));

vi.mock('@/skills/modes/prompt-only.js', () => ({
  promptOnlyMode: vi.fn(async () => ({ classification: 'positive', confidence: 0.9 })),
  parseJsonResponse: vi.fn(),
}));

vi.mock('@/skills/modes/procedure-adapter.js', () => ({
  procedureAdapterMode: vi.fn(async () => ({ procedure_execution_id: 'exec-1' })),
}));

vi.mock('@/skills/modes/tool-mediated.js', () => ({
  toolMediatedMode: vi.fn(async () => ({ ok: true })),
  setToolDispatcher: vi.fn(),
}));

vi.mock('@/skills/modes/evaluator.js', () => ({
  evaluatorMode: vi.fn(async () => ({ score: 0.8, verdict: 'pass', reasons: ['ok'] })),
  parseEvaluatorOutput: vi.fn(),
}));

import { runSkill, validateAgainstSchema, applyPoliciesPreSkill } from '@/skills/skill-runner.js';
import { featureFlags } from '@/config/feature-flags.js';
import { skillsRepo } from '@/db/repositories.js';
import { policyDescriptorResolver } from '@/control-plane/policy/policy-descriptor-resolver.js';
import { promptOnlyMode } from '@/skills/modes/prompt-only.js';

const baseSkillRow = {
  id: 'skill-1',
  tenant_id: 'default',
  agent_id: null,
  skill_descriptor: 'detect_legal_risk',
  category: 'classify',
  execution_mode: 'prompt_only',
  goal: 'Detectar risco jurídico',
  when_to_use: 'Sempre',
  procedure: { system_prompt: 'X' },
  constraints: [],
  input_schema: { type: 'object' },
  output_schema: { type: 'object' },
  allowed_tools: [],
  policy_descriptors: [],
  success_criteria: [],
  failure_modes: [],
  runtime_hints: {},
  status: 'active',
  version: 1,
  proposed_by: 'test',
  proposed_reason: null,
  approved_by: 'owner',
  approved_at: new Date(),
  activated_at: new Date(),
  deprecated_at: null,
  rolled_back_at: null,
  rollback_reason: null,
  created_at: new Date(),
};

describe('SkillRunner — 7-gate flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: flag ON, no skill found
    vi.mocked(featureFlags.isEnabled).mockReturnValue(true);
    vi.mocked(skillsRepo.findActive).mockResolvedValue(null);
    vi.mocked(policyDescriptorResolver.resolveDescriptors).mockResolvedValue({
      resolved: [],
      unresolved: [],
    });
    vi.mocked(promptOnlyMode).mockResolvedValue({ classification: 'ok' });
  });

  it('Gate 1: returns flag_off when feature flag disabled', async () => {
    vi.mocked(featureFlags.isEnabled).mockReturnValue(false);
    const result = await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () =>
        runSkill({
          skill_descriptor: 'x',
          input: {},
          triggered_by: 'user_message',
        }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('flag_off');
  });

  it('Gate 2: returns skill_not_found when skillsRepo returns null', async () => {
    vi.mocked(skillsRepo.findActive).mockResolvedValue(null);
    const result = await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () =>
        runSkill({ skill_descriptor: 'unknown', input: {}, triggered_by: 'user_message' }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('skill_not_found');
  });

  it('Gate 3: returns invalid_input when input fails schema', async () => {
    vi.mocked(skillsRepo.findActive).mockResolvedValue({
      ...baseSkillRow,
      input_schema: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
    } as any);
    const result = await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () =>
        runSkill({
          skill_descriptor: 'x',
          input: { wrong_field: 'value' },
          triggered_by: 'user_message',
        }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid_input');
    expect(result.message).toContain('missing required field: name');
  });

  it('Gate 4: invokes policyDescriptorResolver with declared descriptors', async () => {
    vi.mocked(skillsRepo.findActive).mockResolvedValue({
      ...baseSkillRow,
      policy_descriptors: ['lgpd_strict', 'pii_redaction'],
    } as any);
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () =>
      runSkill({ skill_descriptor: 'x', input: {}, triggered_by: 'user_message' }),
    );
    expect(vi.mocked(policyDescriptorResolver.resolveDescriptors)).toHaveBeenCalledWith(
      expect.objectContaining({
        descriptors: ['lgpd_strict', 'pii_redaction'],
        scope: { skill_category: 'classify' },
      }),
    );
  });

  it('Gate 4.5: returns policy_blocked when policy effect=block', async () => {
    vi.mocked(skillsRepo.findActive).mockResolvedValue(baseSkillRow as any);
    vi.mocked(policyDescriptorResolver.resolveDescriptors).mockResolvedValue({
      resolved: [
        {
          policy_id: 'policy-block',
          descriptor: 'critical',
          effect: 'block',
          reason: 'governance hold',
        },
      ],
      unresolved: [],
    });
    const result = await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () =>
        runSkill({ skill_descriptor: 'x', input: {}, triggered_by: 'user_message' }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('policy_blocked');
    expect(result.resolved_policies).toContain('policy-block');
  });

  it('Gate 6/7: happy path — wraps in runCognitiveModule, returns output', async () => {
    vi.mocked(skillsRepo.findActive).mockResolvedValue(baseSkillRow as any);
    vi.mocked(promptOnlyMode).mockResolvedValue({ classification: 'positive', confidence: 0.9 });
    const result = await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () =>
        runSkill({ skill_descriptor: 'x', input: { msg: 'hi' }, triggered_by: 'user_message' }),
    );
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ classification: 'positive', confidence: 0.9 });
    expect(result.trace.mode).toBe('prompt_only');
    expect(result.trace.skill_id).toBe('skill-1');
    expect(result.trace.skill_version).toBe(1);
  });

  it('Gate 7: returns invalid_output when mode output fails output_schema', async () => {
    vi.mocked(skillsRepo.findActive).mockResolvedValue({
      ...baseSkillRow,
      output_schema: {
        type: 'object',
        required: ['classification'],
        properties: { classification: { type: 'string' } },
      },
    } as any);
    vi.mocked(promptOnlyMode).mockResolvedValue({ wrong_field: 'data' });
    const result = await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () =>
        runSkill({ skill_descriptor: 'x', input: {}, triggered_by: 'user_message' }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid_output');
    expect(result.message).toContain('missing required field: classification');
  });

  it('returns executor_error when mode handler throws', async () => {
    vi.mocked(skillsRepo.findActive).mockResolvedValue(baseSkillRow as any);
    vi.mocked(promptOnlyMode).mockRejectedValue(new Error('llm_failure'));
    const result = await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () =>
        runSkill({ skill_descriptor: 'x', input: {}, triggered_by: 'user_message' }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('executor_error');
  });

  it('returns timeout when execution exceeds timeout_ms', async () => {
    vi.mocked(skillsRepo.findActive).mockResolvedValue({
      ...baseSkillRow,
      runtime_hints: { timeout_ms: 50 },
    } as any);
    vi.mocked(promptOnlyMode).mockRejectedValue(new Error('timeout'));
    const result = await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () =>
        runSkill({ skill_descriptor: 'x', input: {}, triggered_by: 'user_message' }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('timeout');
  });
});

describe('validateAgainstSchema', () => {
  it('valid=true if schema empty', () => {
    expect(validateAgainstSchema({ foo: 'bar' }, {})).toEqual({ valid: true, errors: [] });
  });

  it('valid=true if data is object and schema permissive', () => {
    expect(validateAgainstSchema({ foo: 'bar' }, { type: 'object' }).valid).toBe(true);
  });

  it('valid=false if required missing', () => {
    const r = validateAgainstSchema({}, { type: 'object', required: ['name'] });
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain('missing required field: name');
  });

  it('valid=false if property type mismatch', () => {
    const r = validateAgainstSchema(
      { age: 'twenty' },
      { type: 'object', properties: { age: { type: 'number' } } },
    );
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain('expected number, got string');
  });
});

describe('applyPoliciesPreSkill', () => {
  it('allow when no policies', () => {
    expect(applyPoliciesPreSkill([])).toEqual({ decision: 'allow' });
  });

  it('allow when all effects are noop/audit/allow', () => {
    expect(
      applyPoliciesPreSkill([
        { policy_id: 'p1', descriptor: 'a', effect: 'allow' },
        { policy_id: 'p2', descriptor: 'b', effect: 'audit' },
        { policy_id: 'p3', descriptor: 'c', effect: 'noop' },
      ]),
    ).toEqual({ decision: 'allow' });
  });

  it('block when any effect is block', () => {
    expect(
      applyPoliciesPreSkill([
        { policy_id: 'p1', descriptor: 'a', effect: 'allow' },
        { policy_id: 'p2', descriptor: 'b', effect: 'block', reason: 'lgpd' },
      ]),
    ).toEqual({ decision: 'block', reason: 'lgpd' });
  });
});
