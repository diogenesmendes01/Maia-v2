/**
 * Issue #516 §4 — artifact discovery: ordering, markers, down siblings.
 *
 * The ordering assertions matter more than they look: the ledger keys on the
 * FULL filename and the historical duplicate prefixes (007, 014, 015, … — issue
 * #308) were applied in plain code-unit order in production. Any comparator
 * that sorts differently would replay history in a different order on a fresh
 * database than on an existing one.
 */
import { describe, it, expect } from 'vitest';
import {
  buildMigrationArtifact,
  compareMigrationIds,
  discoverMigrations,
  downSiblingOf,
  isForwardMigration,
  prefixOf,
  splitNoTxStatements,
  statementTimeoutOf,
  NO_TX_MARKER,
  type MigrationSource,
} from '@/migrations/discover.js';
import { join } from 'node:path';

function src(filename: string, contents = 'SELECT 1;\n'): MigrationSource {
  return { filename, contents };
}

describe('forward/down classification', () => {
  it('recognises forward migrations and their siblings', () => {
    expect(isForwardMigration('010_x.sql')).toBe(true);
    expect(isForwardMigration('010_x_down.sql')).toBe(false);
    expect(isForwardMigration('RESERVATIONS.md')).toBe(false);
    expect(downSiblingOf('010_x.sql')).toBe('010_x_down.sql');
  });

  it('extracts conforming prefixes only', () => {
    expect(prefixOf('038b_thing.sql')).toBe('038b');
    expect(prefixOf('108_schema_migrations_v2.sql')).toBe('108');
    expect(prefixOf('noprefix.sql')).toBeNull();
    expect(prefixOf('X1_thing.sql')).toBeNull();
  });
});

describe('ordering', () => {
  it('is plain code-unit order, locale-independent', () => {
    const ids = ['014_p2_memory.sql', '007_scheduling.sql', '014_p0_seed.sql', '063_x.sql'];
    expect([...ids].sort(compareMigrationIds)).toEqual([
      '007_scheduling.sql',
      '014_p0_seed.sql',
      '014_p2_memory.sql',
      '063_x.sql',
    ]);
  });

  it('sorts a higher hundred after every lower one (100 > 099, 108 > 107)', () => {
    expect(compareMigrationIds('099_a.sql', '100_a.sql')).toBeLessThan(0);
    expect(compareMigrationIds('107_a.sql', '108_a.sql')).toBeLessThan(0);
  });

  it('matches the pre-#516 runner exactly (default Array.sort)', () => {
    const ids = ['063_b.sql', '007_a.sql', '038b_c.sql', '038_c.sql'];
    expect([...ids].sort(compareMigrationIds)).toEqual([...ids].sort());
  });
});

describe('buildMigrationArtifact', () => {
  it('orders migrations, computes head and indexes by id', () => {
    const artifact = buildMigrationArtifact(
      [src('002_b.sql'), src('001_a.sql')],
      ['001_a_down.sql', '002_b_down.sql'],
    );
    expect(artifact.migrations.map((m) => m.id)).toEqual(['001_a.sql', '002_b.sql']);
    expect(artifact.head).toBe('002_b.sql');
    expect(artifact.byId.get('001_a.sql')?.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(artifact.problems).toEqual([]);
  });

  it('reports a forward migration with no _down sibling', () => {
    const artifact = buildMigrationArtifact([src('001_a.sql')], []);
    expect(artifact.problems).toHaveLength(1);
    expect(artifact.problems[0]!.kind).toBe('missing_down_sibling');
    expect(artifact.problems[0]!.id).toBe('001_a.sql');
  });

  it('reports a malformed prefix without dropping the migration', () => {
    const artifact = buildMigrationArtifact([src('oops.sql')], ['oops_down.sql']);
    expect(artifact.problems.map((p) => p.kind)).toContain('malformed_prefix');
    expect(artifact.migrations.map((m) => m.id)).toEqual(['oops.sql']);
  });

  it('ignores _down files handed in as sources', () => {
    const artifact = buildMigrationArtifact(
      [src('001_a.sql'), src('001_a_down.sql')],
      ['001_a_down.sql'],
    );
    expect(artifact.migrations.map((m) => m.id)).toEqual(['001_a.sql']);
  });

  it('flags the no-transaction marker per file', () => {
    const artifact = buildMigrationArtifact(
      [
        src('001_a.sql', '-- maia:no-transaction\nCREATE INDEX CONCURRENTLY i ON t (a);\n'),
        src('002_b.sql', 'BEGIN;\nSELECT 1;\nCOMMIT;\n'),
      ],
      ['001_a_down.sql', '002_b_down.sql'],
    );
    expect(artifact.byId.get('001_a.sql')?.noTransaction).toBe(true);
    expect(artifact.byId.get('002_b.sql')?.noTransaction).toBe(false);
  });

  it('parses the per-migration statement-timeout marker', () => {
    const artifact = buildMigrationArtifact(
      [src('001_a.sql', '-- maia:statement-timeout=900000\nUPDATE t SET x = 1;\n')],
      ['001_a_down.sql'],
    );
    expect(artifact.byId.get('001_a.sql')?.statementTimeoutMs).toBe(900_000);
    expect(statementTimeoutOf('SELECT 1;')).toBeNull();
    expect(statementTimeoutOf('-- maia:statement-timeout=0\n')).toBeNull();
  });
});

describe('no-transaction statement splitter (behaviour preserved from PR #310)', () => {
  it('splits on top-level semicolons and strips comments', () => {
    const sql = [
      '-- maia:no-transaction',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS a ON t (x); -- inline note',
      '',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS b ON t (y);',
    ].join('\n');
    expect(NO_TX_MARKER.test(sql)).toBe(true);
    expect(splitNoTxStatements(sql)).toEqual([
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS a ON t (x)',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS b ON t (y)',
    ]);
  });
});

describe('the real migrations/ directory', () => {
  it('discovers every forward migration, each with a down sibling', async () => {
    const artifact = await discoverMigrations(join(process.cwd(), 'migrations'));
    expect(artifact.migrations.length).toBeGreaterThan(100);
    // AGENTS.md §4 rule 6 — every forward migration is reversible. A violation
    // here BLOCKS `migrate up`, so it must never land on main.
    expect(artifact.problems).toEqual([]);
    expect(artifact.head).toBe(artifact.migrations[artifact.migrations.length - 1]!.id);
  });

  it('ships the ledger v2 migration as the head', async () => {
    const artifact = await discoverMigrations(join(process.cwd(), 'migrations'));
    expect(artifact.byId.has('108_schema_migrations_v2.sql')).toBe(true);
  });

  it('every discovered migration carries a checksum and a known tx mode', async () => {
    const artifact = await discoverMigrations(join(process.cwd(), 'migrations'));
    for (const m of artifact.migrations) {
      expect(m.checksum, m.id).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof m.noTransaction).toBe('boolean');
    }
  });
});
