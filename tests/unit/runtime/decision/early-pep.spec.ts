import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EarlyPepImpl, type EarlyPepDeps } from '@/runtime/decision/early-pep.ts';
import type {
  BlockDecision,
  ContinueDecision,
  PolicyEvaluator,
  PolicyRulesRepo,
  LockdownReader,
  ResolvedPolicy,
} from '@/runtime/decision/types.js';
import type { BaseContextPacket } from '@/runtime/context-packet/types.js';

function mkBase(overrides?: Partial<BaseContextPacket>): BaseContextPacket {
  return {
    trace_id: 't1',
    tenant_id: 'tn1',
    agent_id: 'ag1',
    channel: { id: 'ch1', kind: 'whatsapp', is_locked_down: false },
    actor: { id: 'a1', is_authenticated: true },
    input: { content_ref: 'cref', received_at: new Date('2026-05-15T10:00:00Z') },
    ...overrides,
  };
}

function mkDeps(overrides?: Partial<EarlyPepDeps>): EarlyPepDeps {
  const lockdownReader: LockdownReader = {
    isChannelLockedDown: vi.fn().mockResolvedValue(false),
    isTenantInGlobalLockdown: vi.fn().mockResolvedValue(false),
    tenantHasSensitiveContext: vi.fn().mockResolvedValue(false),
  };
  const policyRepo: PolicyRulesRepo = {
    getBody: vi.fn().mockResolvedValue(null),
    getBodySync: vi.fn().mockReturnValue(null),
  };
  const evaluator: PolicyEvaluator = {
    evaluate: vi.fn().mockResolvedValue({ action: 'allow', reason: 'default' }),
  };
  return { lockdownReader, policyRepo, evaluator, ...overrides };
}

