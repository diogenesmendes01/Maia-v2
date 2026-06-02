/**
 * P9a Task 7 — skill-proposer detector tests.
 *
 * Verifica:
 *  - Flag-off → { proposed: 0 }
 *  - Pattern com ≥3 ocorrências → propõe via capability_proposals
 *  - Pattern já tendo skill ativa → skipped++
 *  - Tenant context aplicado (mock retorna current tenant)
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
      ...actual.skillsRepo,
      findActive: vi.fn(),
    },
    capabilityProposalsRepo: {
      ...actual.capabilityProposalsRepo,
      create: vi.fn(),
    },
  };
});

vi.mock('@/cognition/runner.js', () => ({
  runCognitiveModule: vi.fn(async (_opts: any, fn: any) => {
    try {
      const out = await fn();
      return { output: out, status: 'success', fallback_triggered: false, latency_ms: 1 };
    } catch {
      return { output: null, status: 'error', fallback_triggered: true, latency_ms: 1 };
    }
  }),
}));

// Mock the schema-level db module so scanForSkillPatterns returns canned rows.
// vi.mock factories are hoisted; reference to outer vars is forbidden.
// We expose a setter via a separate module-level holder.
vi.mock('@/db/client.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/client.js')>('@/db/client.js');
  const mockDb: any = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockResolvedValue([]),
  };
  return { ...actual, db: mockDb };
});

// Get a handle to the mocked db after the factory has run.
async function getMockDb(): Promise<any> {
  const mod = await import('@/db/client.js');
  return mod.db;
}

import { detectAndProposeSkill, scanForSkillPatterns } from '@/cognition/skill-proposer.js';
import { featureFlags } from '@/config/feature-flags.js';
import { skillsRepo, capabilityProposalsRepo } from '@/db/repositories.js';

describe('detectAndProposeSkill', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(featureFlags.isEnabled).mockReturnValue(true);
    vi.mocked(skillsRepo.findActive).mockResolvedValue(null);
    vi.mocked(capabilityProposalsRepo.create).mockResolvedValue({ id: 'prop-1' } as any);
    const mockDb = await getMockDb();
    mockDb.select.mockReturnThis();
    mockDb.from.mockReturnThis();
    mockDb.where.mockReturnThis();
    mockDb.groupBy.mockResolvedValue([
      { module_name: 'classify_msg', occurrences: 5 },
      { module_name: 'extract_amount', occurrences: 2 },
      { module_name: 'skill:already_existing', occurrences: 10 },
      { module_name: 'reflector', occurrences: 4 },
    ]);
  });


  it('proposes skills for patterns above threshold and not already active', async () => {
    const result = await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => detectAndProposeSkill({ window_days: 7 }),
    );
    // patterns: classify_msg (5), reflector (4) — extract_amount filtered (2 < 3),
    // skill:already_existing filtered (skill: prefix)
    expect(result.patterns_found).toBe(2);
    expect(result.proposed).toBe(2);
    expect(capabilityProposalsRepo.create).toHaveBeenCalledTimes(2);
    expect(capabilityProposalsRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ capability_type: 'skill' }),
    );
  });

  it('skips when skill with same descriptor already active', async () => {
    vi.mocked(skillsRepo.findActive).mockResolvedValue({ id: 'existing' } as any);
    const result = await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => detectAndProposeSkill({ window_days: 7 }),
    );
    expect(result.proposed).toBe(0);
    expect(result.skipped).toBe(2);
  });
});

describe('scanForSkillPatterns', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const mockDb = await getMockDb();
    mockDb.select.mockReturnThis();
    mockDb.from.mockReturnThis();
    mockDb.where.mockReturnThis();
    mockDb.groupBy.mockResolvedValue([
      { module_name: 'mod_a', occurrences: 10 },
      { module_name: 'mod_b', occurrences: 1 },
      { module_name: 'mod_c', occurrences: 3 },
    ]);
  });

  it('filters patterns under MIN_PATTERN_OCCURRENCES (3)', async () => {
    const patterns = await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => scanForSkillPatterns({ window_days: 7 }),
    );
    expect(patterns.length).toBe(2); // mod_a, mod_c (mod_b dropped)
  });

  it('orders by occurrences desc', async () => {
    const patterns = await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => scanForSkillPatterns({ window_days: 7 }),
    );
    expect(patterns[0]!.occurrences).toBe(10);
    expect(patterns[1]!.occurrences).toBe(3);
  });

  it('produces suggested_descriptor (snake_case from module_name)', async () => {
    const patterns = await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => scanForSkillPatterns({ window_days: 7 }),
    );
    expect(patterns[0]!.suggested_descriptor).toBe('mod_a');
  });
});
