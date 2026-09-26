import { readFileSync, statSync } from 'node:fs';

/** This live fixture may use only the operator's reserved test-only pair. */
export function validateCanaryRedisAllocation(allocation: unknown): readonly [string, string] {
  const a = allocation as Record<string, unknown> | null;
  const destinations = a?.destinations;
  if (
    a?.version !== 1 ||
    a.status !== 'reserved' ||
    a.owner !== 'hermes-environment-integration-fixes/worktree-canary' ||
    a.uid !== 1006 ||
    a.worktree !== '/srv/agents/worktrees/hermes-environment-integration-fixes' ||
    a.scope !== 'test-only-worktree-canary' ||
    !Array.isArray(destinations) ||
    destinations.length !== 2 ||
    destinations[0] !== 'redis://127.0.0.1:6382/3' ||
    destinations[1] !== 'redis://127.0.0.1:6382/4'
  ) {
    throw new Error(
      'BLOCKED: live worktree canary requires the two explicitly allocated Redis DB slots',
    );
  }
  return [destinations[0], destinations[1]];
}

export function readCanaryRedisAllocation(env = process.env): readonly [string, string] {
  const path = env.TEST_CANARY_REDIS_ALLOCATION;
  if (!path) return validateCanaryRedisAllocation(undefined);
  if (path !== '/srv/agents/runtime/canary-redis-allocation.json') {
    throw new Error('BLOCKED: canary allocation must use the operator runtime reservation');
  }
  const stat = statSync(path);
  if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
    throw new Error(
      'BLOCKED: canary Redis allocation must be operator-owned and not worker-writable',
    );
  }
  return validateCanaryRedisAllocation(JSON.parse(readFileSync(path, 'utf8')));
}
