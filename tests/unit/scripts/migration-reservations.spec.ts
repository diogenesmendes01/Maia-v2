/**
 * Issue #340 — merge-time migration-prefix reservation guard.
 *
 * The sibling guard `migration-number-uniqueness.spec.ts` (issue #308/#329)
 * only catches duplicate prefixes in the CURRENT checkout at CI-time, so two
 * CONCURRENT PRs can each pick the same prefix and only collide AFTER the
 * second merges. `migrations/RESERVATIONS.md` is an APPEND-ONLY ledger: every
 * new migration appends a line at the END, so two PRs reserving the SAME
 * prefix both touch the file's tail and the second to merge hits an
 * unresolvable git merge conflict — an EARLY, merge-time signal instead of a
 * silent post-merge break. See the ledger header for the full rationale.
 *
 * This spec pins:
 *   - the live ledger on disk: every forward migration has exactly one
 *     well-formed reservation and vice-versa (so the #340 backfill stays
 *     correct as new migrations land),
 *   - the pure parser/cross-checker against SYNTHETIC inputs: a duplicate
 *     prefix, a migration MISSING its reservation, a stale reservation, and a
 *     malformed line all FAIL the guard (the negative cases), while a clean
 *     tree passes (the positive case),
 *   - the `migrate:reserve` next-free-prefix maths.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  GRANDFATHERED_SHARED_PREFIXES,
  findReservationProblems,
  parseLedger,
  prefixOf,
  readLedger,
  type Reservation,
} from '../../../scripts/check-migration-reservations.js';
import {
  maxNumericPrefix,
  nextFreePrefix,
  parseArgs,
  slugify,
} from '../../../scripts/migrate-reserve.js';

const MIG_DIR = join(process.cwd(), 'migrations');

function forwardMigrations(): string[] {
  return readdirSync(MIG_DIR)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('_down.sql'))
    .sort();
}

/**
 * Wrap a raw ledger body with the header + BEGIN marker the parser requires.
 * The parser ignores everything above the marker (header prose may contain
 * `|`), so synthetic data rows must live below it.
 */
function mark(body: string): string {
  return `# header\n<!-- BEGIN RESERVATIONS -->\n${body}`;
}

/** Build a synthetic ledger body from `prefix | filename | purpose` rows. */
function ledgerOf(files: string[]): string {
  const body = files.map((f) => `${prefixOf(f) ?? '???'} | ${f} | ${f}`).join('\n');
  return mark(`${body}\n`);
}

