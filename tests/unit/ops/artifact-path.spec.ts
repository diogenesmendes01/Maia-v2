import { describe, it, expect } from 'vitest';
import nodePath from 'node:path';
import {
  assertSafeArtifactRef,
  resolveArtifactPath,
  resolveArtifactObjectKey,
} from '../../../src/ops/backup/artifact-path.js';

/**
 * Issue #520 round-2 review finding — the local removal path trusted a
 * persisted `artifact_ref` and did `join(BACKUP_DIR, ref)` before `rm`, so a
 * corrupted or tampered row could delete a file outside the backup root.
 *
 * Both `node:path` flavours are exercised on this one platform (the technique
 * `src/setup/auth-dir-path.ts` already uses), because a POSIX host must still
 * refuse a Windows-shaped reference and vice-versa.
 */

const GOOD = 'maia-2026-07-28T03-00-00-aaaaaaaaaaaa.dump';
const LEGACY = 'maia-2026-07-28T03-00-00.dump';

describe('assertSafeArtifactRef — accepts only our own filenames', () => {
  it.each([GOOD, LEGACY])('accepts %s', (ref) => {
    expect(assertSafeArtifactRef(ref)).toBe(ref);
  });

  it('returns the reference UNCHANGED — it never sanitises', () => {
    // A normalised traversal is still a traversal that got through.
    expect(assertSafeArtifactRef(GOOD)).toBe(GOOD);
  });
});

describe('traversal vectors', () => {
  it.each([
    ['posix parent', '../../etc/passwd'],
    ['posix parent with prefix', 'maia-../../../etc/passwd.dump'],
    ['bare dotdot', '..'],
    ['dot', '.'],
    ['nested', 'a/../../b.dump'],
  ])('rejects %s', (_name, ref) => {
    expect(() => assertSafeArtifactRef(ref)).toThrowError(/refusing to use artifact reference/);
  });

  it('rejects a `..` even without a separator', () => {
    expect(() => assertSafeArtifactRef('maia-..dump')).toThrowError(/parent traversal/);
  });
});

describe('separator vectors — both flavours, on any platform', () => {
  it.each([
    ['posix separator', 'sub/maia-x.dump'],
    ['windows separator', 'sub\\maia-x.dump'],
    ['leading posix separator', '/maia-x.dump'],
    ['leading windows separator', '\\maia-x.dump'],
    ['UNC path', '\\\\server\\share\\maia-x.dump'],
  ])('rejects %s', (_name, ref) => {
    expect(() => assertSafeArtifactRef(ref)).toThrow();
  });

  it('names the separator as the reason, not a generic shape failure', () => {
    expect(() => assertSafeArtifactRef('sub\\maia-x.dump')).toThrowError(/path separator/);
  });
});

describe('absolute-path and drive vectors', () => {
  it.each([
    ['posix absolute', '/etc/passwd'],
    ['windows absolute', 'C:\\Windows\\System32\\config\\SAM'],
    ['drive-relative (no separator!)', 'C:maia-x.dump'],
  ])('rejects %s', (_name, ref) => {
    expect(() => assertSafeArtifactRef(ref)).toThrow();
  });

  it('catches the drive-relative form that carries NO separator at all', () => {
    // `C:foo` resolves against that drive's CWD on Windows — outside our root,
    // and it slips past a naive separator-only check.
    expect(() => assertSafeArtifactRef('C:maia-x.dump')).toThrowError(/drive letter/);
  });
});

describe('control characters and whitespace', () => {
  it('rejects an embedded NUL (the C-string path truncator)', () => {
    const nul = String.fromCharCode(0);
    expect(() => assertSafeArtifactRef(`maia-x.dump${nul}.evil`)).toThrowError(
      /control character/,
    );
  });

  it('rejects newline and tab', () => {
    expect(() => assertSafeArtifactRef('maia-x\n.dump')).toThrow();
    expect(() => assertSafeArtifactRef('maia-x\t.dump')).toThrow();
  });

  it('rejects surrounding whitespace instead of trimming it', () => {
    expect(() => assertSafeArtifactRef(` ${GOOD} `)).toThrowError(/surrounding whitespace/);
  });
});

describe('shape guard', () => {
  it.each([
    ['empty', ''],
    ['not a dump', 'maia-2026-07-28.tar.gz'],
    ['wrong prefix', 'evil-2026-07-28.dump'],
    ['no extension', 'maia-2026-07-28'],
  ])('rejects %s', (_name, ref) => {
    expect(() => assertSafeArtifactRef(ref)).toThrow();
  });

  it.each([null, undefined, 42, {}])('rejects the non-string %p', (ref) => {
    expect(() => assertSafeArtifactRef(ref)).toThrowError(/empty or non-string/);
  });

  it('never echoes an unbounded value into the error', () => {
    try {
      assertSafeArtifactRef('/'.repeat(5000));
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message.length).toBeLessThan(200);
    }
  });
});

describe('resolveArtifactPath — the containment proof', () => {
  it('resolves a good reference to a direct child, posix', () => {
    expect(resolveArtifactPath('/opt/maia/backups', GOOD, nodePath.posix)).toBe(
      `/opt/maia/backups/${GOOD}`,
    );
  });

  it('resolves a good reference to a direct child, win32', () => {
    expect(resolveArtifactPath('C:\\maia\\backups', GOOD, nodePath.win32)).toBe(
      `C:\\maia\\backups\\${GOOD}`,
    );
  });

  it.each([
    ['posix', nodePath.posix, '/opt/maia/backups'],
    ['win32', nodePath.win32, 'C:\\maia\\backups'],
  ])('refuses to escape the root under %s', (_name, impl, root) => {
    for (const ref of ['../../etc/passwd', '/etc/passwd', '..\\..\\evil.dump']) {
      expect(() => resolveArtifactPath(root, ref, impl)).toThrow();
    }
  });

  it('rejects an empty root rather than resolving against the CWD', () => {
    expect(() => resolveArtifactPath('', GOOD)).toThrowError(/empty backup root/);
    expect(() => resolveArtifactPath('   ', GOOD)).toThrowError(/empty backup root/);
  });

  it('does not accept a sibling directory that merely shares the prefix', () => {
    // The classic `startsWith` bug: `/backups-evil` starts with `/backups`.
    // The direct-child identity assertion is what rules it out; this test
    // pins the behaviour even if the reference guard were ever loosened.
    const escaped = resolveArtifactPath('/backups', GOOD, nodePath.posix);
    expect(escaped.startsWith('/backups/')).toBe(true);
    expect(escaped).not.toMatch(/^\/backups-/);
  });
});

describe('resolveArtifactObjectKey — the S3 flavour of the same bug', () => {
  it('builds a key under the prefix', () => {
    expect(resolveArtifactObjectKey('maia', GOOD)).toBe(`maia/${GOOD}`);
  });

  it('tolerates a trailing slash on the prefix', () => {
    expect(resolveArtifactObjectKey('maia/', GOOD)).toBe(`maia/${GOOD}`);
  });

  it('refuses a traversal in the reference', () => {
    expect(() => resolveArtifactObjectKey('maia', '../other/x.dump')).toThrow();
  });

  it.each([
    ['parent in prefix', '../other'],
    ['absolute prefix', '/maia'],
    ['backslash prefix', 'maia\\evil'],
    ['empty prefix', ''],
  ])('refuses %s', (_name, prefix) => {
    expect(() => resolveArtifactObjectKey(prefix, GOOD)).toThrow();
  });
});
