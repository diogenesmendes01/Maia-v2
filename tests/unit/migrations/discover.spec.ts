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
  analyzeNoTxSplittability,
  analyzeTransactionEnvelope,
  buildMigrationArtifact,
  compareMigrationIds,
  discoverMigrations,
  downSiblingOf,
  hasOwnTransactionControl,
  isForwardMigration,
  prefixOf,
  splitNoTxStatements,
  splitTopLevelStatements,
  statementTimeoutOf,
  NO_TX_MARKER,
  OWN_TRANSACTION_MARKER,
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

/**
 * The second medium finding from the #541 review.
 *
 * "The file contains `BEGIN;`" was being read as "the file is atomic". It is
 * not: `BEGIN; … COMMIT; <one more statement>` has the same `BEGIN;` and none
 * of the guarantee — by the time the trailing statement fails, everything
 * inside the envelope is already durable, the runner's `ROLLBACK` is a no-op,
 * and the run would be filed as `failed` (auto-retried) on top of a
 * half-applied schema. So the property has to be PROVEN per file, not assumed.
 */
describe('top-level statement tokeniser', () => {
  it('splits on top-level semicolons only', () => {
    expect(splitTopLevelStatements('BEGIN;\nCREATE TABLE a (id TEXT);\nCOMMIT;\n')).toEqual([
      'BEGIN',
      'CREATE TABLE a (id TEXT)',
      'COMMIT',
    ]);
  });

  it('keeps a dollar-quoted body whole, semicolons and all', () => {
    const sql = "CREATE FUNCTION f() RETURNS trigger AS $$\nBEGIN\n  RETURN NEW;\nEND;\n$$ LANGUAGE plpgsql;\n";
    const statements = splitTopLevelStatements(sql);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('LANGUAGE plpgsql');
  });

  it('ignores semicolons inside comments, literals and quoted identifiers', () => {
    expect(splitTopLevelStatements('SELECT 1; -- a; comment\n')).toEqual(['SELECT 1']);
    expect(splitTopLevelStatements('SELECT 1 /* a; b */;')).toEqual(['SELECT 1']);
    expect(splitTopLevelStatements("INSERT INTO t VALUES ('a;b');")).toEqual([
      "INSERT INTO t VALUES ('a;b')",
    ]);
    expect(splitTopLevelStatements('SELECT "we;ird" FROM t;')).toEqual(['SELECT "we;ird" FROM t']);
  });

  it('returns a trailing unterminated fragment instead of dropping it', () => {
    // Dropping it is exactly how "there is code after the COMMIT" hides.
    expect(splitTopLevelStatements('BEGIN;\nSELECT 1;\nCOMMIT;\nANALYZE t')).toEqual([
      'BEGIN',
      'SELECT 1',
      'COMMIT',
      'ANALYZE t',
    ]);
  });

  it('does not mistake a $1 bind placeholder for a dollar quote', () => {
    expect(splitTopLevelStatements('SELECT $1; SELECT $2;')).toEqual(['SELECT $1', 'SELECT $2']);
  });
});

