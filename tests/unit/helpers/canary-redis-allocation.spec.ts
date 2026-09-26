import { describe, expect, it } from 'vitest';
import {
  readCanaryRedisAllocation,
  validateCanaryRedisAllocation,
} from '../../helpers/canary-redis-allocation.js';

const allocation = {
  version: 1,
  status: 'reserved',
  owner: 'hermes-environment-integration-fixes/worktree-canary',
  uid: 1006,
  worktree: '/srv/agents/worktrees/hermes-environment-integration-fixes',
  scope: 'test-only-worktree-canary',
  destinations: ['redis://127.0.0.1:6382/3', 'redis://127.0.0.1:6382/4'],
};

describe('explicit live canary Redis allocation guard', () => {
  it('rejects absent operator reservation even when worktree scope is on', () => {
    expect(() => readCanaryRedisAllocation({ TEST_WORKTREE_SCOPE: 'on' })).toThrow('BLOCKED');
  });

  it('rejects an arbitrary worker-selected reservation path before reading it', () => {
    expect(() =>
      readCanaryRedisAllocation({ TEST_CANARY_REDIS_ALLOCATION: '/worker/allocation.json' }),
    ).toThrow('BLOCKED');
  });
  it('accepts the two distinct reserved destinations without deriving or borrowing slots', () => {
    expect(validateCanaryRedisAllocation(allocation)).toEqual([
      'redis://127.0.0.1:6382/3',
      'redis://127.0.0.1:6382/4',
    ]);
  });

  it.each([
    undefined,
    null,
    {},
    { ...allocation, destinations: [allocation.destinations[0]] },
    { ...allocation, destinations: [allocation.destinations[0], allocation.destinations[0]] },
    { ...allocation, destinations: ['redis://127.0.0.1:6382/1', allocation.destinations[1]] },
    { ...allocation, destinations: ['redis://127.0.0.1:6382/2', allocation.destinations[1]] },
    { ...allocation, destinations: ['redis://127.0.0.1:6382/0', allocation.destinations[1]] },
    { ...allocation, destinations: ['redis://127.0.0.1:6382/5', allocation.destinations[1]] },
    { ...allocation, destinations: ['redis://prod.example:6382/3', allocation.destinations[1]] },
    { ...allocation, destinations: ['redis://127.0.0.1:6379/3', allocation.destinations[1]] },
    { ...allocation, status: 'released' },
    { ...allocation, owner: 'another-card' },
    { ...allocation, scope: 'production' },
    { ...allocation, uid: 0 },
  ])('rejects absent, single, duplicate, unallocated or conflicting allocation %#', (invalid) => {
    expect(() => validateCanaryRedisAllocation(invalid)).toThrow('BLOCKED');
  });
});
