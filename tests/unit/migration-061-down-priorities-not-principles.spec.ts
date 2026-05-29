/**
 * Migration 061 down — priority-as-principle contamination guard (issue #194).
 *
 * Bug context:
 *   The down migration of 061 used to synthesize `core_immutable.principles`
 *   from `identity.priorities` when `identity.principles` was absent
 *   (`061_p4_profile_body_consolidation_down.sql:69-71`). For admin-ui rows
 *   created post-061 — which carry priorities populated but true principles
 *   absent — a schema rollback copied operational priority labels into the
 *   legacy principles slot. The legacy VALORES drift detector then audited
 *   those operational priorities as core value contracts and triggered the
 *   same false freeze/rollback path that #189 + #191 already eliminated in
 *   the runtime resolver.
 *
 *   This test pins the fix at the migration level so the contamination can
 *   never be reintroduced by a future revert/edit.
 *
 * Strategy:
 *   We assert against the static SQL text of the down migration. Live
 *   Postgres is not required (matches the pattern in
 *   `tests/unit/p10b-migrations-smoke.spec.ts` and
 *   `tests/unit/migration-042-drift-type-enum.spec.ts`). The text checks
 *   are precise enough to lock the specific anti-pattern:
 *     COALESCE(
 *       profile_body->'identity'->'principles',
 *       profile_body->'identity'->'priorities',   <-- forbidden fallback
 *       '[]'::jsonb
 *     )
 *
 *   The `priorities` JSON path must not appear anywhere in the down
 *   migration. True principles are still copied; absent principles leave
 *   `core_immutable.principles` empty.
 *
 * Compat with issue #173 (down.sql transactionality):
 *   This test only inspects the COALESCE expression(s). It does not touch
 *   the BEGIN/COMMIT shape or the `DO $outer$ ... $outer$;` atomic block,
 *   so the transactional invariant from #173 is preserved.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DOWN_MIGRATION_FILE = join(
  process.cwd(),
  'migrations',
  '061_p4_profile_body_consolidation_down.sql',
);

function stripSqlComments(sql: string): string {
  // Strip `-- ...` line comments so explanatory prose mentioning
  // 'priorities' in comments doesn't trip the textual guard.
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

describe('migration 061 down — issue #194 priority-as-principle contamination guard', () => {
  let sql: string;
  let code: string;

  beforeAll(() => {
    // Normalise CRLF → LF for Windows checkouts (same pattern as p10b smoke).
    sql = readFileSync(DOWN_MIGRATION_FILE, 'utf8').replace(/\r\n/g, '\n');
    code = stripSqlComments(sql);
  });

  it('the down migration file exists and is non-empty', () => {
    expect(sql.length).toBeGreaterThan(0);
  });

  it('does NOT reference profile_body->\'identity\'->\'priorities\' as a fallback for principles', () => {
    // This is the exact bug: a COALESCE chain that promotes priorities
    // into the principles slot. The contamination guard is "priorities
    // must never feed the principles builder", not "priorities must
    // never appear at all" — issue #203 archives identity.priorities
    // into a sidecar column (`_rollback_archive_priorities`) BEFORE the
    // profile_body DROP, which is a legitimate read of the same JSON
    // path. The narrow guard checks: priorities never appears within
    // 200 chars of a `'principles'` JSON key, which is where the bug
    // lived (a COALESCE for the principles slot).
    const contamWindow = new RegExp(
      `'principles'[\\s\\S]{0,200}profile_body->'identity'->'priorities'`,
    );
    expect(code).not.toMatch(contamWindow);
    // Defensive: the ->>'priorities' (string lookup) form must not
    // appear anywhere — the sidecar archive uses ->'priorities' (jsonb
    // lookup), so this still pins the lookup-as-string anti-pattern.
    expect(code).not.toMatch(/->>'priorities'/);
  });

  it('still copies true identity.principles into core_immutable.principles', () => {
    // The legitimate copy path must remain: when identity.principles is
    // populated, the legacy core_immutable.principles slot receives it.
    expect(code).toMatch(/profile_body->'identity'->'principles'/);
  });

  it('falls back to an empty JSON array when identity.principles is absent (never to priorities)', () => {
    // The COALESCE / CASE block that builds core_immutable.principles must
    // terminate with an empty array literal, not with a sibling field.
    // We match the exact pattern installed by the fix: the principles
    // builder coalesces only between the true principles and '[]'::jsonb.
    const principlesBuilder = code.match(
      /'principles'\s*,\s*COALESCE\(\s*profile_body->'identity'->'principles'\s*,\s*'\[\]'::jsonb\s*\)/,
    );
    expect(
      principlesBuilder,
      'expected core_immutable.principles to coalesce true principles → empty array, with no priorities fallback',
    ).not.toBeNull();
  });

  it('preserves the atomic DO $outer$ block (compat with #173 transactionality)', () => {
    // Sanity guard: don't accidentally break the single-statement DO block
    // that makes the down migration atomic when applied via psql.
    expect(sql).toMatch(/DO \$outer\$/);
    expect(sql).toMatch(/\$outer\$;/);
  });
});
