/**
 * Issue #308 — migration-number duplicate guard.
 *
 * Background
 * ----------
 * `main` carries THREE forward migrations sharing the prefix 063
 * (`063_agent_memories_cleanup_backup`, `063_outbound_messages`,
 * `063_p10_idempotency_keys_tenant_pk`), landed across PRs #273/#276/#227.
 * They are all merged and already applied in real environments.
 *
 * Why we do NOT rename them
 * -------------------------
 * `scripts/migrate.ts` tracks applied migrations by FULL FILENAME
 * (`schema_migrations.id TEXT PRIMARY KEY`, `INSERT ... VALUES ($file)`,
 * skip when `applied.has(file)`) and orders pending files with a plain
 * lexical `Array.prototype.sort()` over the filename — NOT a numeric
 * prefix sort, and NOT Drizzle (drizzle-orm is only a query builder here;
 * `db:migrate` is `tsx scripts/migrate.ts`). Consequences:
 *   - Lexical order is fully deterministic and locale-independent for
 *     ASCII filenames, so the three 063s apply in a STABLE order on every
 *     platform. `064_*` always sorts after every `063_*` (the third char
 *     `4` > `3`), so there is no "which 063 does 064 follow" ambiguity.
 *   - The three 063 migrations touch DISJOINT objects
 *     (`agent_memories_cleanup_backup` table / `outbound_messages` table /
 *     `idempotency_keys` PK swap) with NO inter-dependency, so their
 *     relative order is immaterial to correctness anyway.
 *   - Because the ledger key is the filename, RENAMING an already-applied
 *     migration would make the runner see it as un-applied and re-run it,
 *     while orphaning the old `schema_migrations` row. Pure downside.
 *
 * So the triple-063 is BENIGN. Duplicate numeric prefixes are in fact an
 * established convention in this repo (007, 014×3, 015, 018, 020, 023,
 * 025, 026, 027, 031, 062, 063). This guard's job is therefore NOT to
 * forbid the existing duplicates — it is to PREVENT NEW ones from creeping
 * in (cumulative debt the #308 author rightly flagged), while documenting
 * the accepted set so a future contributor understands the state.
 *
 * What this test enforces
 * -----------------------
 *   - Every FORWARD `.sql` filename has a CONFORMING leading token: digits
 *     plus a SINGLE optional lowercase letter (`^\d+[a-z]?$`, e.g. `063`,
 *     `038b`). A malformed name that fuses prose or a multi-letter suffix
 *     onto the number (`063new_feature.sql`, `063ab_x.sql`) is REJECTED —
 *     such a name must never be silently accepted, because a loose parser
 *     would mis-tokenise it (`063new`) and let a smuggled-in 4th `063`
 *     dodge the duplicate check below.
 *   - The set of duplicate "migration number tokens" (leading digits plus
 *     an optional lowercase letter, e.g. `063`, `038b`) among FORWARD
 *     `.sql` files is EXACTLY the grandfathered set below — no more, no
 *     fewer, with the SAME member files.
 *   - A brand-new migration that reuses an existing number (e.g. a 4th
 *     `063_*` or a new `068`-collision) fails this test, pointing the
 *     author at `max(existing)+1`.
 *   - Every `_down.sql` has a forward sibling with the same token (a down
 *     file with no up, or a typo'd number, is caught).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIG_DIR = join(process.cwd(), 'migrations');

/**
 * A conforming "migration number token" is a run of digits plus a SINGLE
 * OPTIONAL trailing lowercase letter: `063`, `038`, `038b`, `038c`. The
 * letter suffix is a deliberate sub-sequencing convention (038/038b/038c
 * are three DISTINCT ordered migrations, not a collision) and lexical sort
 * keeps them ordered (`038_` < `038b` < `038c`). Two files share a token
 * only when their leading number AND optional letter are identical.
 *
 * The single-letter rule is load-bearing for the guard. A LOOSE `[a-z]*`
 * would silently absorb a malformed name's prose into the "token": e.g.
 * `063new_feature.sql` would parse as `063new`, which is NOT grouped with
 * the real `063` migrations (so a smuggled-in 4th 063 escapes the duplicate
 * check) and is NOT obviously nonconforming either. We therefore parse the
 * leading token loosely (everything up to the first `_`) and then VALIDATE
 * it against the strict shape, so malformed names are caught explicitly.
 */
