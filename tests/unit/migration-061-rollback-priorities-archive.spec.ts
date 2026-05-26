/**
 * Migration 061 — rollback priorities archive (issue #203).
 *
 * Bug context:
 *   PR #199 (closing #194) removed the priorities → principles synthesis from
 *   the 061 down migration, stopping VALORES contamination on rollback. Codex
 *   adversarial review correctly flagged the resulting behaviour as LOSSY for
 *   `identity.priorities`: admin-ui rows with priorities populated but no
 *   real principles see their priorities array dropped along with
 *   `profile_body` on rollback, with no recovery path. The OLD pre-#199
 *   fallback was semantically lossy too — it renamed priorities into
 *   `core_immutable.principles`, destroying priorities-as-priorities AND
 *   contaminating VALORES.
 *
 *   Issue #203 fix (option (a)): add a sidecar JSONB column
 *   `_rollback_archive_priorities` on `agent_operational_profile_versions`,
 *   populate it from `profile_body.identity.priorities` in the down before
 *   `DROP COLUMN profile_body`, and have the (re-)up restore
 *   `profile_body.identity.priorities` from the sidecar and clear it.
 *   The sidecar column lives outside any VALORES audit path; tenant_id
 *   isolation is preserved because the archive is per-row (the row already
 *   carries tenant_id and agent_id immutably from migration 007/009).
 *
 * Strategy:
 *   This is the same SQL-text-inspection pattern used by the sibling specs
 *   (`migration-061-down-priorities-not-principles.spec.ts`,
 *   `migration-042-drift-type-enum.spec.ts`, `p10b-migrations-smoke.spec.ts`).
 *   Live Postgres is not required. The text checks pin every key SQL clause
 *   the fix needs so a future revert/edit can't silently regress.
 *
 * Compat with prior fixes:
 *   - Issue #194 (no priorities→principles fallback) is preserved by the
 *     sibling test. This file ADDS the sidecar-archive assertions; it does
 *     not relax #194.
 *   - Issue #173 (atomic DO $outer$ block) is preserved — the archive is
 *     wired INSIDE the existing block, not as a new top-level statement.
 *
 * VALORES audit path:
 *   `src/cognition/drift/valores.ts` reads `core_immutable.principles` via
 *   `resolveLegacyPayload`. The sidecar column is read by NEITHER VALORES
 *   nor the resolver — it is consumed only by the (re-)up migration. This
 *   test asserts the sidecar is NEVER copied into `core_immutable` (the
 *   contamination path that #194 closed) by checking the down SQL never
 *   builds `core_immutable.principles` from
 *   `_rollback_archive_priorities`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DOWN_MIGRATION_FILE = join(
  process.cwd(),
  'migrations',
  '061_p4_profile_body_consolidation_down.sql',
);

const UP_MIGRATION_FILE = join(
  process.cwd(),
  'migrations',
  '061_p4_profile_body_consolidation.sql',
);

const SIDECAR_COL = '_rollback_archive_priorities';

function stripSqlComments(sql: string): string {
  // Strip `-- ...` line comments so explanatory prose mentioning the sidecar
  // column name in comments doesn't trip the textual guards.
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

describe('migration 061 — issue #203 rollback priorities sidecar archive', () => {
  let downSql: string;
  let downCode: string;
  let upSql: string;
  let upCode: string;

  beforeAll(() => {
    // Normalise CRLF → LF for Windows checkouts.
    downSql = readFileSync(DOWN_MIGRATION_FILE, 'utf8').replace(/\r\n/g, '\n');
    downCode = stripSqlComments(downSql);
    upSql = readFileSync(UP_MIGRATION_FILE, 'utf8').replace(/\r\n/g, '\n');
    upCode = stripSqlComments(upSql);
  });

  describe('down migration', () => {
    it('adds the sidecar archive column before the profile_body DROP', () => {
      // The sidecar column has to exist by the time the archive UPDATE runs.
      const addColumnRe = new RegExp(
        `ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+${SIDECAR_COL}\\s+JSONB`,
        'i',
      );
      expect(downCode).toMatch(addColumnRe);
    });

    it('archives identity.priorities into the sidecar from profile_body', () => {
      // The down must populate the sidecar with whatever is in
      // profile_body.identity.priorities (or `[]` when absent). Match the
      // UPDATE that wires that copy.
      const archiveRe = new RegExp(
        `SET\\s+${SIDECAR_COL}\\s*=[\\s\\S]*profile_body->'identity'->'priorities'`,
        'i',
      );
      expect(downCode).toMatch(archiveRe);
    });

    it('archive UPDATE precedes the DROP COLUMN profile_body', () => {
      // Order matters: if DROP runs first, profile_body->'identity'->'priorities'
      // is unresolvable when the archive UPDATE executes.
      const archiveIdx = downCode.indexOf(`SET ${SIDECAR_COL}`);
      // Fall back to a tolerant search to tolerate whitespace variation.
      const tolerantArchiveIdx = downCode.search(
        new RegExp(`SET\\s+${SIDECAR_COL}\\s*=`, 'i'),
      );
      const dropIdx = downCode.search(/DROP\s+COLUMN\s+IF\s+EXISTS\s+profile_body/i);
      const finalArchiveIdx = archiveIdx >= 0 ? archiveIdx : tolerantArchiveIdx;
      expect(finalArchiveIdx, 'archive UPDATE must exist').toBeGreaterThanOrEqual(0);
      expect(dropIdx, 'DROP COLUMN profile_body must exist').toBeGreaterThanOrEqual(0);
      expect(finalArchiveIdx).toBeLessThan(dropIdx);
    });

    it('does NOT copy sidecar contents into core_immutable.principles (VALORES safety)', () => {
      // #194 closed the priorities → principles fallback. The new sidecar
      // must NEVER feed core_immutable.principles either — otherwise we'd
      // reintroduce the VALORES audit contamination through a side door.
      const contamRe = new RegExp(
        `'principles'[\\s\\S]{0,200}${SIDECAR_COL}`,
        'i',
      );
      expect(downCode).not.toMatch(contamRe);
    });

    it('preserves the #194 guard: principles still coalesces only to []', () => {
      // The exact COALESCE shape installed by #194 must still be the only
      // builder for core_immutable.principles in the down.
      const principlesBuilder = downCode.match(
        /'principles'\s*,\s*COALESCE\(\s*profile_body->'identity'->'principles'\s*,\s*'\[\]'::jsonb\s*\)/,
      );
      expect(
        principlesBuilder,
        'expected core_immutable.principles to coalesce true principles → empty array',
      ).not.toBeNull();
    });

    it('preserves the atomic DO $outer$ block (compat with #173)', () => {
      expect(downSql).toMatch(/DO \$outer\$/);
      expect(downSql).toMatch(/\$outer\$;/);
    });

    it('is idempotent on the sidecar add (IF NOT EXISTS)', () => {
      // Running down + up + down must not error on the second down.
      expect(downCode).toMatch(
        new RegExp(`ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+${SIDECAR_COL}`, 'i'),
      );
    });
  });

  describe('up migration', () => {
    it('reads the sidecar archive when it exists', () => {
      // The up must detect the sidecar column at migration time (introspect
      // information_schema, same pattern as the existing legacy check) and
      // restore from it when present.
      const introspectRe = new RegExp(
        `information_schema\\.columns[\\s\\S]*${SIDECAR_COL}`,
        'i',
      );
      expect(upCode).toMatch(introspectRe);
    });

    it('restores profile_body.identity.priorities from the sidecar', () => {
      // The up has to write the archived array back into
      // profile_body.identity.priorities. Match a jsonb_set onto the
      // identity.priorities path that reads from the sidecar column.
      const restoreRe = new RegExp(
        `jsonb_set\\([\\s\\S]*identity[\\s\\S]*priorities[\\s\\S]*${SIDECAR_COL}`,
        'i',
      );
      expect(upCode).toMatch(restoreRe);
    });

    it('clears the sidecar after restore (idempotent re-up)', () => {
      // After restore, the sidecar must be reset to '{}'::jsonb so a second
      // up doesn't redundantly overwrite identity.priorities — and so a
      // subsequent down captures a fresh snapshot.
      const clearRe = new RegExp(
        `SET\\s+[\\s\\S]*${SIDECAR_COL}\\s*=\\s*'\\{\\}'::jsonb`,
        'i',
      );
      expect(upCode).toMatch(clearRe);
    });

    it('does NOT drop the sidecar column on up (kept for re-rollback)', () => {
      // The column must survive the up so a future re-rollback can use it.
      const dropSidecarRe = new RegExp(
        `DROP\\s+COLUMN\\s+(?:IF\\s+EXISTS\\s+)?${SIDECAR_COL}`,
        'i',
      );
      expect(upCode).not.toMatch(dropSidecarRe);
    });

    it('preserves the existing legacy-introspection + trigger swap shape', () => {
      // Don't regress the existing DO $outer$ block from #163.
      expect(upSql).toMatch(/DO \$outer\$/);
      expect(upSql).toMatch(/\$outer\$;/);
      // The legacy introspection that picks 'full' vs 'canonical' guard
      // remains — this isn't replaced by the sidecar logic.
      expect(upCode).toMatch(/has_legacy/);
    });
  });

  describe('round-trip semantics (priorities-only row)', () => {
    it('down archives the array and the up reads it back from the same column', () => {
      // Closing assertion: the SAME sidecar column name appears in BOTH
      // migrations. If the up reads a different column, the round-trip
      // breaks.
      const sidecarInDown = downCode.includes(SIDECAR_COL);
      const sidecarInUp = upCode.includes(SIDECAR_COL);
      expect(
        sidecarInDown,
        'down migration must reference the sidecar column',
      ).toBe(true);
      expect(
        sidecarInUp,
        'up migration must reference the sidecar column for restore',
      ).toBe(true);
    });

    it('tenant isolation: archive UPDATE has no cross-tenant join or subquery', () => {
      // The archive is a row-local UPDATE — it reads profile_body of the
      // same row into the sidecar of the same row. No JOIN, no
      // cross-tenant SELECT.
      // Match the archive UPDATE block then verify it contains no JOIN.
      const archiveBlockMatch = downCode.match(
        new RegExp(
          `UPDATE\\s+agent_operational_profile_versions[\\s\\S]*?SET\\s+${SIDECAR_COL}\\s*=[\\s\\S]*?(?=;|END\\s*;|UPDATE|EXECUTE)`,
          'i',
        ),
      );
      expect(
        archiveBlockMatch,
        'archive UPDATE block must be present',
      ).not.toBeNull();
      const archiveBlock = archiveBlockMatch![0];
      expect(archiveBlock).not.toMatch(/\bJOIN\b/i);
      // Also: no subquery that could leak across rows (the only valid
      // WHERE shape is row-local — none, or `profile_body IS NOT NULL`).
      expect(archiveBlock).not.toMatch(/\bFROM\b\s+agent_operational_profile_versions\b/i);
    });
  });

  // Codex review [P2] follow-up: the restore must work on the canonical-only
  // re-up path (no legacy columns). Without seeding `identity` first,
  // `jsonb_set(profile_body, '{identity,priorities}', ..., true)` is a no-op
  // when profile_body has no `identity` key — PostgreSQL's `create_missing`
  // creates only the LEAF key, NOT intermediate path segments. The sidecar
  // would then be cleared while priorities silently vanish.
  describe('canonical-only re-up path (Codex [P2])', () => {
    it('seeds identity object before jsonb_set so missing intermediates do not drop priorities', () => {
      // The restore SET expression must build profile_body's identity key
      // before (or together with) the jsonb_set on identity.priorities.
      // We accept either pattern:
      //   1) jsonb_build_object('identity', ...) merged via `||`
      //   2) a nested jsonb_set that first writes '{identity}' to an empty
      //      object, then writes '{identity,priorities}'.
      // Both ensure the leaf write lands even when profile_body = '{}'.
      const seedJsonbBuildObjectRe = new RegExp(
        `jsonb_build_object\\(\\s*'identity'[\\s\\S]*${SIDECAR_COL}`,
        'i',
      );
      const nestedJsonbSetIdentityRe = new RegExp(
        `jsonb_set\\([\\s\\S]*'\\{identity\\}'[\\s\\S]*'\\{identity,priorities\\}'[\\s\\S]*${SIDECAR_COL}`,
        'i',
      );
      const seedsIdentity =
        seedJsonbBuildObjectRe.test(upCode) ||
        nestedJsonbSetIdentityRe.test(upCode);
      expect(
        seedsIdentity,
        'expected the restore SET to seed profile_body.identity (jsonb_build_object or nested jsonb_set) before writing identity.priorities, otherwise canonical-only re-up loses archived priorities',
      ).toBe(true);
    });

    it('clears the sidecar only when the restore actually lands priorities', () => {
      // Defensive coupling: the sidecar clear must be atomic with the
      // priorities restore on the SAME row. Acceptable shapes:
      //   - both updates happen inside the SAME UPDATE statement (the
      //     existing implementation), OR
      //   - the clear is guarded by a CASE / WHEN expression that fires
      //     only when the jsonb_set actually wrote to identity.priorities.
      // We assert (minimally) that the SET that clears the sidecar lives in
      // the SAME UPDATE statement that writes identity.priorities.
      //
      // Lock onto the RESTORE block specifically — search for the UPDATE
      // whose SET expression mentions the sidecar column. The legacy
      // backfill UPDATE earlier in the file never references the sidecar.
      const restoreBlockRe = new RegExp(
        `UPDATE\\s+agent_operational_profile_versions[\\s\\S]*?SET\\s+profile_body\\s*=[\\s\\S]*?${SIDECAR_COL}[\\s\\S]*?WHERE`,
        'i',
      );
      const restoreBlockMatch = upCode.match(restoreBlockRe);
      expect(
        restoreBlockMatch,
        'restore UPDATE block (with sidecar reference) must be present',
      ).not.toBeNull();
      const block = restoreBlockMatch![0];
      // Same statement must touch BOTH the sidecar clear AND the
      // identity.priorities write.
      expect(block).toMatch(
        new RegExp(`${SIDECAR_COL}\\s*=\\s*'\\{\\}'::jsonb`, 'i'),
      );
      expect(block).toMatch(/identity[\s\S]*priorities/i);
    });
  });
});
