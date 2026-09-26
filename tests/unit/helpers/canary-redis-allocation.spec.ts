import { describe, expect, it } from 'vitest';
import {
  assertOperatorOwnedAllocationFile,
  readCanaryRedisAllocation,
  resolveAuthorizedReservationPath,
  validateCanaryRedisAllocation,
} from '../../helpers/canary-redis-allocation.js';

/** As duas reservas test-only que o operador autorizou explicitamente. */
const ORIGINAL_PATH = '/srv/agents/runtime/canary-redis-allocation.json';
const PILOT_PATH = '/srv/agents/runtime/pilot-canary-redis-allocation.json';

const original = {
  version: 1,
  status: 'reserved',
  owner: 'hermes-environment-integration-fixes/worktree-canary',
  uid: 1006,
  worktree: '/srv/agents/worktrees/hermes-environment-integration-fixes',
  scope: 'test-only-worktree-canary',
  destinations: ['redis://127.0.0.1:6382/3', 'redis://127.0.0.1:6382/4'],
};

/** Piloto WIP1: par próprio (7/8), sem tocar a reserva antiga de outro dono. */
const pilot = {
  version: 1,
  status: 'reserved',
  owner: 'native-pilot-20260926/worktree-canary',
  task_id: 't_21fcbc0f',
  uid: 1006,
  worktree: '/srv/agents/repos/Maia-v2/.worktrees/t_21fcbc0f',
  allowed_worktrees: [
    '/srv/agents/repos/Maia-v2/.worktrees/t_21fcbc0f',
    '/srv/agents/repos/Maia-v2/.worktrees/t_21fcbc0f-qa',
  ],
  scope: 'test-only-worktree-canary',
  destinations: ['redis://127.0.0.1:6382/7', 'redis://127.0.0.1:6382/8'],
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

  it('rejects a valid-looking copy of an authorized reservation placed at another path', () => {
    expect(() =>
      readCanaryRedisAllocation({
        TEST_CANARY_REDIS_ALLOCATION: '/tmp/pilot-canary-redis-allocation.json',
      }),
    ).toThrow('BLOCKED');
  });

  it.each([
    [ORIGINAL_PATH],
    [PILOT_PATH],
    ['/srv/agents/runtime/pilot-canary-redis-allocation-qa.json'],
    [''],
  ])('resolves an authorized runtime path and refuses %s when it is not one of them', (path) => {
    const authorized = [ORIGINAL_PATH, PILOT_PATH].includes(path);
    const resolve = () => resolveAuthorizedReservationPath(path);
    if (authorized) expect(resolve().path).toBe(path);
    else expect(resolve).toThrow('BLOCKED');
  });

  it('rejects a missing reservation path instead of deriving a reservation', () => {
    expect(() => resolveAuthorizedReservationPath(undefined)).toThrow('BLOCKED');
    expect(() => validateCanaryRedisAllocation(original)).toThrow('BLOCKED');
  });

  it('accepts the two distinct reserved destinations without deriving or borrowing slots', () => {
    expect(validateCanaryRedisAllocation(original, ORIGINAL_PATH)).toEqual([
      'redis://127.0.0.1:6382/3',
      'redis://127.0.0.1:6382/4',
    ]);
  });

  it('accepts the pilot reservation on its own runtime path', () => {
    expect(validateCanaryRedisAllocation(pilot, PILOT_PATH)).toEqual([
      'redis://127.0.0.1:6382/7',
      'redis://127.0.0.1:6382/8',
    ]);
  });

  it('accepts the independent QA worktree declared by the pilot reservation', () => {
    expect(
      validateCanaryRedisAllocation(
        { ...pilot, worktree: '/srv/agents/repos/Maia-v2/.worktrees/t_21fcbc0f-qa' },
        PILOT_PATH,
      ),
    ).toEqual(['redis://127.0.0.1:6382/7', 'redis://127.0.0.1:6382/8']);
  });

  it('rejects a reservation whose owner, path and pair do not belong together', () => {
    // O par do piloto não pode ser consumido pela reserva antiga, nem vice-versa.
    expect(() =>
      validateCanaryRedisAllocation(
        { ...original, destinations: pilot.destinations },
        ORIGINAL_PATH,
      ),
    ).toThrow('BLOCKED');
    expect(() =>
      validateCanaryRedisAllocation(
        { ...pilot, destinations: original.destinations },
        PILOT_PATH,
      ),
    ).toThrow('BLOCKED');
    // Conteúdo autorizado de uma reserva no caminho da outra.
    expect(() => validateCanaryRedisAllocation(pilot, ORIGINAL_PATH)).toThrow('BLOCKED');
    expect(() => validateCanaryRedisAllocation(original, PILOT_PATH)).toThrow('BLOCKED');
  });

  it('rejects a worktree that the reservation does not own', () => {
    expect(() =>
      validateCanaryRedisAllocation(
        { ...pilot, worktree: '/srv/agents/repos/Maia-v2/.worktrees/t_21fcbc0f-other' },
        PILOT_PATH,
      ),
    ).toThrow('BLOCKED');
    expect(() =>
      validateCanaryRedisAllocation(
        { ...pilot, allowed_worktrees: [...pilot.allowed_worktrees, '/worker/worktree'] },
        PILOT_PATH,
      ),
    ).toThrow('BLOCKED');
    expect(() =>
      validateCanaryRedisAllocation(
        { ...pilot, allowed_worktrees: ['/worker/worktree'] },
        PILOT_PATH,
      ),
    ).toThrow('BLOCKED');
  });

  it.each([original, pilot])('rejects absent, single, duplicate, unallocated or conflicting allocation %#', (valid) => {
    const path = valid === original ? ORIGINAL_PATH : PILOT_PATH;
    const [first, second] = valid.destinations;
    const invalid = [
      undefined,
      null,
      {},
      { ...valid, destinations: [first] },
      { ...valid, destinations: [first, first] },
      { ...valid, destinations: ['redis://127.0.0.1:6382/0', second] },
      { ...valid, destinations: ['redis://127.0.0.1:6382/1', second] },
      { ...valid, destinations: ['redis://127.0.0.1:6382/2', second] },
      { ...valid, destinations: ['redis://127.0.0.1:6382/5', second] },
      { ...valid, destinations: ['redis://prod.example:6382/7', second] },
      { ...valid, destinations: ['redis://127.0.0.1:6379/7', second] },
      { ...valid, destinations: ['redis://127.0.0.1:6382/7 ', second] },
      { ...valid, destinations: [first, 8] },
      { ...valid, status: 'released' },
      { ...valid, owner: 'another-card' },
      { ...valid, scope: 'production' },
      { ...valid, uid: 0 },
      { ...valid, version: 2 },
    ];
    for (const allocation of invalid) {
      expect(() => validateCanaryRedisAllocation(allocation, path)).toThrow('BLOCKED');
    }
  });
});

describe('operator-owned reservation file guard', () => {
  const file = (over: Partial<{ isFile: () => boolean; uid: number; mode: number }> = {}) => ({
    isFile: () => true,
    uid: 0,
    mode: 0o644,
    ...over,
  });

  it('accepts a root-owned file that no worker can rewrite', () => {
    expect(() => assertOperatorOwnedAllocationFile(file())).not.toThrow();
  });

  it.each([
    ['a worker-owned file', { uid: 1006 }],
    ['a group-writable file', { mode: 0o664 }],
    ['a world-writable file', { mode: 0o646 }],
    ['a non-file path', { isFile: () => false }],
  ])('rejects %s', (_label, over) => {
    expect(() => assertOperatorOwnedAllocationFile(file(over))).toThrow('BLOCKED');
  });
});