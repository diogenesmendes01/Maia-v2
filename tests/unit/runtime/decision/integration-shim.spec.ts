import { describe, it, expect, vi } from 'vitest';
import { runDecisionEngineIfEnabled } from '@/runtime/decision/integration.ts';
import type { CreateDecisionEngineEnv } from '@/runtime/decision/index.js';
import type {
  ChannelPoliciesReader,
  ContentResolver,
  HaikuClient,
  LockdownReader,
  MetricsClient,
  PolicyDescriptorResolver,
  PolicyEvaluator,
  PolicyRulesRepo,
  ProceduresRepo,
  SkillsRepo,
} from '@/runtime/decision/types.js';
import type { BaseContextPacket } from '@/runtime/context-packet/types.js';

function mkBase(): BaseContextPacket {
  return {
    trace_id: 't_shim_1',
    tenant_id: 'tn_shim',
    agent_id: 'ag1',
    channel: { id: 'ch1', kind: 'whatsapp', is_locked_down: false },
    actor: { id: 'a1', is_authenticated: true },
    input: { content_ref: 'cref', received_at: new Date() },
  };
}

function mkEnv(overrides?: Partial<CreateDecisionEngineEnv>): CreateDecisionEngineEnv {
  const resolver: PolicyDescriptorResolver = {
    resolveDescriptors: vi.fn().mockResolvedValue([]),
  };
  const policyEvaluator: PolicyEvaluator = {
    evaluate: vi.fn().mockResolvedValue({ action: 'allow', reason: 'ok' }),
  };
  const policyRepo: PolicyRulesRepo = {
    getBody: vi.fn().mockResolvedValue(null),
    getBodySync: vi.fn().mockReturnValue(null),
  };
  const skillsRepo: SkillsRepo = {
    findActive: vi.fn().mockResolvedValue([
      { id: 'skill_x', category: 'respond', priority: 1, status: 'active' },
    ]),
    find: vi.fn().mockResolvedValue({
      id: 'skill_x',
      category: 'respond',
      priority: 1,
      status: 'active',
    }),
  };
  const channelPolicies: ChannelPoliciesReader = {
    getForChannel: vi.fn().mockResolvedValue({
      channel_id: 'ch1',
      tenant_id: 'tn_shim',
      default_agent_id: 'agent_default',
    }),
  };
  const lockdownReader: LockdownReader = {
    isChannelLockedDown: vi.fn().mockResolvedValue(false),
    isTenantInGlobalLockdown: vi.fn().mockResolvedValue(false),
    tenantHasSensitiveContext: vi.fn().mockResolvedValue(false),
  };
  const proceduresRepo: ProceduresRepo = {
    findExecution: vi.fn().mockResolvedValue(null),
  };
  const contentResolver: ContentResolver = {
    text: vi.fn().mockResolvedValue('olá!'),
  };
  const haiku: HaikuClient = {
    classify: vi.fn().mockResolvedValue({ label: 'unknown', confidence: 0.5 }),
  };
  return {
    resolver,
    policyEvaluator,
    policyRepo,
    skillsRepo,
    channelPolicies,
    lockdownReader,
    proceduresRepo,
    contentResolver,
    haiku,
    ...overrides,
  };
}

describe('P11 — runDecisionEngineIfEnabled shim (always-on)', () => {
  it('returns engine_ran=true with packet (engine always runs)', async () => {
    const r = await runDecisionEngineIfEnabled(mkBase(), mkEnv());
    expect(r.engine_ran).toBe(true);
    expect(r.result?.packet).toBeDefined();
    expect(r.result?.packet.trace_id).toBe('t_shim_1');
  });

  it('returns engine_ran=false with engine_error when engine throws', async () => {
    const failingResolver: PolicyDescriptorResolver = {
      resolveDescriptors: vi.fn().mockRejectedValue(new Error('resolver crashed')),
    };
    const metrics: MetricsClient = {
      increment: vi.fn(),
      recordHistogram: vi.fn(),
    };
    const r = await runDecisionEngineIfEnabled(
      mkBase(),
      mkEnv({ resolver: failingResolver }),
      metrics,
    );
    expect(r.engine_ran).toBe(false);
    expect(r.skip_reason).toBe('engine_error');
    expect(metrics.increment).toHaveBeenCalledWith(
      'decision_engine.error_fallback',
    );
  });
});
