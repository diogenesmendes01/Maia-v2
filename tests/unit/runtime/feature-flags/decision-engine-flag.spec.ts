import { describe, it, expect, vi } from 'vitest';
import {
  isDecisionEngineV1Enabled,
  type TenantFeatureFlagsRepo,
} from '@/runtime/feature-flags/decision-engine-flag.js';

describe('P9b — FEATURE_DECISION_ENGINE_V1 flag', () => {
  it('returns false by default when no env or override', async () => {
    const enabled = await isDecisionEngineV1Enabled('tn1', { env: {} });
    expect(enabled).toBe(false);
  });

  it('returns true when FEATURE_DECISION_ENGINE_V1=true and no kill switch', async () => {
    const enabled = await isDecisionEngineV1Enabled('tn1', {
      env: { FEATURE_DECISION_ENGINE_V1: 'true' },
    });
    expect(enabled).toBe(true);
  });

  it('kill switch overrides global ON', async () => {
    const enabled = await isDecisionEngineV1Enabled('tn1', {
      env: {
        FEATURE_DECISION_ENGINE_V1: 'true',
        FEATURE_DECISION_ENGINE_V1_KILL_SWITCH: 'true',
      },
    });
    expect(enabled).toBe(false);
  });

  it('tenant override true wins over default false', async () => {
    const repo: TenantFeatureFlagsRepo = {
      getOverride: vi.fn().mockResolvedValue(true),
    };
    const enabled = await isDecisionEngineV1Enabled('tn1', {
      env: {},
      tenantFeatureFlagsRepo: repo,
    });
    expect(enabled).toBe(true);
    expect(repo.getOverride).toHaveBeenCalledWith('tn1', 'decision_engine_v1');
  });

  it('tenant override false wins over global ON', async () => {
    const repo: TenantFeatureFlagsRepo = {
      getOverride: vi.fn().mockResolvedValue(false),
    };
    const enabled = await isDecisionEngineV1Enabled('tn1', {
      env: { FEATURE_DECISION_ENGINE_V1: 'true' },
      tenantFeatureFlagsRepo: repo,
    });
    expect(enabled).toBe(false);
  });

  it('tenant override null falls through to env', async () => {
    const repo: TenantFeatureFlagsRepo = {
      getOverride: vi.fn().mockResolvedValue(null),
    };
    const enabled = await isDecisionEngineV1Enabled('tn1', {
      env: { FEATURE_DECISION_ENGINE_V1: 'true' },
      tenantFeatureFlagsRepo: repo,
    });
    expect(enabled).toBe(true);
  });

  it('repo error swallowed; falls through to env', async () => {
    const repo: TenantFeatureFlagsRepo = {
      getOverride: vi.fn().mockRejectedValue(new Error('db down')),
    };
    const enabled = await isDecisionEngineV1Enabled('tn1', {
      env: { FEATURE_DECISION_ENGINE_V1: 'true' },
      tenantFeatureFlagsRepo: repo,
    });
    expect(enabled).toBe(true);
  });

  it('kill switch active even when tenant override true', async () => {
    const repo: TenantFeatureFlagsRepo = {
      getOverride: vi.fn().mockResolvedValue(true),
    };
    const enabled = await isDecisionEngineV1Enabled('tn1', {
      env: { FEATURE_DECISION_ENGINE_V1_KILL_SWITCH: 'true' },
      tenantFeatureFlagsRepo: repo,
    });
    expect(enabled).toBe(false);
  });
});