describe('transaction envelope analysis', () => {
  it('reports `absent` when the runner owns the transaction', () => {
    expect(analyzeTransactionEnvelope('CREATE TABLE a (id TEXT);\n')).toEqual({
      envelope: 'absent',
      defect: null,
      detail: null,
    });
    expect(hasOwnTransactionControl('CREATE TABLE a (id TEXT);\n')).toBe(false);
  });

  it('reports `single_complete` for one envelope around the whole file', () => {
    const analysis = analyzeTransactionEnvelope('BEGIN;\nCREATE TABLE a (id TEXT);\nCOMMIT;\n');
    expect(analysis.envelope).toBe('single_complete');
    expect(analysis.defect).toBeNull();
    expect(hasOwnTransactionControl('BEGIN;\nCREATE TABLE a (id TEXT);\nCOMMIT;\n')).toBe(true);
  });

  it('accepts `END;` as the COMMIT synonym Postgres documents', () => {
    expect(analyzeTransactionEnvelope('BEGIN;\nSELECT 1;\nEND;\n').envelope).toBe(
      'single_complete',
    );
  });

  it('accepts BEGIN/START TRANSACTION spellings a line-anchored regex misses', () => {
    // The pre-fix classifier only matched `BEGIN;` / `START TRANSACTION;`, so a
    // file opening with `BEGIN WORK;` was filed as `runner` mode and got a
    // SECOND, nested BEGIN from the runner — the original #516 defect.
    expect(OWN_TRANSACTION_MARKER.test('BEGIN WORK;\nSELECT 1;\nCOMMIT;\n')).toBe(false);
    expect(analyzeTransactionEnvelope('BEGIN WORK;\nSELECT 1;\nCOMMIT;\n').envelope).toBe(
      'single_complete',
    );
    expect(
      analyzeTransactionEnvelope(
        'START TRANSACTION ISOLATION LEVEL SERIALIZABLE;\nSELECT 1;\nCOMMIT;\n',
      ).envelope,
    ).toBe('single_complete');
  });

  it('does NOT see the PL/pgSQL block opener inside a dollar-quoted body', () => {
    const sql =
      'CREATE FUNCTION f() RETURNS trigger AS $$\nBEGIN\n  RETURN NEW;\nEND;\n$$ LANGUAGE plpgsql;\n';
    expect(analyzeTransactionEnvelope(sql).envelope).toBe('absent');
  });

  it('does NOT see a BEGIN that only appears in a comment', () => {
    expect(analyzeTransactionEnvelope('-- BEGIN;\nCREATE TABLE a (id TEXT);\n').envelope).toBe(
      'absent',
    );
  });

  it('rejects a statement AFTER the COMMIT — the finding, exactly', () => {
    const analysis = analyzeTransactionEnvelope(
      'BEGIN;\nCREATE TABLE a (id TEXT);\nCOMMIT;\nANALYZE a;\n',
    );
    expect(analysis.envelope).toBe('unverifiable');
    expect(analysis.defect).toBe('statement_after_commit');
    expect(analysis.detail).toContain('already durable');
  });

  it('rejects a statement BEFORE the BEGIN', () => {
    const analysis = analyzeTransactionEnvelope('SET work_mem = "64MB";\nBEGIN;\nSELECT 1;\nCOMMIT;\n');
    expect(analysis.envelope).toBe('unverifiable');
    expect(analysis.defect).toBe('statement_before_begin');
  });

  it('rejects two envelopes in one file', () => {
    const analysis = analyzeTransactionEnvelope(
      'BEGIN;\nCREATE TABLE a (id TEXT);\nCOMMIT;\nBEGIN;\nCREATE TABLE b (id TEXT);\nCOMMIT;\n',
    );
    expect(analysis.envelope).toBe('unverifiable');
    expect(analysis.defect).toBe('multiple_envelopes');
  });

  it('rejects an envelope that is never closed', () => {
    const analysis = analyzeTransactionEnvelope('BEGIN;\nCREATE TABLE a (id TEXT);\n');
    expect(analysis.envelope).toBe('unverifiable');
    expect(analysis.defect).toBe('unterminated_envelope');
  });

  it('rejects a COMMIT with no BEGIN of its own', () => {
    const analysis = analyzeTransactionEnvelope('CREATE TABLE a (id TEXT);\nCOMMIT;\n');
    expect(analysis.envelope).toBe('unverifiable');
    expect(analysis.defect).toBe('unbalanced_control');
  });

  it('rejects a file that discards its own work', () => {
    const analysis = analyzeTransactionEnvelope('BEGIN;\nCREATE TABLE a (id TEXT);\nROLLBACK;\n');
    expect(analysis.envelope).toBe('unverifiable');
    expect(analysis.defect).toBe('self_rollback');
  });
});

describe('buildMigrationArtifact — the envelope guardrail', () => {
  it('refuses a self-transactional file whose SQL is not one complete envelope', () => {
    const artifact = buildMigrationArtifact(
      [src('001_a.sql', 'BEGIN;\nCREATE TABLE a (id TEXT);\nCOMMIT;\nANALYZE a;\n')],
      ['001_a_down.sql'],
    );
    expect(artifact.problems.map((p) => p.kind)).toEqual(['unverifiable_transaction_envelope']);
    expect(artifact.problems[0]!.id).toBe('001_a.sql');
    expect(artifact.problems[0]!.detail).toContain('statement_after_commit');
    // Still discovered: the report names the file rather than hiding it.
    expect(artifact.byId.get('001_a.sql')?.transactionMode).toBe('self');
    expect(artifact.byId.get('001_a.sql')?.transactionEnvelope).toBe('unverifiable');
  });

  it('accepts the well-formed envelope with no problem at all', () => {
    const artifact = buildMigrationArtifact(
      [src('001_a.sql', 'BEGIN;\nCREATE TABLE a (id TEXT);\nCOMMIT;\n')],
      ['001_a_down.sql'],
    );
    expect(artifact.problems).toEqual([]);
    expect(artifact.byId.get('001_a.sql')?.transactionEnvelope).toBe('single_complete');
  });

  it('leaves no-transaction files alone — they never claimed atomicity', () => {
    const artifact = buildMigrationArtifact(
      [src('001_a.sql', '-- maia:no-transaction\nCREATE INDEX CONCURRENTLY i ON t (a);\n')],
      ['001_a_down.sql'],
    );
    expect(artifact.problems).toEqual([]);
    expect(artifact.byId.get('001_a.sql')?.transactionMode).toBe('none');
  });
});

