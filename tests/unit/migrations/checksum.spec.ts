/**
 * Issue #516 §4 — the checksum must be DETERMINISTIC across platforms and
 * SENSITIVE to real edits. Both halves matter:
 *
 *   - if it is not deterministic, every Windows developer's checkout trips a
 *     false "someone edited an applied migration" blocker and the team learns
 *     to ignore the alarm;
 *   - if it is not sensitive, the feature does nothing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  canonicalizeMigrationSql,
  migrationChecksum,
  shortChecksum,
  SHORT_CHECKSUM_LENGTH,
} from '@/migrations/checksum.js';

const SQL = 'BEGIN;\nCREATE TABLE t (id TEXT);\nCOMMIT;\n';

describe('migration checksum — platform determinism', () => {
  it('is identical for LF, CRLF and lone-CR line endings', () => {
    const lf = migrationChecksum(SQL);
    const crlf = migrationChecksum(SQL.replace(/\n/g, '\r\n'));
    const cr = migrationChecksum(SQL.replace(/\n/g, '\r'));
    expect(crlf).toBe(lf);
    expect(cr).toBe(lf);
  });

  it('ignores a UTF-8 BOM', () => {
    expect(migrationChecksum(`\uFEFF${SQL}`)).toBe(migrationChecksum(SQL));
  });

  it('ignores trailing whitespace and a missing/extra final newline', () => {
    const base = migrationChecksum(SQL);
    expect(migrationChecksum(SQL.trimEnd())).toBe(base);
    expect(migrationChecksum(`${SQL}\n\n  \t\n`)).toBe(base);
  });

  it('produces a 64-char lowercase hex digest', () => {
    expect(migrationChecksum(SQL)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('migration checksum — sensitivity to real edits', () => {
  it('changes when a statement changes', () => {
    expect(migrationChecksum(SQL.replace('id TEXT', 'id UUID'))).not.toBe(migrationChecksum(SQL));
  });

  it('changes when interior whitespace changes (indentation is content)', () => {
    expect(migrationChecksum(SQL.replace('CREATE', '  CREATE'))).not.toBe(migrationChecksum(SQL));
  });

  it('changes when a comment changes — comments carry the markers', () => {
    expect(migrationChecksum(`-- maia:no-transaction\n${SQL}`)).not.toBe(migrationChecksum(SQL));
  });

  it('changes when statement ORDER changes', () => {
    const a = 'CREATE TABLE a (id TEXT);\nCREATE TABLE b (id TEXT);\n';
    const b = 'CREATE TABLE b (id TEXT);\nCREATE TABLE a (id TEXT);\n';
    expect(migrationChecksum(a)).not.toBe(migrationChecksum(b));
  });
});

describe('canonicalizeMigrationSql', () => {
  it('normalises only line endings, BOM and trailing whitespace', () => {
    expect(canonicalizeMigrationSql('\uFEFFa\r\nb\r\n\n  ')).toBe('a\nb');
  });
});

describe('shortChecksum', () => {
  it('abbreviates to the documented length and survives null', () => {
    const full = migrationChecksum(SQL);
    expect(shortChecksum(full)).toBe(full.slice(0, SHORT_CHECKSUM_LENGTH));
    expect(shortChecksum(null)).toBe('none');
  });
});

describe('every real migration hashes stably', () => {
  it('re-hashing the same file twice yields the same digest, and files differ', () => {
    const dir = join(process.cwd(), 'migrations');
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql') && !f.endsWith('_down.sql'));
    expect(files.length).toBeGreaterThan(100);
    const seen = new Map<string, string>();
    for (const file of files) {
      const raw = readFileSync(join(dir, file), 'utf8');
      const a = migrationChecksum(raw);
      expect(migrationChecksum(raw)).toBe(a);
      // Two DIFFERENT migrations must not collide — otherwise a swap would be
      // invisible to the ledger.
      const previous = seen.get(a);
      expect(previous, `checksum collision between ${previous} and ${file}`).toBeUndefined();
      seen.set(a, file);
    }
  });
});
