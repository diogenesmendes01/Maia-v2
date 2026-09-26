import { describe, expect, it } from 'vitest';
import {
  assertOperatorOwnedAllocationFile,
  readCanaryRedisAllocation,
  resolveAuthorizedReservationPath,
  validateCanaryRedisAllocation,
} from '../../helpers/canary-redis-allocation.js';

/** Reservas test-only que o operador autorizou explicitamente. */
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

const WIP3_PATH = '/srv/agents/runtime/wip3-canary-redis-allocation.json';
const wip3 = {
  version: 1,
  status: 'reserved',
  owner: 'parallel-wave-20260926/worktree-canary',
  uid: 1006,
  worktree: '/srv/agents/worktrees/wip3-environment-prep',
  allowed_worktrees: [
    '/srv/agents/worktrees/wip3-environment-prep',
    '/srv/agents/repos/Maia-v2/.worktrees/t_f0a9f243-native',
    '/srv/agents/repos/Maia-v2/.worktrees/t_f0a9f243-native-qa',
    '/srv/agents/repos/Maia-v2/.worktrees/t_15d962a7',
    '/srv/agents/repos/Maia-v2/.worktrees/t_15d962a7-qa',
    '/srv/agents/repos/Maia-v2/.worktrees/t_f6773fda',
    '/srv/agents/repos/Maia-v2/.worktrees/t_f6773fda-qa',
  ],
  scope: 'test-only-worktree-canary',
  destinations: ['redis://127.0.0.1:6383/9', 'redis://127.0.0.1:6383/10'],
};

describe('explicit live canary Redis allocation guard', () => {
  it.each(wip3.allowed_worktrees)(
    'accepts the exact collective WIP3 reservation for %s',
    (worktree) => {
      expect(validateCanaryRedisAllocation({ ...wip3, worktree }, WIP3_PATH)).toEqual(
        wip3.destinations,
      );
    },
  );
  it.each([
    ['single slot', { destinations: [wip3.destinations[0]] }],
    ['duplicate slots', { destinations: [wip3.destinations[0], wip3.destinations[0]] }],
    ['reversed pair', { destinations: [...wip3.destinations].reverse() }],
    ...[0, 1, 2, 3, 7, 11, 16].map(
      (db) =>
        [
          `unallocated DB ${db}`,
          { destinations: [`redis://127.0.0.1:6383/${db}`, wip3.destinations[1]] },
        ] as const,
    ),
    ...[6382, 6384, 6379].map(
      (port) =>
        [
          `port swap ${port}`,
          { destinations: [`redis://127.0.0.1:${port}/9`, `redis://127.0.0.1:${port}/10`] },
        ] as const,
    ),
    ['mixed ports', { destinations: [wip3.destinations[0], 'redis://127.0.0.1:6382/10'] }],
    ['old owner', { owner: original.owner }],
    ['pilot owner', { owner: pilot.owner }],
    ['invented owner', { owner: 'invented/worktree-canary' }],
    ['foreign worktree', { worktree: pilot.worktree }],
    ['invented worktree', { worktree: '/worker/invented' }],
    ['expanded worktrees', { allowed_worktrees: [...wip3.allowed_worktrees, pilot.worktree] }],
    ['empty worktrees', { allowed_worktrees: [] }],
    ['omitted primary worktree', { allowed_worktrees: wip3.allowed_worktrees.slice(1) }],
    ['released', { status: 'released' }],
    ['wrong uid', { uid: 0 }],
    ['wrong version', { version: 2 }],
    ['wrong scope', { scope: 'production' }],
  ] as const)('rejects WIP3 %s', (_label, override) => {
    expect(() => validateCanaryRedisAllocation({ ...wip3, ...override }, WIP3_PATH)).toThrow(
      'BLOCKED',
    );
  });

  it.each([ORIGINAL_PATH, PILOT_PATH, '/worker/wip3-canary-redis-allocation.json'])(
    'rejects WIP3 content at another path %s',
    (path) => {
      expect(() => validateCanaryRedisAllocation(wip3, path)).toThrow('BLOCKED');
    },
  );

  it.each([
    [original, ORIGINAL_PATH],
    [pilot, PILOT_PATH],
  ] as const)(
    'never lends WIP3 destinations or port to an older reservation %#',
    (allocation, path) => {
      expect(() => validateCanaryRedisAllocation(allocation, WIP3_PATH)).toThrow('BLOCKED');
      expect(() =>
        validateCanaryRedisAllocation({ ...allocation, destinations: wip3.destinations }, path),
      ).toThrow('BLOCKED');
      expect(() =>
        validateCanaryRedisAllocation(
          {
            ...allocation,
            destinations: allocation.destinations.map((url) => url.replace(':6382/', ':6383/')),
          },
          path,
        ),
      ).toThrow('BLOCKED');
    },
  );

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
      validateCanaryRedisAllocation({ ...pilot, destinations: original.destinations }, PILOT_PATH),
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

  it.each([original, pilot])(
    'rejects absent, single, duplicate, unallocated or conflicting allocation %#',
    (valid) => {
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
    },
  );
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
