import { describe, expect, it } from 'vitest';
import { validateCanaryRedisAllocation } from '../../helpers/canary-redis-allocation.js';

// Declared GitHub-hosted CI fixture, not a live runner/service execution.
const path = '/run/maia-ci-canary/allocation.json';
const env = {
  CI: 'true',
  GITHUB_ACTIONS: 'true',
  RUNNER_ENVIRONMENT: 'github-hosted',
  GITHUB_REPOSITORY: 'diogenesmendes01/Maia-v2',
  GITHUB_RUN_ID: '12345',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_JOB: 'integration',
  GITHUB_WORKSPACE: '/home/runner/work/Maia-v2/Maia-v2',
};
const allocation = {
  version: 1,
  status: 'reserved',
  owner: 'github-actions/diogenesmendes01/Maia-v2/12345/1/integration/worktree-canary',
  uid: process.getuid!(),
  worktree: env.GITHUB_WORKSPACE,
  allowed_worktrees: [env.GITHUB_WORKSPACE],
  scope: 'test-only-worktree-canary',
  destinations: ['redis://127.0.0.1:6379/13', 'redis://127.0.0.1:6379/14'],
};
describe('explicit ephemeral GitHub runner reservation', () => {
  it('accepts only its own job reservation and distinct dedicated slots', () => {
    expect(validateCanaryRedisAllocation(allocation, path, env)).toEqual(allocation.destinations);
  });
  it.each([
    ['missing CI', { CI: undefined }],
    ['not actions', { GITHUB_ACTIONS: 'false' }],
    ['persistent runner', { RUNNER_ENVIRONMENT: 'self-hosted' }],
    ['foreign repo', { GITHUB_REPOSITORY: 'another/repo' }],
    ['missing run', { GITHUB_RUN_ID: undefined }],
    ['bad run', { GITHUB_RUN_ID: '../1' }],
    ['missing attempt', { GITHUB_RUN_ATTEMPT: undefined }],
    ['other attempt', { GITHUB_RUN_ATTEMPT: '2' }],
    ['other job', { GITHUB_JOB: 'e2e' }],
    ['other workspace', { GITHUB_WORKSPACE: '/home/runner/work/other/other' }],
    ['VPS workspace', { GITHUB_WORKSPACE: '/srv/agents/repos/Maia-v2' }],
  ])('rejects context %s', (_label, override) => {
    expect(() => validateCanaryRedisAllocation(allocation, path, { ...env, ...override })).toThrow(
      'BLOCKED',
    );
  });
  it.each([
    { version: 2 },
    { status: 'released' },
    { owner: 'parallel-wave-20260926/worktree-canary' },
    { uid: 8765 },
    { worktree: '/foreign' },
    { scope: 'production' },
    { allowed_worktrees: [] },
    { allowed_worktrees: [env.GITHUB_WORKSPACE, '/foreign'] },
    { destinations: undefined },
    { destinations: [allocation.destinations[0]] },
    { destinations: [allocation.destinations[0], allocation.destinations[0]] },
    ...[0, 1, 2, 3, 9, 10, 15, 16].map((db) => ({
      destinations: [`redis://127.0.0.1:6379/${db}`, allocation.destinations[1]],
    })),
    { destinations: [...allocation.destinations].reverse() },
    { destinations: ['redis://127.0.0.1:6383/9', 'redis://127.0.0.1:6383/10'] },
    { destinations: ['redis://remote:6379/13', allocation.destinations[1]] },
  ])('rejects a mismatched CI manifest %#', (override) => {
    expect(() => validateCanaryRedisAllocation({ ...allocation, ...override }, path, env)).toThrow(
      'BLOCKED',
    );
  });
  it.each([
    undefined,
    '/worker/allocation.json',
    '/run/maia-ci-canary/copy.json',
    '/srv/agents/runtime/wip3-canary-redis-allocation.json',
  ])('never borrows a VPS reservation or alternate path %s', (otherPath) => {
    expect(() => validateCanaryRedisAllocation(allocation, otherPath, env)).toThrow('BLOCKED');
  });
});
