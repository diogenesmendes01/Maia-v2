/**
 * Issue #516 §4 — discovery, markers and CHECKSUM DETERMINISM.
 *
 * The determinism cases are the load-bearing ones. This repo ships no
 * `.gitattributes` and Windows checkouts run with `core.autocrlf=true`, so the
 * same commit is CRLF on a laptop and LF in the container. If the checksum
 * were computed over raw bytes, the very first deploy after this feature
 * landed would report `checksum_mismatch` on all 120 migrations — a false
 * alarm that would teach every operator to ignore the real one.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IDEMPOTENT_MARKER,
  NO_TX_MARKER,
  canonicalizeSql,
  checksumOf,
  defaultMigrationsDir,
  describeMigration,
  discoverMigrations,
  expectedHead,
  parseStatementTimeout,
  prefixOf,
  shortChecksum,
  splitNoTxStatements,
} from '@/migrations/discover.js';

const BOM = String.fromCharCode(0xfeff);

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'maia-mig-'));
}

describe('checksum canonicalisation (cross-platform determinism)', () => {
  const body = 'CREATE TABLE t (id INT);\nCREATE INDEX i ON t (id);';

  it('is identical for LF and CRLF line endings', () => {
    expect(checksumOf(body)).toBe(checksumOf(body.replace(/\n/g, '\r\n')));
  });

  it('is identical for CR-only line endings (old-Mac checkouts)', () => {
    expect(checksumOf(body)).toBe(checksumOf(body.replace(/\n/g, '\r')));
  });

  it('ignores a leading BOM', () => {
    expect(checksumOf(body)).toBe(checksumOf(`${BOM}${body}`));
  });

  it('ignores a missing / duplicated trailing newline', () => {
    expect(checksumOf(body)).toBe(checksumOf(`${body}\n`));
    expect(checksumOf(body)).toBe(checksumOf(`${body}\n\n\n`));
    expect(checksumOf(body)).toBe(checksumOf(`${body}\n   \n`));
  });

  it('CHANGES when a single character of SQL changes', () => {
    expect(checksumOf(body)).not.toBe(checksumOf(body.replace('INT', 'BIGINT')));
  });

  it('changes when a comment changes — the whole file is the contract', () => {
    expect(checksumOf(body)).not.toBe(checksumOf(`-- note\n${body}`));
  });

  it('canonical form always ends with exactly one newline', () => {
    expect(canonicalizeSql('a')).toBe('a\n');
    expect(canonicalizeSql('a\r\n\r\n')).toBe('a\n');
  });

  it('is a 64-char lowercase hex sha256, abbreviated to 12 for logs', () => {
    const sum = checksumOf(body);
    expect(sum).toMatch(/^[0-9a-f]{64}$/);
    expect(shortChecksum(sum)).toHaveLength(12);
    expect(sum.startsWith(shortChecksum(sum))).toBe(true);
  });
});

describe('markers', () => {
  it('detects the historical no-transaction marker', () => {
    expect(NO_TX_MARKER.test('-- maia:no-transaction\nCREATE INDEX CONCURRENTLY x ON t (a);')).toBe(
      true,
    );
    expect(NO_TX_MARKER.test('BEGIN;\nCREATE TABLE t ();\nCOMMIT;')).toBe(false);
  });

  it('detects the idempotency declaration', () => {
    expect(IDEMPOTENT_MARKER.test('-- maia:idempotent\nCREATE INDEX IF NOT EXISTS x ON t (a);')).toBe(
      true,
    );
    expect(IDEMPOTENT_MARKER.test('-- nothing here\n')).toBe(false);
  });

  it('parses the per-migration statement-timeout override in every unit', () => {
    expect(parseStatementTimeout('-- maia:statement-timeout=1500ms\n')).toBe(1500);
    expect(parseStatementTimeout('-- maia:statement-timeout=90s\n')).toBe(90_000);
    expect(parseStatementTimeout('-- maia:statement-timeout=30min\n')).toBe(1_800_000);
    expect(parseStatementTimeout('CREATE TABLE t ();')).toBeNull();
  });

  it('ignores a malformed or zero timeout instead of disabling the budget', () => {
    expect(parseStatementTimeout('-- maia:statement-timeout=0s\n')).toBeNull();
    expect(parseStatementTimeout('-- maia:statement-timeout=abc\n')).toBeNull();
  });
});

describe('prefix parsing', () => {
  it('accepts digits with an optional single lowercase letter', () => {
    expect(prefixOf('110_schema_migrations_v2.sql')).toBe('110');
    expect(prefixOf('038b_p8b_extend.sql')).toBe('038b');
  });

  it('rejects a filename with no conforming leading token', () => {
    expect(prefixOf('schema.sql')).toBeNull();
    expect(prefixOf('11X_thing.sql')).toBeNull();
  });
});

describe('splitNoTxStatements', () => {
  it('yields one statement per CONCURRENTLY DDL and strips comments', () => {
    const stmts = splitNoTxStatements(
      '-- maia:no-transaction\nCREATE INDEX CONCURRENTLY a ON t (x);\n-- note\nCREATE INDEX CONCURRENTLY b ON t (y);\n',
    );
    expect(stmts).toEqual(['CREATE INDEX CONCURRENTLY a ON t (x)', 'CREATE INDEX CONCURRENTLY b ON t (y)']);
    expect(stmts.every((s) => !s.includes(';'))).toBe(true);
  });
});

describe('discoverMigrations', () => {
  it('returns forward files in apply order and pairs them with their down sibling', () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, '002_b.sql'), 'SELECT 2;\n');
      writeFileSync(join(dir, '002_b_down.sql'), 'SELECT -2;\n');
      writeFileSync(join(dir, '001_a.sql'), 'SELECT 1;\n');
      writeFileSync(join(dir, '001_a_down.sql'), 'SELECT -1;\n');
      writeFileSync(join(dir, 'notes.md'), 'ignored');

      const found = discoverMigrations(dir);
      expect(found.map((m) => m.id)).toEqual(['001_a.sql', '002_b.sql']);
      expect(found.every((m) => m.downId !== null)).toBe(true);
      expect(expectedHead(found)).toBe('002_b.sql');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a forward migration shipped WITHOUT its down sibling', () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, '001_orphan.sql'), 'SELECT 1;\n');
      const [found] = discoverMigrations(dir);
      expect(found!.downId).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never treats a _down.sql as part of the forward chain', () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, '001_a.sql'), 'SELECT 1;\n');
      writeFileSync(join(dir, '001_a_down.sql'), 'DROP TABLE a;\n');
      expect(discoverMigrations(dir).map((m) => m.id)).toEqual(['001_a.sql']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the REAL migration artifact in this repo', () => {
  const migrations = discoverMigrations(defaultMigrationsDir());

  it('has every forward migration paired with a _down sibling (AGENTS.md §4.6)', () => {
    expect(migrations.filter((m) => m.downId === null)).toEqual([]);
  });

  it('gives every migration a conforming numeric prefix', () => {
    expect(migrations.filter((m) => m.prefix === null)).toEqual([]);
  });

  it('produces a unique checksum per file', () => {
    const sums = new Set(migrations.map((m) => m.checksum));
    expect(sums.size).toBe(migrations.length);
  });

  it('re-derives the same checksum from the file text (describeMigration is pure)', () => {
    const sample = migrations[migrations.length - 1]!;
    const again = describeMigration(
      sample.id,
      sample.path,
      readFileSync(sample.path, 'utf8'),
      sample.downId,
    );
    expect(again.checksum).toBe(sample.checksum);
  });

  it('keeps migration 066 on the no-transaction path (PR #310 regression)', () => {
    const m = migrations.find((x) => x.id.startsWith('066_'));
    expect(m?.noTransaction).toBe(true);
  });
});