const TOKEN_SHAPE = /^[0-9]+[a-z]?$/;

/**
 * The raw leading segment before the first underscore (or `null` if there
 * is no underscore at all). This is intentionally permissive so we can
 * detect and report names whose leading segment does NOT conform.
 */
function leadingSegment(filename: string): string | null {
  const m = filename.match(/^([^_]+)_/);
  return m ? m[1]! : null;
}

/**
 * The conforming migration number token, or `null` if the leading segment
 * is missing or does not match `^\d+[a-z]?$` (digits + a single optional
 * lowercase letter). Malformed names (no token, multi-letter suffix, prose
 * mixed into the number, ...) return `null` and are flagged separately.
 */
function numberToken(filename: string): string | null {
  const seg = leadingSegment(filename);
  if (seg === null || !TOKEN_SHAPE.test(seg)) return null;
  return seg;
}

function forwardMigrations(): string[] {
  return readdirSync(MIG_DIR)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('_down.sql'))
    .sort();
}

function downMigrations(): string[] {
  return readdirSync(MIG_DIR)
    .filter((f) => f.endsWith('_down.sql'))
    .sort();
}

function groupByToken(files: string[]): Map<string, string[]> {
  const byToken = new Map<string, string[]>();
  for (const f of files) {
    const tok = numberToken(f);
    if (tok === null) continue; // asserted separately
    const list = byToken.get(tok) ?? [];
    list.push(f);
    byToken.set(tok, list);
  }
  return byToken;
}

/**
 * Grandfathered duplicate tokens — already on `main`, already applied, and
 * benign under the filename-keyed/lexically-ordered runner (see header).
 * Each entry pins the EXACT member files: this freezes the accepted state
 * so that even ADDING a 4th file to an existing dup group (e.g. a 4th 063)
 * trips the guard. Sorted member lists; keep alphabetical.
 *
 * To intentionally accept a NEW shared number (almost never the right
 * call — prefer `max(existing)+1`), add it here WITH a comment explaining
 * why the collision is safe for environments that already applied both.
 */
const GRANDFATHERED_DUPLICATE_TOKENS: Record<string, string[]> = {
  '007': ['007_p0_tenants_agents.sql', '007_scheduling.sql'],
  '014': [
    '014_p0_seed_system_tenant.sql',
    '014_p1_cognitive_candidates.sql',
    '014_p2_memory_entry.sql',
  ],
  '015': ['015_p0_agents_tenant_status_idx.sql', '015_p2_behavioral_hint.sql'],
  '018': ['018_p2_agent_facts_tenant_unique.sql', '018_p3a_procedure_definitions.sql'],
  '020': ['020_p3a_procedure_hardening.sql', '020_p3b_procedure_executions.sql'],
  '023': [
    '023_p3b_unique_in_progress_per_conversa.sql',
    '023_p3c_procedure_tests.sql',
  ],
  '025': [
    '025_p3c_procedure_metrics_tenant_defense.sql',
    '025_p4_agent_operational_profile_versions.sql',
  ],
  '026': ['026_p3c_fix_event_type_check.sql', '026_p4_agent_drift_alerts.sql'],
  '027': [
    '027_p4_operational_profile_immutable_content.sql',
    '027_p5_gap_escalation_rules.sql',
  ],
  '031': ['031_p5_capability_proposals_test_loop.sql', '031_p6_channels.sql'],
  '062': ['062_drop_dashboard_sessions.sql', '062_global_settings.sql'],
  // Issue #308: PRs #273 (idempotency PK), #276 (cleanup backup), #227
  // (outbound ledger) all picked 063 in the 2026-05-28 merge wave. Tables
  // are disjoint, no inter-dependency, lexical order stable → benign.
  '063': [
    '063_agent_memories_cleanup_backup.sql',
    '063_outbound_messages.sql',
    '063_p10_idempotency_keys_tenant_pk.sql',
  ],
};