describe('P9b — Early PEP', () => {
  beforeEach(() => vi.clearAllMocks());

  it('blocks if base.channel.is_locked_down=true (hardcoded short-circuit)', async () => {
    const deps = mkDeps();
    const pep = new EarlyPepImpl(deps);
    const result = await pep.evaluate({
      base: mkBase({ channel: { id: 'ch1', kind: 'whatsapp', is_locked_down: true } }),
      resolved_policies: [],
    });
    expect(result.pep).toBe('early');
    expect('decision' in result).toBe(true);
    const block = result as BlockDecision;
    expect(block.decision).toBe('block');
    expect(block.reason).toContain('lockdown');
    expect(block.severity).toBe('high');
    expect(deps.lockdownReader.isTenantInGlobalLockdown).not.toHaveBeenCalled();
  });

  it('blocks if tenant in global lockdown', async () => {
    const deps = mkDeps({
      lockdownReader: {
        isChannelLockedDown: vi.fn().mockResolvedValue(false),
        isTenantInGlobalLockdown: vi.fn().mockResolvedValue(true),
        tenantHasSensitiveContext: vi.fn().mockResolvedValue(false),
      },
    });
    const pep = new EarlyPepImpl(deps);
    const result = await pep.evaluate({
      base: mkBase(),
      resolved_policies: [],
    });
    expect((result as BlockDecision).decision).toBe('block');
    expect((result as BlockDecision).severity).toBe('critical');
    expect((result as BlockDecision).rule_descriptor).toBe(
      'tenant.lockdown.emergency',
    );
  });

  it('continues if no early policies apply', async () => {
    const deps = mkDeps();
    const pep = new EarlyPepImpl(deps);
    const result = await pep.evaluate({ base: mkBase(), resolved_policies: [] });
    expect(result.pep).toBe('early');
    expect('warnings' in result).toBe(true);
    expect((result as ContinueDecision).warnings).toEqual([]);
  });

  it('evaluates policies with applies_to_peps=["early"] only', async () => {
    const evaluator: PolicyEvaluator = {
      evaluate: vi.fn().mockResolvedValue({ action: 'allow', reason: 'ok' }),
    };
    const policyRepo: PolicyRulesRepo = {
      getBody: vi.fn().mockImplementation(async (id: string) => ({
        policy_id: id,
        descriptor: `desc.${id}`,
        applies_to_peps: ['early'],
      })),
      getBodySync: vi.fn().mockReturnValue(null),
    };
    const deps = mkDeps({ policyRepo, evaluator });

    const resolved: ResolvedPolicy[] = [
      { policy_id: 'p_early', descriptor: 'lgpd.no_action', applies_to_peps: ['early'] },
      { policy_id: 'p_mid', descriptor: 'mid.something', applies_to_peps: ['mid'] },
    ];
    const pep = new EarlyPepImpl(deps);
    await pep.evaluate({ base: mkBase(), resolved_policies: resolved });

    // Only the early policy should reach evaluator
    expect(evaluator.evaluate).toHaveBeenCalledTimes(1);
    expect(policyRepo.getBody).toHaveBeenCalledWith('p_early');
  });

  it('returns block if a policy evaluator returns block', async () => {
    const policyRepo: PolicyRulesRepo = {
      getBody: vi.fn().mockResolvedValue({
        policy_id: 'p_lgpd',
        descriptor: 'lgpd.no_action_for_unauthenticated',
        applies_to_peps: ['early'],
      }),
      getBodySync: vi.fn().mockReturnValue(null),
    };
    const evaluator: PolicyEvaluator = {
      evaluate: vi.fn().mockResolvedValue({
        action: 'block',
        reason: 'unauthenticated actor',
        severity: 'high',
        message: 'Por favor autentique-se primeiro.',
      }),
    };
    const deps = mkDeps({ policyRepo, evaluator });
    const pep = new EarlyPepImpl(deps);

    const result = await pep.evaluate({
      base: mkBase({ actor: { id: 'a1', is_authenticated: false } }),
      resolved_policies: [
        {
          policy_id: 'p_lgpd',
          descriptor: 'lgpd.no_action_for_unauthenticated',
          applies_to_peps: ['early'],
        },
      ],
    });

    const block = result as BlockDecision;
    expect(block.decision).toBe('block');
    expect(block.policy_id).toBe('p_lgpd');
    expect(block.reason).toContain('unauthenticated');
    expect(block.user_facing_message).toBe('Por favor autentique-se primeiro.');
  });

  it('accumulates warn_in_trace verdicts as warnings', async () => {
    const policyRepo: PolicyRulesRepo = {
      getBody: vi.fn().mockImplementation(async (id: string) => ({
        policy_id: id,
        descriptor: `desc.${id}`,
        applies_to_peps: ['early'],
      })),
      getBodySync: vi.fn().mockReturnValue(null),
    };
    const evaluator: PolicyEvaluator = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({
          action: 'warn_in_trace',
          reason: 'minor concern A',
        })
        .mockResolvedValueOnce({
          action: 'warn_in_trace',
          reason: 'minor concern B',
        }),
    };
    const deps = mkDeps({ policyRepo, evaluator });
    const pep = new EarlyPepImpl(deps);

    const result = await pep.evaluate({
      base: mkBase(),
      resolved_policies: [
        { policy_id: 'p1', descriptor: 'd1', applies_to_peps: ['early'] },
        { policy_id: 'p2', descriptor: 'd2', applies_to_peps: ['early'] },
      ],
    });

    expect('warnings' in result).toBe(true);
    expect((result as ContinueDecision).warnings).toHaveLength(2);
    expect((result as ContinueDecision).warnings[0]?.reason).toContain(
      'concern A',
    );
  });

  it('checks cached body via getBodySync when policy has no applies_to_peps', async () => {
    const policyRepo: PolicyRulesRepo = {
      getBody: vi.fn().mockResolvedValue(null),
      getBodySync: vi.fn().mockReturnValue({
        policy_id: 'p_cached',
        descriptor: 'd',
        applies_to_peps: ['early'],
      }),
    };
    const evaluator: PolicyEvaluator = {
      evaluate: vi.fn().mockResolvedValue({ action: 'allow', reason: 'ok' }),
    };
    const deps = mkDeps({ policyRepo, evaluator });
    const pep = new EarlyPepImpl(deps);

    await pep.evaluate({
      base: mkBase(),
      resolved_policies: [{ policy_id: 'p_cached', descriptor: 'd' }],
    });

    expect(policyRepo.getBodySync).toHaveBeenCalledWith('p_cached');
  });
});
