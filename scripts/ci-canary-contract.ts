import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, normalize } from 'node:path';

export const CI_CANARY_DIRECTORY = '/run/maia-ci-canary';
export const CI_CANARY_PATH = `${CI_CANARY_DIRECTORY}/allocation.json`;
export type RunnerEnv = Readonly<Record<string, string | undefined>>;

/** CI flags are context, not authority: the root-owned readback remains mandatory. */
export function ciCanaryReservation(env: RunnerEnv, uid: number) {
  const workspace = env.GITHUB_WORKSPACE;
  if (
    env.CI !== 'true' ||
    env.GITHUB_ACTIONS !== 'true' ||
    env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    env.GITHUB_REPOSITORY !== 'diogenesmendes01/Maia-v2' ||
    !/^[1-9]\d*$/.test(env.GITHUB_RUN_ID ?? '') ||
    !/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT ?? '') ||
    !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(env.GITHUB_JOB ?? '') ||
    !workspace ||
    !isAbsolute(workspace) ||
    normalize(workspace) !== workspace ||
    !workspace.startsWith('/home/runner/work/') ||
    !Number.isSafeInteger(uid) ||
    uid < 0
  )
    throw new Error('BLOCKED: invalid GitHub-hosted canary reservation context');
  return {
    path: CI_CANARY_PATH,
    owner: `github-actions/${env.GITHUB_REPOSITORY}/${env.GITHUB_RUN_ID}/${env.GITHUB_RUN_ATTEMPT}/${env.GITHUB_JOB}/worktree-canary`,
    uid,
    worktrees: [workspace],
    scope: 'test-only-worktree-canary',
    destinations: ['redis://127.0.0.1:6379/13', 'redis://127.0.0.1:6379/14'] as const,
  };
}

/** No worker-writable directory or symlink may replace the authority file. */
export function readRootOwnedCiAllocation(): unknown {
  for (const directory of ['/run', CI_CANARY_DIRECTORY]) {
    const stat = lstatSync(directory);
    if (
      !stat.isDirectory() ||
      stat.uid !== 0 ||
      (stat.mode & 0o022) !== 0 ||
      realpathSync(directory) !== directory
    ) {
      throw new Error(
        'BLOCKED: CI reservation directory must be root-owned and immutable to runner',
      );
    }
  }
  const fd = openSync(CI_CANARY_PATH, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.nlink !== 1) {
      throw new Error('BLOCKED: CI reservation must be a root-owned non-writable regular file');
    }
    return JSON.parse(readFileSync(fd, 'utf8')) as unknown;
  } finally {
    closeSync(fd);
  }
}
