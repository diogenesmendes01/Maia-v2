import { describe, expect, it } from 'vitest';
import { validateCanaryRedisAllocation } from '../../helpers/canary-redis-allocation.js';
const path = '/srv/agents/runtime/global-canary-redis-allocation.json';
const allocation = {
  version: 1, status: 'reserved', uid: 1006,
  owner: 'global-release-20260927/worktree-canary',
  worktree: '/srv/agents/worktrees/global-release-environment',
  scope: 'test-only-worktree-canary',
  destinations: ['redis://127.0.0.1:6384/87', 'redis://127.0.0.1:6384/88'],
};
describe('dedicated global release canary reservation', () => {
  it('accepts only the newly authorized dedicated pair', () => {
    expect(validateCanaryRedisAllocation(allocation, path)).toEqual(allocation.destinations);
  });
  it.each([
    '/srv/agents/repos/Maia-v2/.worktrees/t_87c1dacb',
    '/srv/agents/repos/Maia-v2/.worktrees/t_87c1dacb-qa',
    '/srv/agents/repos/Maia-v2/.worktrees/t_2285d249',
    '/srv/agents/repos/Maia-v2/.worktrees/t_2285d249-qa',
  ])('accepts an explicitly allocated priority role worktree %s', worktree => {
    expect(validateCanaryRedisAllocation({...allocation,worktree},path)).toEqual(allocation.destinations);
  });
  it.each([
    { worktree: '/srv/agents/repos/Maia-v2/.worktrees/t_06b0a49a' },
    { owner: 'parallel-wave-20260926/worktree-canary' },
    { worktree: '/worker/invented' }, { uid: 0 }, { status: 'released' },
    { allowed_worktrees: [allocation.worktree, '/worker/foreign'] },
    { destinations: ['redis://127.0.0.1:6383/9','redis://127.0.0.1:6383/10'] },
    ...[0,1,2,86,89,127,128].map(db => ({destinations: [`redis://127.0.0.1:6384/${db}`, allocation.destinations[1]]})),
  ])('rejects mismatched global identity %#', override => {
    expect(() => validateCanaryRedisAllocation({...allocation,...override},path)).toThrow('BLOCKED');
  });
  it.each(['/worker/copy.json','/srv/agents/runtime/wip3-canary-redis-allocation.json'])('refuses another manifest path %s', wrong => {
    expect(() => validateCanaryRedisAllocation(allocation, wrong)).toThrow('BLOCKED');
  });
});
