import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdir, writeFile, readdir, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SANDBOX = join(tmpdir(), 'maia-pdf-sweeper-test-' + Date.now());

vi.mock('../../src/config/env.js', () => ({
  config: { BAILEYS_AUTH_DIR: join(SANDBOX, '.baileys') },
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeAll(async () => {
  await mkdir(join(SANDBOX, '.baileys'), { recursive: true });
  await mkdir(join(SANDBOX, 'media', 'tmp'), { recursive: true });
});
afterAll(async () => {
  await rm(SANDBOX, { recursive: true, force: true });
});

beforeEach(async () => {
  // Clean tmp dir between tests
  const dir = join(SANDBOX, 'media', 'tmp');
  for (const f of await readdir(dir).catch(() => [])) {
    await rm(join(dir, f));
  }
  // Recreate dir if previous test removed it
  await mkdir(dir, { recursive: true });
});

describe('sweepPdfTmp', () => {
  it('removes *.pdf files older than 1 hour, keeps fresh ones', async () => {
    const dir = join(SANDBOX, 'media', 'tmp');
    const oldPath = join(dir, 'old.pdf');
    const freshPath = join(dir, 'fresh.pdf');
    const nonPdfPath = join(dir, 'old.txt');
    await writeFile(oldPath, '%PDF-fake');
    await writeFile(freshPath, '%PDF-fake');
    await writeFile(nonPdfPath, 'not a pdf');
    // Backdate old.pdf and old.txt by 2 hours
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(oldPath, twoHoursAgo, twoHoursAgo);
    await utimes(nonPdfPath, twoHoursAgo, twoHoursAgo);

    const { sweepPdfTmp } = await import('../../src/lib/pdf/_sweeper.js');
    const swept = await sweepPdfTmp();
    expect(swept).toBe(1); // only old.pdf removed (non-pdf ignored, fresh kept)

    const remaining = await readdir(dir);
    expect(remaining.sort()).toEqual(['fresh.pdf', 'old.txt']);
  });

  it('returns 0 when tmp dir is empty', async () => {
    const { sweepPdfTmp } = await import('../../src/lib/pdf/_sweeper.js');
    expect(await sweepPdfTmp()).toBe(0);
  });

  it('does not throw when tmp dir does not exist (idempotent)', async () => {
    // Force missing-dir scenario: remove tmp to simulate first-boot.
    await rm(join(SANDBOX, 'media', 'tmp'), { recursive: true, force: true });
    const { sweepPdfTmp } = await import('../../src/lib/pdf/_sweeper.js');
    expect(await sweepPdfTmp()).toBe(0);
    // Restore for any later tests in this file (none here, but defensive):
    await mkdir(join(SANDBOX, 'media', 'tmp'), { recursive: true });
  });
});
