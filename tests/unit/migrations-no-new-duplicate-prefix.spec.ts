/**
 * Issue #308 — CI guard: NO NEW duplicate migration-number prefixes.
 *
 * Owner-chosen strategy: GUARD-ONLY. We do NOT renumber or rename any
 * existing migration (that supersedes the stale renumber PR #329). Renaming
 * an already-merged/applied migration would actively corrupt environments,
 * so the only safe remedy is to STOP the debt from growing — which is what
 * this test does.
 *
 * Why duplicate prefixes exist and why they are benign TODAY
 * ---------------------------------------------------------
 * `scripts/migrate.ts` discovers forward migrations with `readdir` +
 * filter-out `*_down.sql` + a plain `Array.prototype.sort()` over the FULL
 * filename, and tracks applied ones in `schema_migrations(id TEXT PRIMARY
 * KEY)` keyed by that FULL FILENAME (it skips any file already recorded).
 * Consequences:
 *   - Duplicate numeric prefixes do NOT double-apply: two files sharing a
 *     number are two independent ledger rows (keyed by filename, not number).
 *   - BUT they are fragile. Same-numbered files order ALPHABETICALLY by the
 *     full filename — a latent ordering caveat — and renaming an already-
 *     applied migration would make the runner treat it as new and re-run it.
 *     That is exactly why we grandfather the existing collisions instead of
 *     renumbering them.
 *
 * What this test enforces
 * -----------------------
 * The set of leading numeric prefixes shared by more than one FORWARD
 * (`.sql`, not `*_down.sql`) migration must be a SUBSET of the explicit
 * `GRANDFATHERED_DUPLICATE_PREFIXES` allowlist below. A NEW duplicate prefix
 * (one not already grandfathered) FAILS this test with a message naming the
 * offending files and instructing the author to pick the next free number.
 *
 * This spec lives under `tests/unit/**` on purpose: it runs inside the
 * blocking `typecheck + test + lint + build` CI job, so a new collision
 * blocks the PR rather than merging silently.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');

/** Leading numeric prefix of a migration filename, e.g. `063` from
 * `063_outbound_messages.sql`. Returns `null` when the name does not start
 * with `<digits>_` (e.g. `038b_...`, which uses a letter sub-sequence and is
 * therefore NOT a bare-number collision). Such names are intentionally NOT
 * grouped as numeric duplicates. */
function numericPrefix(filename: string): string | null {
  const m = filename.match(/^(\d+)_/);
  return m ? m[1]! : null;
}

/** Forward (up) migrations only: `*.sql`, excluding rollback `*_down.sql`. */
function forwardMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('_down.sql'))
    .sort();
}

/**
 * GRANDFATHERED legacy duplicate prefixes — DO NOT GROW THIS LIST.
 * ===============================================================
 * Every entry below is pre-existing migration-numbering DEBT created before
 * this guard existed (mostly the 2026-05-28 merge wave, where independent
 * PRs picked the same next number). They are already merged and applied in
 * real environments, and the filename-keyed runner makes them safe to leave
 * in place — but renaming any of them would re-run an applied migration, so
 * they are frozen here rather than fixed.
 *
 * The guard asserts the live duplicate set is a SUBSET of this allowlist.
 * That means: existing collisions are tolerated, but EVERY NEW migration
 * MUST use a UNIQUE numeric prefix. Do NOT add a prefix here to silence a
 * failure on a brand-new file — instead rename your new file to the next
 * free number (`NNN = max(existing) + 1`). Adding to this list re-opens the
 * exact debt issue #308 asked us to stop accumulating.
 *
 * Each prefix below is annotated with the conflicting concern so a future
 * reader understands what collided:
 */
const GRANDFATHERED_DUPLICATE_PREFIXES: ReadonlySet<string> = new Set([
  '007', // p0_tenants_agents  ×  scheduling
  '014', // p0_seed_system_tenant  ×  p1_cognitive_candidates  ×  p2_memory_entry (triple)
  '015', // p0_agents_tenant_status_idx  ×  p2_behavioral_hint
  '018', // p2_agent_facts_tenant_unique  ×  p3a_procedure_definitions
  '020', // p3a_procedure_hardening  ×  p3b_procedure_executions
  '023', // p3b_unique_in_progress_per_conversa  ×  p3c_procedure_tests
  '025', // p3c_procedure_metrics_tenant_defense  ×  p4_agent_operational_profile_versions
  '026', // p3c_fix_event_type_check  ×  p4_agent_drift_alerts
  '027', // p4_operational_profile_immutable_content  ×  p5_gap_escalation_rules
  '031', // p5_capability_proposals_test_loop  ×  p6_channels
  '062', // drop_dashboard_sessions  ×  global_settings
  '063', // agent_memories_cleanup_backup  ×  outbound_messages  ×  p10_idempotency_keys_tenant_pk (triple; the original #308 collision)
]);

/** prefix -> forward filenames sharing it (only prefixes with >1 member). */
function duplicatePrefixGroups(files: string[]): Map<string, string[]> {
  const byPrefix = new Map<string, string[]>();
  for (const f of files) {
    const p = numericPrefix(f);
    if (p === null) continue; // letter-suffixed sub-sequence; not a bare-number dup
    const group = byPrefix.get(p) ?? [];
    group.push(f);
    byPrefix.set(p, group);
  }
  const dups = new Map<string, string[]>();
  for (const [prefix, group] of byPrefix) {
    if (group.length > 1) dups.set(prefix, group.slice().sort());
  }
  return dups;
}

describe('migrations: no NEW duplicate number prefixes (issue #308)', () => {
  it('every duplicate prefix is grandfathered — new collisions fail CI', () => {
    const dupGroups = duplicatePrefixGroups(forwardMigrations());

    const offenders = [...dupGroups.entries()].filter(
      ([prefix]) => !GRANDFATHERED_DUPLICATE_PREFIXES.has(prefix),
    );

    const message =
      offenders.length === 0
        ? ''
        : [
            'NEW duplicate migration-number prefix detected.',
            '',
            'Migrations are tracked by FULL FILENAME and ordered LEXICALLY by',
            'filename (scripts/migrate.ts) — two files sharing a number order',
            'only alphabetically, which is fragile and avoidable debt.',
            '',
            'Offending prefixes and their files:',
            ...offenders.map(
              ([prefix, files]) => `  ${prefix}: ${files.join(', ')}`,
            ),
            '',
            'Fix: rename your NEW migration (and its _down.sql sibling) to the',
            'next free number, NNN = max(existing) + 1. Do NOT renumber an',
            'already-merged migration, and do NOT add the prefix to',
            'GRANDFATHERED_DUPLICATE_PREFIXES. See docs/runbooks/migrations.md',
            'and issue #308.',
          ].join('\n');

    expect(offenders.map(([prefix]) => prefix), message).toEqual([]);
  });

  it('grandfathered prefixes still correspond to real on-disk duplicates', () => {
    // Keeps the allowlist honest: if a grandfathered collision is ever
    // legitimately resolved (e.g. a file removed so the prefix is unique
    // again), this flags the now-stale entry so it can be pruned — the list
    // must only ever SHRINK.
    const dupGroups = duplicatePrefixGroups(forwardMigrations());
    const stale = [...GRANDFATHERED_DUPLICATE_PREFIXES].filter(
      (prefix) => !dupGroups.has(prefix),
    );
    expect(
      stale,
      `Grandfathered prefixes no longer duplicated on disk (prune them): ${stale.join(', ')}`,
    ).toEqual([]);
  });
});
