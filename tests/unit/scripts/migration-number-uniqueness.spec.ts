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
 * The "migration number token" is the leading run of digits plus an
 * OPTIONAL trailing lowercase letter: `063`, `038`, `038b`, `038c`. The
 * letter suffix is a deliberate sub-sequencing convention (038/038b/038c
 * are three DISTINCT ordered migrations, not a collision) and lexical sort
 * keeps them ordered (`038_` < `038b` < `038c`). Two files share a token
 * only when their leading number AND optional letter are identical.
 */
function numberToken(filename: string): string | null {
  const m = filename.match(/^([0-9]+[a-z]*)_/);
  return m ? m[1]! : null;
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
  it('every forward migration starts with a numeric token (NNN_ or NNNx_)', () => {
    const offenders = forwardMigrations().filter((f) => numberToken(f) === null);
    expect(offenders, `forward migrations without an NNN_ prefix: ${offenders.join(', ')}`).toEqual(
      [],
    );
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
