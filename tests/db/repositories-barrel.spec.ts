/**
 * Barrel completeness test for src/db/repositories.ts.
 *
 * Prevents the silent `undefined` runtime error that bit PR #98 and PR #102:
 * a repo is defined inline in repositories.ts but accidentally missed during
 * refactors or was never re-exported from a sub-barrel.
 *
 * This is NOT an integration test — no DB connection is made. It only verifies
 * that named exports are present and shaped correctly.
 *
 * Issue #113: capabilityProposalsRepo was found to be undefined at runtime in
 * some import contexts even though it is defined in repositories.ts. This test
 * locks the export surface so future refactors cannot silently break it.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(() => []) })) })),
    })),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn(async () => []) })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => []) })) })) })),
    delete: vi.fn(() => ({ where: vi.fn(async () => []) })),
  },
  withTx: vi.fn(),
}));

vi.mock('../../src/db/tenant-context.js', () => ({
  getCurrentTenant: vi.fn(() => 'default'),
  getCurrentAgent: vi.fn(() => 'default'),
}));

vi.mock('../../src/db/tenant-guard.js', () => ({
  applyTenantGuard: vi.fn((v: unknown) => v),
}));

vi.mock('@/control-plane/skill-registry/index.js', () => ({
  skillsRepo: {
    propose: vi.fn(),
    getById: vi.fn(),
    listActive: vi.fn(),
    transition: vi.fn(),
  },
}));

describe('repositories barrel — export completeness', () => {
  it('capabilityProposalsRepo is exported and not undefined', async () => {
    const barrel = await import('../../src/db/repositories.js');
    expect(barrel.capabilityProposalsRepo).toBeDefined();
    expect(typeof barrel.capabilityProposalsRepo).toBe('object');
  });

  it('capabilityProposalsRepo exposes the required methods', async () => {
    const { capabilityProposalsRepo } = await import('../../src/db/repositories.js');
    const requiredMethods = ['create', 'createTx', 'getById', 'listByStatus', 'transition'];
    for (const method of requiredMethods) {
      expect(
        typeof capabilityProposalsRepo[method as keyof typeof capabilityProposalsRepo],
        `capabilityProposalsRepo.${method} should be a function`,
      ).toBe('function');
    }
  });

  it('key repos are all exported and not undefined', async () => {
    const barrel = await import('../../src/db/repositories.js');
    const requiredRepos = [
      'pessoasRepo',
      'conversasRepo',
      'mensagensRepo',
      'factsRepo',
      'auditRepo',
      'capabilityProposalsRepo',
      'capabilitiesDomainRepo',
      'capabilitiesSkillRepo',
      'capabilityGapsRepo',
      'operationalProfileVersionsRepo',
      'driftAlertsRepo',
      'channelsRepo',
      'channelPoliciesRepo',
      'procedureDefinitionsRepo',
      'procedureExecutionsRepo',
    ] as const;

    for (const repoName of requiredRepos) {
      expect(
        barrel[repoName],
        `${repoName} should be exported from @/db/repositories`,
      ).toBeDefined();
    }
  });
});
