import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  CI_CANARY_DIRECTORY,
  CI_CANARY_PATH,
  ciCanaryReservation,
  readRootOwnedCiAllocation,
  type RunnerEnv,
} from './ci-canary-contract.js';

/** Run ONLY on a disposable GitHub-hosted runner, via sudo from its test UID. */
export function setupCiCanary(env: RunnerEnv = process.env): void {
  if (process.getuid?.() !== 0 || !/^[1-9]\d*$/.test(env.SUDO_UID ?? '')) {
    throw new Error('BLOCKED: setup requires sudo from the unprivileged runner');
  }
  const reservation = ciCanaryReservation(env, Number(env.SUDO_UID));
  if (realpathSync(process.cwd()) !== env.GITHUB_WORKSPACE) {
    throw new Error('BLOCKED: setup must run in the reserved workspace');
  }
  // Exclusive creation: never overwrite/adopt a previous reservation or symlink.
  // /run is root-owned on the supported Ubuntu hosted runner.
  const runtime = lstatSync('/run');
  if (
    !runtime.isDirectory() ||
    runtime.uid !== 0 ||
    (runtime.mode & 0o022) !== 0 ||
    realpathSync('/run') !== '/run'
  )
    throw new Error('BLOCKED: unsafe runtime root');
  mkdirSync(CI_CANARY_DIRECTORY, { mode: 0o755 });
  const allocation = {
    version: 1,
    status: 'reserved',
    owner: reservation.owner,
    uid: reservation.uid,
    worktree: env.GITHUB_WORKSPACE,
    allowed_worktrees: reservation.worktrees,
    scope: reservation.scope,
    destinations: reservation.destinations,
  };
  writeFileSync(CI_CANARY_PATH, `${JSON.stringify(allocation)}\n`, { mode: 0o644, flag: 'wx' });
  if (!isDeepStrictEqual(readRootOwnedCiAllocation(), allocation)) {
    throw new Error('BLOCKED: CI reservation readback differs from explicit allocation');
  }
  console.info(
    `Reserved ${CI_CANARY_PATH} for ${reservation.owner}; runner uid=${reservation.uid}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) setupCiCanary();