describe('issue #308 — migration number uniqueness guard', () => {
  it('every forward migration name conforms to NNN_ or NNNx_ (single optional letter)', () => {
    // A name is nonconforming when its leading segment (before the first
    // `_`) is not exactly `^\d+[a-z]?$`. This catches missing numbers
    // (`foo.sql`, `foo_bar.sql`) AND malformed numbers where prose or a
    // multi-letter suffix is fused onto the digits (`063new_feature.sql`,
    // `063ab_x.sql`). The latter is the dangerous case: a loose parser
    // would treat `063new` as its own token, so a sneaked-in 4th `063`
    // would dodge the duplicate check below. Rejecting it here forces the
    // author to use a clean `NNN_` / `NNNx_` name.
    const offenders = forwardMigrations().filter((f) => numberToken(f) === null);
    expect(
      offenders,
      [
        'Forward migration filenames whose leading token is NOT `^\\d+[a-z]?$`',
        '(digits + a single optional lowercase sub-letter, e.g. `063` or `038b`):',
        `  ${offenders.join(', ')}`,
        'Rename them to a conforming `NNN_<name>.sql` / `NNNx_<name>.sql` form',
        '(and their `_down` siblings). See docs/runbooks/migrations.md and issue #308.',
      ].join('\n'),
    ).toEqual([]);
  });

  it('the set of duplicate forward-migration numbers is EXACTLY the grandfathered set', () => {
    const byToken = groupByToken(forwardMigrations());
    const actualDuplicates: Record<string, string[]> = {};
    for (const [tok, files] of byToken) {
      if (files.length > 1) actualDuplicates[tok] = files.slice().sort();
    }

    // Normalise the expected map (sorted members) for a stable comparison.
    const expectedDuplicates: Record<string, string[]> = {};
    for (const [tok, files] of Object.entries(GRANDFATHERED_DUPLICATE_TOKENS)) {
      expectedDuplicates[tok] = files.slice().sort();
    }

    // A new collision (or a new member on an existing dup group) shows up
    // as a key/array mismatch here. The message tells the author what to do.
    expect(
      actualDuplicates,
      [
        'A migration number is shared by more than one forward .sql file and is',
        'NOT in the grandfathered allowlist. Migrations are tracked by FILENAME',
        'and ordered lexically (scripts/migrate.ts) — a NEW duplicate is avoidable',
        'tech debt. Pick the next free number: NNN = max(existing) + 1 and rename',
        'your new file (and its _down sibling). Do NOT rename an already-merged',
        'migration to resolve this. See docs/runbooks/migrations.md and issue #308.',
      ].join('\n'),
    ).toEqual(expectedDuplicates);
  });

  it('grandfathered duplicate files all actually exist on disk', () => {
    const present = new Set(forwardMigrations());
    const missing: string[] = [];
    for (const files of Object.values(GRANDFATHERED_DUPLICATE_TOKENS)) {
      for (const f of files) if (!present.has(f)) missing.push(f);
    }
    expect(
      missing,
      `grandfathered entries reference files that no longer exist: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('every _down.sql has a forward sibling sharing its number token', () => {
    const forwardByExactName = new Set(forwardMigrations());
    const orphanDowns: string[] = [];
    for (const down of downMigrations()) {
      const up = down.replace(/_down\.sql$/, '.sql');
      if (!forwardByExactName.has(up)) orphanDowns.push(down);
    }
    expect(
      orphanDowns,
      `down migrations with no matching forward file: ${orphanDowns.join(', ')}`,
    ).toEqual([]);
  });
});

/**
 * Direct coverage of the guard's parser + duplicate detection against
 * synthetic file lists. These do NOT touch disk, so they pin the exact
 * behaviour that protects the disk-based assertions above:
 *   - malformed (multi-letter / prose-fused) leading tokens are rejected,
 *   - a fresh re-use of an existing number is detected as a duplicate,
 *   - and a clean, conforming tree produces no findings.
 * If someone loosens `numberToken` back to `[a-z]*`, these fail loudly.
 */
describe('issue #308 — token parser & duplicate detection (synthetic)', () => {
  /** Tokens that conform to `^\d+[a-z]?$` round-trip unchanged. */
  it('accepts conforming tokens: NNN_ and a single-letter NNNx_', () => {
    expect(numberToken('063_outbound_messages.sql')).toBe('063');
    expect(numberToken('038_p8b_soul_biases.sql')).toBe('038');
    expect(numberToken('038b_p8b_extend_drift_alerts_type.sql')).toBe('038b');
    expect(numberToken('038c_p8b_extend_capability_proposal_type.sql')).toBe('038c');
    expect(numberToken('1_x.sql')).toBe('1');
  });

  /**
   * The blocker case: a malformed name with prose fused onto the number
   * (multi-letter suffix) must NOT parse as a token. Under the old loose
   * `[0-9]+[a-z]*` parser `063new_feature.sql` became token `063new`,
   * silently escaping both the duplicate check and the conformance check.
   */
  it('rejects malformed leading tokens (multi-letter / prose-fused)', () => {
    expect(numberToken('063new_feature.sql')).toBeNull(); // the reported bug
    expect(numberToken('063ab_x.sql')).toBeNull(); // multi-letter suffix
    expect(numberToken('63x9_x.sql')).toBeNull(); // letter then more digits
    expect(numberToken('abc_x.sql')).toBeNull(); // no leading digits
    expect(numberToken('063.sql')).toBeNull(); // no underscore at all
    expect(numberToken('063-outbound.sql')).toBeNull(); // wrong separator
  });

  /**
   * A malformed name surfaces in the SAME nonconforming list the disk test
   * asserts is empty — so introducing `063new_feature.sql` fails the guard
   * with the offenders message instead of slipping through.
   */
  it('flags a malformed multi-letter name as nonconforming (would fail the guard)', () => {
    const files = [
      '062_global_settings.sql',
      '063_outbound_messages.sql',
      '063new_feature.sql', // malformed: must be flagged
      '064_p10_idempotency_keys_atomic_reservation.sql',
    ];
    const nonconforming = files.filter((f) => numberToken(f) === null);
    expect(nonconforming).toEqual(['063new_feature.sql']);
    // And it is NOT silently folded into a `063new` group.
    expect([...groupByToken(files).keys()].sort()).toEqual(['062', '063', '064']);
  });

  /**
   * A genuine, well-formed new 4th `063` is correctly grouped with the
   * existing three — i.e. it shows up as a duplicate the allowlist diff
   * would reject (the allowlist pins exactly three 063 members).
   */
  it('detects a genuine new 4th 063 as a duplicate of the existing token', () => {
    const files = [
      '063_agent_memories_cleanup_backup.sql',
      '063_outbound_messages.sql',
      '063_p10_idempotency_keys_tenant_pk.sql',
      '063_brand_new.sql', // the avoidable new collision
    ];
    const byToken = groupByToken(files);
    expect(byToken.get('063')).toEqual([
      '063_agent_memories_cleanup_backup.sql',
      '063_outbound_messages.sql',
      '063_p10_idempotency_keys_tenant_pk.sql',
      '063_brand_new.sql',
    ]);
    // Versus the grandfathered three: the new member is the offending diff.
    const grandfathered = GRANDFATHERED_DUPLICATE_TOKENS['063']!.slice().sort();
    const actual = byToken.get('063')!.slice().sort();
    expect(actual).not.toEqual(grandfathered);
    expect(actual.filter((f) => !grandfathered.includes(f))).toEqual(['063_brand_new.sql']);
  });

  /**
   * A clean, fully-conforming tree (each number used once, plus the legit
   * single-letter sub-sequence) yields no nonconforming names and no
   * duplicate tokens — mirroring the healthy state of `migrations/`.
   */
  it('passes a clean conforming tree: no nonconforming names, no duplicates', () => {
    const files = [
      '036_p8e_policy_rules.sql',
      '037_p8e_seed_default_hard_limits.sql',
      '038_p8b_soul_biases.sql',
      '038b_p8b_extend_drift_alerts_type.sql',
      '038c_p8b_extend_capability_proposal_type.sql',
      '039_p8b_seed_founder_biases.sql',
    ];
    expect(files.filter((f) => numberToken(f) === null)).toEqual([]);
    const dups = [...groupByToken(files).entries()].filter(([, list]) => list.length > 1);
    expect(dups).toEqual([]);
  });
});
