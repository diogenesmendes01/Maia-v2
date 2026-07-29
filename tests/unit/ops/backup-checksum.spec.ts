import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256File, sha256Buffer, digestsMatch } from '../../../src/ops/backup/checksum.js';

const dir = mkdtempSync(join(tmpdir(), 'maia-checksum-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('sha256File', () => {
  it('streams a file and reports digest + byte count', async () => {
    const p = join(dir, 'a.bin');
    const body = Buffer.from('maia backup artifact');
    writeFileSync(p, body);
    const out = await sha256File(p);
    expect(out.sha256).toBe(sha256Buffer(body));
    expect(out.bytes).toBe(body.length);
  });

  it('detects a single-byte corruption that leaves the size identical', async () => {
    const p = join(dir, 'b.bin');
    writeFileSync(p, Buffer.from('AAAA'));
    const before = await sha256File(p);
    writeFileSync(p, Buffer.from('AAAB'));
    const after = await sha256File(p);
    expect(after.bytes).toBe(before.bytes);
    expect(after.sha256).not.toBe(before.sha256);
  });

  it('rejects a missing artifact instead of returning an empty digest', async () => {
    await expect(sha256File(join(dir, 'nope.bin'))).rejects.toThrow();
  });
});

describe('digestsMatch', () => {
  it('matches identical digests regardless of case', () => {
    expect(digestsMatch('a'.repeat(64), 'A'.repeat(64))).toBe(true);
  });

  it('rejects different digests', () => {
    expect(digestsMatch('a'.repeat(64), 'b'.repeat(64))).toBe(false);
  });

  it('rejects length mismatch, empty and non-hex input without throwing', () => {
    expect(digestsMatch('a'.repeat(64), 'a'.repeat(63))).toBe(false);
    expect(digestsMatch('', '')).toBe(false);
    expect(digestsMatch('zz', 'zz')).toBe(false);
    expect(digestsMatch(undefined as unknown as string, 'a')).toBe(false);
  });
});
