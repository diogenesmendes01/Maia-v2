/**
 * Issue #516 §4 — deterministic migration checksums.
 *
 * The checksum is the mechanism that turns "someone edited a migration that is
 * already applied" from an invisible schema drift into a hard blocker. It is
 * only useful if the SAME file hashes to the SAME digest on every machine that
 * ever computes it — a developer's Windows checkout, the Linux CI runner and
 * the production image. Git's `core.autocrlf`, editors that add or drop a final
 * newline, and BOM-emitting Windows editors all rewrite bytes without changing
 * a single SQL token, and a raw byte hash would flag those as tampering.
 *
 * So we hash a CANONICAL form instead of the raw bytes:
 *
 *   1. drop a leading UTF-8 BOM (U+FEFF),
 *   2. normalise `\r\n` and lone `\r` to `\n`,
 *   3. strip trailing whitespace at end-of-file.
 *
 * Nothing else is touched. Interior whitespace, comments, casing and statement
 * order are all part of the digest, because changing any of them can change
 * what the migration does. The transform is deliberately the smallest one that
 * absorbs platform noise — a bigger normaliser (collapsing whitespace, stripping
 * comments) would start hiding real edits, which is the exact failure this
 * feature exists to prevent.
 *
 * PURE module: no I/O, no config.
 */
import { createHash } from 'node:crypto';

/** Length of the abbreviated checksum used in logs and CLI output. */
export const SHORT_CHECKSUM_LENGTH = 12;

/**
 * Platform-independent form of a migration file's contents. Exported so tests
 * can assert the normalisation directly instead of only through the digest.
 */
export function canonicalizeMigrationSql(raw: string): string {
  return raw
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\n]+$/, '');
}

/** SHA-256 (lowercase hex) of the canonical form. */
export function migrationChecksum(raw: string): string {
  return createHash('sha256').update(canonicalizeMigrationSql(raw), 'utf8').digest('hex');
}

/**
 * Abbreviation used in logs. Full digests are 64 hex chars; a 12-char prefix is
 * enough to correlate a log line with `maia migrate status` without turning
 * every log record into a wall of hex.
 */
export function shortChecksum(checksum: string | null | undefined): string {
  if (!checksum) return 'none';
  return checksum.slice(0, SHORT_CHECKSUM_LENGTH);
}
