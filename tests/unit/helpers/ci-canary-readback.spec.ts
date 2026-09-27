import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { setupCiCanary } from '../../../scripts/setup-ci-canary.js';
import { readCanaryRedisAllocation } from '../../helpers/canary-redis-allocation.js';
import { CI_CANARY_PATH } from '../../../scripts/ci-canary-contract.js';

// Declared FS/runner-boundary fixture. Real producer + real consumer/validators;
// no Redis/PostgreSQL connection and no assertion of live GitHub execution.
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  realpathSync: vi.fn(),
  lstatSync: vi.fn(),
  openSync: vi.fn(),
  fstatSync: vi.fn(),
  readFileSync: vi.fn(),
  closeSync: vi.fn(),
}));
const env = {
  CI: 'true',
  GITHUB_ACTIONS: 'true',
  RUNNER_ENVIRONMENT: 'github-hosted',
  GITHUB_REPOSITORY: 'diogenesmendes01/Maia-v2',
  GITHUB_RUN_ID: '12345',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_JOB: 'integration',
  GITHUB_WORKSPACE: '/home/runner/work/Maia-v2/Maia-v2',
  SUDO_UID: '1001',
  TEST_CANARY_REDIS_ALLOCATION: CI_CANARY_PATH,
};
const directory = () => ({ isDirectory: () => true, uid: 0, mode: 0o755 });
const file = () => ({ isFile: () => true, uid: 0, mode: 0o644, nlink: 1 });
let contents = '';
let exists = false;
let uid = 0;
beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  uid = 0;
  exists = false;
  contents = '';
  vi.spyOn(process, 'getuid').mockImplementation(() => uid);
  vi.mocked(fs.realpathSync).mockImplementation((p) =>
    p === process.cwd() ? env.GITHUB_WORKSPACE : String(p),
  );
  vi.mocked(fs.lstatSync).mockReturnValue(directory() as fs.Stats);
  vi.mocked(fs.fstatSync).mockReturnValue(file() as fs.Stats);
  vi.mocked(fs.mkdirSync).mockImplementation(() => {
    if (exists) throw new Error('EEXIST');
    exists = true;
    return undefined;
  });
  vi.mocked(fs.writeFileSync).mockImplementation((_path, value) => {
    contents = String(value);
  });
  vi.mocked(fs.openSync).mockImplementation((_path, flags) => {
    expect(flags).toBe(fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    if (!contents) throw new Error('ENOENT');
    return 42;
  });
  vi.mocked(fs.readFileSync).mockImplementation(() => contents);
});
describe('CI reservation producer/readback fixture', () => {
  it('reserves exclusively as root and is consumed by exactly the runner UID', () => {
    setupCiCanary(env);
    expect(fs.writeFileSync).toHaveBeenCalledWith(CI_CANARY_PATH, expect.any(String), {
      mode: 0o644,
      flag: 'wx',
    });
    uid = 1001;
    expect(readCanaryRedisAllocation(env)).toEqual([
      'redis://127.0.0.1:6379/13',
      'redis://127.0.0.1:6379/14',
    ]);
    uid = 1002;
    expect(() => readCanaryRedisAllocation(env)).toThrow('BLOCKED');
  });
  it('does not adopt/overwrite a reservation on a repeated setup', () => {
    setupCiCanary(env);
    const first = contents;
    expect(() => setupCiCanary(env)).toThrow('EEXIST');
    expect(contents).toBe(first);
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
  });
  it('rejects a writable runtime parent BEFORE making a reservation', () => {
    vi.mocked(fs.lstatSync).mockReturnValue({ ...directory(), mode: 0o777 } as fs.Stats);
    expect(() => setupCiCanary(env)).toThrow('BLOCKED');
    expect(fs.mkdirSync).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
  it.each([1001, 1002])('requires root setup, not uid %s', (workerUid) => {
    uid = workerUid;
    expect(() => setupCiCanary(env)).toThrow('BLOCKED');
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
  it('requires explicit sudo caller identity', () => {
    expect(() => setupCiCanary({ ...env, SUDO_UID: undefined })).toThrow('BLOCKED');
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
  it('refuses a mismatched privileged readback', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('{}');
    expect(() => setupCiCanary(env)).toThrow('readback differs');
  });
  it('refuses a symlinked runtime directory', () => {
    setupCiCanary(env);
    uid = 1001;
    vi.mocked(fs.realpathSync).mockImplementation((p) =>
      p === process.cwd() ? env.GITHUB_WORKSPACE : '/foreign',
    );
    expect(() => readCanaryRedisAllocation(env)).toThrow('BLOCKED');
  });
  it('CI flags alone do not authorize slots without root-owned readback', () => {
    uid = 1001;
    expect(() => readCanaryRedisAllocation(env)).toThrow('ENOENT');
  });
  it.each([{ uid: 1001 }, { mode: 0o664 }, { mode: 0o646 }, { isFile: () => false }, { nlink: 2 }])(
    'rejects unsafe readback inode %#',
    (override) => {
      setupCiCanary(env);
      uid = 1001;
      vi.mocked(fs.fstatSync).mockReturnValue({ ...file(), ...override } as fs.Stats);
      expect(() => readCanaryRedisAllocation(env)).toThrow('BLOCKED');
      expect(fs.closeSync).toHaveBeenCalledWith(42);
    },
  );
  it.each([{ uid: 1001 }, { mode: 0o775 }, { isDirectory: () => false }])(
    'rejects unsafe directory %#',
    (override) => {
      setupCiCanary(env);
      uid = 1001;
      vi.mocked(fs.lstatSync).mockReturnValue({ ...directory(), ...override } as fs.Stats);
      expect(() => readCanaryRedisAllocation(env)).toThrow('BLOCKED');
    },
  );
  it('rejects a symlink manifest (O_NOFOLLOW)', () => {
    setupCiCanary(env);
    uid = 1001;
    vi.mocked(fs.openSync).mockImplementation(() => {
      throw new Error('ELOOP');
    });
    expect(() => readCanaryRedisAllocation(env)).toThrow('ELOOP');
  });
  it('rejects a different current workspace', () => {
    setupCiCanary(env);
    uid = 1001;
    vi.mocked(fs.realpathSync).mockReturnValue('/foreign');
    expect(() => readCanaryRedisAllocation(env)).toThrow('BLOCKED');
  });
});