/**
 * Issue #733 — the no-transaction splitter's constraint is IMPOSED, not asked.
 *
 * `splitNoTxStatements()` is a parser-free `split(';')` by design. Its docstring
 * forbade dollar-quoted bodies and `;`-bearing literals under the marker, but
 * nothing enforced that: the split cut inside the body, Postgres received a
 * fragment, the ledger recorded `42601` and went `dirty`, and the message
 * pointed at "syntax error" in a file whose SQL was correct. The guard below
 * refuses such a file AT DISCOVERY — before any connection — and names both
 * the cause and the way out.
 */
describe('buildMigrationArtifact — the no-transaction splitter guard (#733)', () => {
  const DOLLAR_BODY_UNDER_MARKER = [
    '-- maia:no-transaction',
    'DO $meu_bloco$',
    'BEGIN',
    "  RAISE EXCEPTION 'algo';",
    'END',
    '$meu_bloco$;',
    '',
  ].join('\n');

  const LITERAL_WITH_SEMICOLON_UNDER_MARKER = [
    '-- maia:no-transaction',
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON t (x) WHERE note <> 'a; b';",
    '',
  ].join('\n');

  /** The same file with the marker line removed — the control fixture. */
  function withoutMarker(sql: string): string {
    const stripped = sql.replace(/^[ \t]*--[ \t]*maia:no-transaction\b[^\n]*\n/m, '');
    expect(NO_TX_MARKER.test(stripped)).toBe(false);
    return stripped;
  }

  it('refuses a dollar-quoted body under the marker — and accepts the SAME file without it', () => {
    // The finding, exactly (issue #733 "Como isso falha na prática").
    const refused = buildMigrationArtifact([src('001_a.sql', DOLLAR_BODY_UNDER_MARKER)], ['001_a_down.sql']);
    expect(refused.problems.map((p) => p.kind)).toEqual(['no_transaction_unsplittable']);
    expect(refused.problems[0]!.id).toBe('001_a.sql');
    // The message names the cause — the marker AND the dollar quote …
    expect(refused.problems[0]!.detail).toContain('maia:no-transaction');
    expect(refused.problems[0]!.detail).toContain('$meu_bloco$');
    expect(refused.problems[0]!.detail).toContain('dollar_quoted_body');
    // … and the way out: drop the marker and run inside a transaction.
    expect(refused.problems[0]!.detail).toMatch(/drop|remove/i);
    expect(refused.problems[0]!.detail).toMatch(/transaction/);
    // The migration is still discovered (reported, not dropped), like every
    // other artifact problem.
    expect(refused.byId.get('001_a.sql')?.noTransaction).toBe(true);

    // CONTROL, same `it`: the identical SQL without the marker is a perfectly
    // good transactional migration and passes discovery clean. Without this
    // half, a guard that "refuses everything" would also pass.
    const accepted = buildMigrationArtifact(
      [src('001_a.sql', withoutMarker(DOLLAR_BODY_UNDER_MARKER))],
      ['001_a_down.sql'],
    );
    expect(accepted.problems).toEqual([]);
    expect(accepted.byId.get('001_a.sql')?.noTransaction).toBe(false);
    expect(accepted.byId.get('001_a.sql')?.transactionMode).toBe('runner');
  });

  it('refuses a string literal containing ";" under the marker — same control', () => {
    const refused = buildMigrationArtifact(
      [src('001_a.sql', LITERAL_WITH_SEMICOLON_UNDER_MARKER)],
      ['001_a_down.sql'],
    );
    expect(refused.problems.map((p) => p.kind)).toEqual(['no_transaction_unsplittable']);
    expect(refused.problems[0]!.detail).toContain('maia:no-transaction');
    expect(refused.problems[0]!.detail).toContain('semicolon_in_string_literal');
    expect(refused.problems[0]!.detail).toMatch(/transaction/);

    const accepted = buildMigrationArtifact(
      [src('001_a.sql', withoutMarker(LITERAL_WITH_SEMICOLON_UNDER_MARKER))],
      ['001_a_down.sql'],
    );
    expect(accepted.problems).toEqual([]);
  });

  it('is NOT fooled by "$$" or ";" that live only in comments (the 096/122 shape)', () => {
    // 096 and 122 explain the rule in their header comments — "sem `DO $$`,
    // sem literal com `;`" — and the line stripper removes those before the
    // split, so they are not hazards. A guard that flagged them would refuse
    // two migrations that have run in production. (Only `--` comments get
    // this pass: the splitter strips those and nothing else — a `;` inside a
    // `/* … */` IS a hazard, pinned below.)
    const sql = [
      '-- maia:no-transaction',
      '-- Regras: statements simples terminados por `;` (sem `DO $$`, sem literal com `;`).',
      "-- nem aqui: DO $$ BEGIN RAISE 'x; y'; END $$;",
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON t (x) WHERE kind = 'note'; -- ok; really",
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS j ON t (y) WHERE kind <> 'it''s';",
      '',
    ].join('\n');
    expect(analyzeNoTxSplittability(sql)).toEqual({ hazard: null, detail: null });
    const artifact = buildMigrationArtifact([src('001_a.sql', sql)], ['001_a_down.sql']);
    expect(artifact.problems).toEqual([]);
    expect(splitNoTxStatements(sql)).toHaveLength(2);
  });

  it('names the shape it found, with the line, for each hazard', () => {
    expect(analyzeNoTxSplittability('SELECT 1;\nDO $$ BEGIN NULL; END $$;\n')).toEqual({
      hazard: 'dollar_quoted_body',
      detail: 'contains a dollar-quoted body opened by "$$" (line 2)',
    });
    expect(analyzeNoTxSplittability("SELECT 1;\nSELECT 'a;b';\n")).toEqual({
      hazard: 'semicolon_in_string_literal',
      detail: 'contains a string literal with a ";" inside it (line 2)',
    });
    // The differential net: a `;` the split cannot see, hidden where the
    // named checks do not look.
    const quotedIdentifier = analyzeNoTxSplittability('CREATE INDEX CONCURRENTLY "i;x" ON t (a);\n');
    expect(quotedIdentifier.hazard).toBe('naive_split_disagrees');
    expect(quotedIdentifier.detail).toContain('yields 2 statement(s)');
    expect(quotedIdentifier.detail).toContain('tokeniser finds 1');
    const blockComment = analyzeNoTxSplittability('CREATE INDEX CONCURRENTLY i ON t (a); /* x; y */\n');
    expect(blockComment.hazard).toBe('naive_split_disagrees');
    // A `--` inside a literal: the stripper would eat the closing quote and
    // the `;` after it.
    const dashInLiteral = analyzeNoTxSplittability("SELECT 'a--b';\nSELECT 2;\n");
    expect(dashInLiteral.hazard).toBe('naive_split_disagrees');
  });

  it('does not mistake a $1 bind placeholder or an escaped quote for a hazard', () => {
    expect(analyzeNoTxSplittability('SELECT $1;\n').hazard).toBeNull();
    expect(analyzeNoTxSplittability("SELECT 'it''s';\n").hazard).toBeNull();
    // A dollar-quoted body WITHOUT a `;` inside would survive the split by
    // luck; the docstring forbids the shape, not the luck, so it is refused too.
    expect(analyzeNoTxSplittability('CREATE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;\n').hazard).toBe(
      'dollar_quoted_body',
    );
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

  it('every self-transactional migration on disk IS one complete envelope', async () => {
    // The five that exist today satisfy it; this is the guardrail that keeps the
    // sixth from arriving without anyone noticing.
    const artifact = await discoverMigrations(join(process.cwd(), 'migrations'));
    const self = artifact.migrations.filter((m) => m.transactionMode === 'self');
    expect(self.length).toBeGreaterThan(0);
    for (const m of self) {
      expect(m.transactionEnvelope, m.id).toBe('single_complete');
    }
  });

  it('classifies the packaged files exactly as the pre-tokeniser regex did', async () => {
    // The tokeniser replaced a line-anchored regex. It is allowed to be
    // STRICTER on new files; it is not allowed to silently re-mode a merged one,
    // because the transaction mode decides which apply protocol the file gets.
    const artifact = await discoverMigrations(join(process.cwd(), 'migrations'));
    for (const m of artifact.migrations) {
      const legacy = OWN_TRANSACTION_MARKER.test(
        m.sql
          .split('\n')
          .map((line) => line.replace(/--.*$/, ''))
          .join('\n'),
      );
      const expected = m.noTransaction ? 'none' : legacy ? 'self' : 'runner';
      expect(m.transactionMode, m.id).toBe(expected);
    }
  });

  it('every no-transaction migration on disk passes the splitter guard (#733)', async () => {
    // The control that keeps the guard honest in the other direction: it must
    // not be so strict that a file which has already run in production is
    // refused. Every marked file is checked ONE BY ONE, so a regression names
    // the file rather than surfacing as a bare `problems.length`.
    const artifact = await discoverMigrations(join(process.cwd(), 'migrations'));
    const marked = artifact.migrations.filter((m) => m.noTransaction);
    // 15 of the 145 forward files carried the marker when this guard landed;
    // the count can only grow (migrations are append-only).
    expect(marked.length).toBeGreaterThanOrEqual(15);
    for (const m of marked) {
      expect(analyzeNoTxSplittability(m.sql), m.id).toEqual({ hazard: null, detail: null });
    }
    expect(artifact.problems.filter((p) => p.kind === 'no_transaction_unsplittable')).toEqual([]);
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