describe('issue #340 — live reservation ledger on disk', () => {
  it('parses with no well-formedness errors', () => {
    const { errors } = parseLedger(readLedger(MIG_DIR));
    expect(errors, `ledger has malformed entries:\n${errors.join('\n')}`).toEqual([]);
  });

  it('every forward migration has exactly one reservation and vice-versa', () => {
    const { reservations } = parseLedger(readLedger(MIG_DIR));
    const problems = findReservationProblems(reservations, forwardMigrations());
    expect(
      problems,
      [
        'The reservation ledger (migrations/RESERVATIONS.md) is out of sync with',
        'the migrations on disk. Reserve a missing prefix with',
        '`npm run migrate:reserve "<purpose>"`, or fix a stale entry. Details:',
        ...problems.map((p) => `  - ${p}`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('backfills the full current tree (up through 073) — count matches disk', () => {
    const { reservations } = parseLedger(readLedger(MIG_DIR));
    const files = forwardMigrations();
    expect(reservations.map((r) => r.filename).sort()).toEqual(files.slice().sort());
    // The #340 backfill spec says "currently up through 073": assert the tail
    // is present so a future migration that forgets to reserve is caught here
    // too (belt-and-suspenders with the per-file check above).
    const prefixes = new Set(reservations.map((r) => r.prefix));
    expect(prefixes.has('073')).toBe(true);
  });

  it('grandfathered shared-prefix allowlist matches the number-uniqueness guard', () => {
    // Keep the two guards' notions of "accepted shared prefix" in lockstep.
    expect([...GRANDFATHERED_SHARED_PREFIXES].sort()).toEqual([
      '007',
      '014',
      '015',
      '018',
      '020',
      '023',
      '025',
      '026',
      '027',
      '031',
      '062',
      '063',
    ]);
  });
});

describe('issue #340 — parser well-formedness (synthetic)', () => {
  it('parses a clean three-field line below the marker', () => {
    const { reservations, errors } = parseLedger(mark('074 | 074_foo.sql | adds foo\n'));
    expect(errors).toEqual([]);
    expect(reservations).toEqual<Reservation[]>([
      { line: 3, prefix: '074', filename: '074_foo.sql', purpose: 'adds foo' },
    ]);
  });

  it('ignores everything ABOVE the marker (header prose may contain a pipe)', () => {
    const body = [
      '# Migration prefix reservation ledger',
      '',
      '> `<prefix> | <filename> | <purpose>` — the format, NOT a data row',
      '<!-- BEGIN RESERVATIONS -->',
      '074 | 074_foo.sql | adds foo',
    ].join('\n');
    const { reservations, errors } = parseLedger(body);
    expect(errors).toEqual([]);
    expect(reservations.map((r) => r.filename)).toEqual(['074_foo.sql']);
  });

  it('returns no entries when the marker is absent (all lines are header)', () => {
    const { reservations } = parseLedger('074 | 074_foo.sql | adds foo\n');
    expect(reservations).toEqual([]);
  });

  it('flags a wrong field count', () => {
    const { errors } = parseLedger(mark('074 | 074_foo.sql\n'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('malformed entry');
  });

  it('flags a non-conforming prefix', () => {
    const { errors } = parseLedger(mark('07x4 | 07x4_foo.sql | bad\n'));
    expect(errors.join('\n')).toContain('is not of the form');
  });

  it('flags a prefix that disagrees with the filename token', () => {
    const { errors } = parseLedger(mark('074 | 075_foo.sql | mismatch\n'));
    expect(errors.join('\n')).toContain('does not match the leading token');
  });

  it('flags a _down.sql filename and an empty purpose', () => {
    expect(parseLedger(mark('074 | 074_foo_down.sql | x\n')).errors.join('\n')).toContain(
      'must be a forward migration',
    );
    expect(parseLedger(mark('074 | 074_foo.sql | \n')).errors.join('\n')).toContain(
      'purpose must not be empty',
    );
  });
});

describe('issue #340 — cross-check (synthetic positive + negative)', () => {
  const clean = ['072_a.sql', '073_b.sql', '074_c.sql'];

  it('positive: a clean tree fully covered by the ledger has no problems', () => {
    const { reservations } = parseLedger(ledgerOf(clean));
    expect(findReservationProblems(reservations, clean)).toEqual([]);
  });

  it('negative: a migration MISSING its reservation fails', () => {
    const { reservations } = parseLedger(ledgerOf(['072_a.sql', '073_b.sql']));
    // 074_c.sql exists on disk but is NOT reserved.
    const problems = findReservationProblems(reservations, clean);
    expect(problems.join('\n')).toContain('074_c.sql');
    expect(problems.join('\n')).toContain('has no entry');
  });

  it('negative: a NEW duplicate prefix on disk fails (the concurrent-PR case)', () => {
    // Two files share 074 — neither prefix is grandfathered → the exact
    // collision two concurrent PRs would create. Both are reserved (so the
    // "missing" check is silent); the duplicate-prefix check is what fires.
    const dup = ['073_b.sql', '074_one.sql', '074_two.sql'];
    const { reservations } = parseLedger(ledgerOf(dup));
    const problems = findReservationProblems(reservations, dup);
    const joined = problems.join('\n');
    expect(joined).toContain('prefix "074" is shared by 2 migrations');
    expect(joined).toContain('074_one.sql, 074_two.sql');
  });

  it('negative: a stale reservation pointing at a missing file fails', () => {
    // Ledger reserves 074_c.sql, but only 072/073 exist on disk.
    const { reservations } = parseLedger(ledgerOf(clean));
    const problems = findReservationProblems(reservations, ['072_a.sql', '073_b.sql']);
    expect(problems.join('\n')).toContain('does not exist as a forward migration');
  });

  it('negative: the same filename reserved twice fails', () => {
    // Both lines are individually well-formed (prefix matches filename); the
    // duplicate is the problem the cross-checker must catch.
    const body = mark('072 | 072_a.sql | first\n072 | 072_a.sql | dupe line\n');
    const { reservations, errors } = parseLedger(body);
    expect(errors).toEqual([]);
    const problems = findReservationProblems(reservations, ['072_a.sql']);
    expect(problems.join('\n')).toContain('reserved more than once');
  });

  it('allows a grandfathered shared prefix (does not flag the legacy 063 triple)', () => {
    const legacy = [
      '063_agent_memories_cleanup_backup.sql',
      '063_outbound_messages.sql',
      '063_p10_idempotency_keys_tenant_pk.sql',
    ];
    const { reservations } = parseLedger(ledgerOf(legacy));
    expect(findReservationProblems(reservations, legacy)).toEqual([]);
  });
});

describe('issue #340 — migrate:reserve helpers (synthetic)', () => {
  it('computes the next free prefix from the max numeric prefix', () => {
    const files = ['071_a.sql', '072_b.sql', '073_c.sql'];
    expect(maxNumericPrefix(files)).toBe(73);
    expect(nextFreePrefix(files)).toBe('074');
  });

  it('ignores letter suffixes when finding the max (038b does not beat 073)', () => {
    expect(nextFreePrefix(['038b_x.sql', '073_y.sql'])).toBe('074');
  });

  it('zero-pads to three digits but does not truncate larger numbers', () => {
    expect(nextFreePrefix(['001_x.sql'])).toBe('002');
    expect(nextFreePrefix(['1230_x.sql'])).toBe('1231');
  });

  it('slugifies a free-text purpose into snake_case', () => {
    expect(slugify('Outbox dedupe (v2)!')).toBe('outbox_dedupe_v2');
    expect(slugify('  trailing  ')).toBe('trailing');
  });

  it('parses --filename out of argv and joins the rest as the purpose', () => {
    expect(parseArgs(['adds', 'foo'])).toEqual({ purpose: 'adds foo' });
    expect(parseArgs(['--filename', '074_x.sql', 'adds', 'x'])).toEqual({
      filename: '074_x.sql',
      purpose: 'adds x',
    });
  });
});
