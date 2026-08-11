/**
 * PURE path confinement for backup artifacts (issue #520).
 *
 * ROUND-2 REVIEW FINDING. The retention executor took `artifact_ref` straight
 * from a `backup_runs` row and did `join(BACKUP_DIR, ref)` before `rm`. A row
 * that was corrupted or tampered with — `../../etc/passwd`, an absolute path, a
 * Windows separator — would have removed a file OUTSIDE the backup root. The
 * probability is low (it needs a bad DB row), but the effect is arbitrary file
 * deletion on the host, and defence in depth against exactly that is what this
 * issue exists to build.
 *
 * The rule is simple and enforced twice over:
 *   1. an artifact reference must be a BASENAME matching a positive shape —
 *      no separators of either flavour, no `..`, no drive letter, no control
 *      characters;
 *   2. the resolved path must then be PROVEN to sit directly inside the root.
 *
 * Step 2 is redundant given step 1, and that is the point: two independent
 * checks, so a gap in the pattern is still caught by the containment proof.
 *
 * Mirrors the house style of `src/setup/auth-dir-path.ts` (positive marker +
 * refusal list) and `src/lib/media-guard.ts` (containment before use), and like
 * the former it takes an injectable `PathImpl` so BOTH win32 and posix
 * semantics are testable on one platform.
 */
import nodePath from 'node:path';
import { TypedError } from '@/lib/utils.js';

/** Subset of `node:path` used here — injectable to test win32 AND posix. */
export type PathImpl = Pick<
  typeof nodePath,
  'resolve' | 'join' | 'basename' | 'isAbsolute' | 'sep'
>;

/**
 * Positive marker for a Maia artifact basename. Anything that is not this
 * shape is refused outright rather than sanitised — a "cleaned" traversal is
 * still an attacker-chosen path.
 *
 * Deliberately narrow: our own producer (`artifactName`) emits
 * `maia-<iso-timestamp>-<12 hex>.dump`, and pre-#520 artifacts are
 * `maia-<iso-timestamp>.dump`. Both fit; nothing with a separator does.
 */
const ARTIFACT_REF = /^maia-[A-Za-z0-9._-]{1,180}\.dump$/;

export class UnsafeArtifactRefError extends TypedError {
  constructor(reason: string, ref: string) {
    // The ref is echoed because it is a filename, never a credential — and an
    // operator investigating a poisoned row needs to see what was in it. It is
    // truncated so a pathological value cannot flood a log line.
    super('unsafe_artifact_ref', `refusing to use artifact reference (${reason})`, {
      reason,
      ref_sample: ref.slice(0, 120),
    });
  }
}

/**
 * Validate an artifact reference as a bare filename.
 *
 * Returns the reference unchanged on success — it never normalises, because a
 * normalised traversal is still a traversal that got through.
 */
export function assertSafeArtifactRef(ref: unknown): string {
  if (typeof ref !== 'string' || ref.length === 0) {
    throw new UnsafeArtifactRefError('empty or non-string', String(ref ?? ''));
  }
  if (ref !== ref.trim()) {
    throw new UnsafeArtifactRefError('surrounding whitespace', ref);
  }
  // Control characters, including the NUL that truncates a C-string path.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(ref)) {
    throw new UnsafeArtifactRefError('control character', ref);
  }
  // BOTH separators, on every platform: a POSIX host must still refuse a
  // Windows-shaped reference written by a Windows operator (or an attacker
  // counting on `\` being an ordinary character there).
  if (ref.includes('/') || ref.includes('\\')) {
    throw new UnsafeArtifactRefError('path separator', ref);
  }
  if (ref.includes('..')) {
    throw new UnsafeArtifactRefError('parent traversal', ref);
  }
  // `C:foo` is a DRIVE-RELATIVE path on Windows and resolves against that
  // drive's current directory — outside our root, with no separator in sight.
  if (/^[A-Za-z]:/.test(ref)) {
    throw new UnsafeArtifactRefError('drive letter', ref);
  }
  // Absolute under either flavour (covers `/x`, `\\server\share`, `C:\x`).
  if (nodePath.posix.isAbsolute(ref) || nodePath.win32.isAbsolute(ref)) {
    throw new UnsafeArtifactRefError('absolute path', ref);
  }
  if (!ARTIFACT_REF.test(ref)) {
    throw new UnsafeArtifactRefError('not a Maia artifact filename', ref);
  }
  return ref;
}

/** Non-throwing form, for filtering a directory listing. */
export function isSafeArtifactRef(ref: unknown): ref is string {
  try {
    assertSafeArtifactRef(ref);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve an artifact to an absolute path and PROVE it stays directly inside
 * `root`. Throws rather than returning a boolean, so a caller cannot delete by
 * forgetting to check.
 */
export function resolveArtifactPath(
  root: string,
  ref: string,
  path: PathImpl = nodePath,
): string {
  const safeRef = assertSafeArtifactRef(ref);
  if (typeof root !== 'string' || root.trim() === '') {
    throw new UnsafeArtifactRefError('empty backup root', safeRef);
  }
  const absRoot = path.resolve(root);
  const candidate = path.resolve(absRoot, safeRef);

  // Containment proof. `startsWith(absRoot + sep)` alone would accept
  // `/backups-evil/x` for a root of `/backups`, so the DIRECT-CHILD identity is
  // asserted instead: the resolved path must be exactly root + sep + basename.
  const expected = path.join(absRoot, safeRef);
  if (candidate !== expected) {
    throw new UnsafeArtifactRefError('does not resolve to a direct child of the backup root', ref);
  }
  if (!candidate.startsWith(absRoot + path.sep)) {
    throw new UnsafeArtifactRefError('escapes the backup root', ref);
  }
  if (path.basename(candidate) !== safeRef) {
    throw new UnsafeArtifactRefError('basename changed under resolution', ref);
  }
  return candidate;
}

/**
 * Object key for the off-site copy, under the configured prefix.
 *
 * The same guard applies: a `../` inside an object key walks out of our prefix
 * into another part of the bucket, which is the S3 flavour of the same bug.
 */
export function resolveArtifactObjectKey(prefix: string, ref: string): string {
  const safeRef = assertSafeArtifactRef(ref);
  if (typeof prefix !== 'string' || prefix.trim() === '') {
    throw new UnsafeArtifactRefError('empty object prefix', safeRef);
  }
  if (prefix.includes('..') || prefix.startsWith('/') || prefix.includes('\\')) {
    throw new UnsafeArtifactRefError('unsafe object prefix', prefix);
  }
  return `${prefix.replace(/\/+$/, '')}/${safeRef}`;
}
