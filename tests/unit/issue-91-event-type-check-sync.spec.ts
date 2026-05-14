import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Issue #91 — Static guard that the CHECK constraint on
 * `procedure_execution_events.event_type` stays in sync with the set of
 * literal `event_type` values emitted by production code.
 *
 * Why this test exists: unit + integration tests mock the repos, so the real
 * Postgres CHECK never fires in CI. Bugs like #91 (reaper emits
 * 'auto_abandoned' but the constraint rejects it) are caught only at deploy
 * time. This test reads the migration SQL files and grep-style scans the
 * known production emitters; both must agree.
 *
 * If you add a new `event_type:` literal in `src/procedures/engine.ts`,
 * `src/workers/procedure-execution-reaper.ts`, or `src/agent/core.ts`, you
 * MUST also add it to the CHECK list in the latest migration that constrains
 * the column.
 */

const REPO_ROOT = resolve(__dirname, '..', '..');

/** Authoritative list — the union of the original CHECK (migration 021) and
 * the P3c additions (migration 026). Update this list when adding a new
 * event_type AND update the migration's CHECK clause to match.
 */
const ALLOWED_EVENT_TYPES = [
  // From migration 021 (P3b) — original CHECK
  'execution_started',
  'step_started',
  'input_received',
  'decision_made',
  'tool_called',
  'tool_result',
  'criterion_checked',
  'step_completed',
  'step_failed',
  'branch_taken',
  'state_updated',
  'execution_completed',
  'execution_aborted',
  'execution_escalated',
  'execution_abandoned',
  // From migration 026 (P3c) — issue #91 fix
  'auto_abandoned',
  'human_confirmation',
] as const;

/** Code files that emit `event_type:` literals. Add to this list if new
 * emitters appear. Test fails if any emitted literal is outside
 * ALLOWED_EVENT_TYPES. */
const EMITTING_SOURCES = [
  'src/procedures/engine.ts',
  'src/workers/procedure-execution-reaper.ts',
  'src/agent/core.ts',
];

function extractEmittedTypes(source: string): string[] {
  // Match `event_type: 'X'` or `event_type: "X"` — covers all current call shapes.
  // We deliberately don't match `event_type:` followed by a variable reference,
  // because those are reads (e.g., `e.event_type !== 'X'`), not writes.
  const re = /event_type:\s*['"]([\w_]+)['"]/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.push(m[1]!);
  return out;
}

/**
 * Extract the CHECK (event_type IN (...)) clause body from a migration file.
 *
 * Why: a substring match on the whole file is satisfied by SQL comments that
 * mention the value, which is exactly the failure mode this test is trying
 * to prevent (per Codex/Superpowers review on PR #92). We slice off the
 * `ADD CONSTRAINT ... CHECK (event_type IN ( ... ))` block specifically.
 *
 * The down migration test already used `split('ADD CONSTRAINT')[1]`; we
 * generalize that here and apply it to the up migration as well.
 */
function extractCheckInClause(sql: string): string {
  const afterAdd = sql.split('ADD CONSTRAINT')[1] ?? '';
  // The body of the IN list is between `event_type IN (` and the matching
  // `)`. We slice between the first `IN (` after the ADD CONSTRAINT and the
  // next `));` (close of IN + close of CHECK + statement terminator).
  const inIdx = afterAdd.indexOf('IN (');
  if (inIdx < 0) return '';
  const tail = afterAdd.slice(inIdx + 'IN ('.length);
  const closeIdx = tail.indexOf('))');
  if (closeIdx < 0) return '';
  return tail.slice(0, closeIdx);
}

describe('Issue #91 — procedure_execution_events.event_type CHECK ↔ code sync', () => {
  it('migration 026 CHECK contains every value in ALLOWED_EVENT_TYPES', () => {
    const sql = readFileSync(
      resolve(REPO_ROOT, 'migrations/026_p3c_fix_event_type_check.sql'),
      'utf-8',
    );
    const checkClause = extractCheckInClause(sql);
    expect(checkClause, `migration 026 ADD CONSTRAINT ... CHECK (event_type IN (...)) clause missing`).toBeTruthy();
    for (const t of ALLOWED_EVENT_TYPES) {
      expect(checkClause, `migration 026 CHECK missing event_type '${t}'`).toContain(`'${t}'`);
    }
  });

  it('migration 026 explicitly includes the values that issue #91 fixes', () => {
    const sql = readFileSync(
      resolve(REPO_ROOT, 'migrations/026_p3c_fix_event_type_check.sql'),
      'utf-8',
    );
    // Scope assertions to the CHECK clause body specifically — comments that
    // describe the fix would otherwise satisfy `toContain` and pass even if a
    // future edit removed the literal from the actual constraint list.
    const checkClause = extractCheckInClause(sql);
    expect(checkClause, `migration 026 ADD CONSTRAINT CHECK clause missing`).toBeTruthy();
    expect(checkClause).toContain(`'auto_abandoned'`);
    expect(checkClause).toContain(`'human_confirmation'`);
  });

  it('every event_type literal emitted in production code is in the CHECK list', () => {
    const offenders: Array<{ file: string; value: string }> = [];
    for (const rel of EMITTING_SOURCES) {
      const src = readFileSync(resolve(REPO_ROOT, rel), 'utf-8');
      const emitted = extractEmittedTypes(src);
      for (const v of emitted) {
        if (!ALLOWED_EVENT_TYPES.includes(v as (typeof ALLOWED_EVENT_TYPES)[number])) {
          offenders.push({ file: rel, value: v });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('down migration restores the original CHECK from migration 021 (15 values, no P3c additions)', () => {
    const downSql = readFileSync(
      resolve(REPO_ROOT, 'migrations/026_p3c_fix_event_type_check_down.sql'),
      'utf-8',
    );
    // Down must NOT include the P3c additions in the restored CHECK.
    // It SHOULD delete pre-existing rows with those values first (irreversible
    // but documented in the SQL comment).
    const checkClause = extractCheckInClause(downSql);
    expect(checkClause, `down ADD CONSTRAINT CHECK clause missing`).toBeTruthy();
    expect(checkClause).not.toContain(`'auto_abandoned'`);
    expect(checkClause).not.toContain(`'human_confirmation'`);
    // Sanity: down should still contain the original 15 values
    const original15 = [
      'execution_started', 'step_started', 'input_received', 'decision_made',
      'tool_called', 'tool_result', 'criterion_checked', 'step_completed',
      'step_failed', 'branch_taken', 'state_updated', 'execution_completed',
      'execution_aborted', 'execution_escalated', 'execution_abandoned',
    ];
    for (const t of original15) {
      expect(checkClause).toContain(`'${t}'`);
    }
  });

  it('down migration is wrapped in an explicit transaction (atomic rollback)', () => {
    // `_down.sql` is run manually via `psql -f`, which does NOT auto-wrap a
    // multi-statement file. Without explicit BEGIN/COMMIT a crash between
    // DELETE and ADD CONSTRAINT leaves the table with audit rows deleted AND
    // no CHECK at all (per PR #92 Codex/Superpowers review).
    const downSql = readFileSync(
      resolve(REPO_ROOT, 'migrations/026_p3c_fix_event_type_check_down.sql'),
      'utf-8',
    );
    // Strip line comments so a comment mentioning "BEGIN" can't satisfy the
    // check — we want the actual statement.
    const stripped = downSql
      .split('\n')
      .map((l) => l.replace(/--.*$/, ''))
      .join('\n');
    expect(stripped).toMatch(/\bBEGIN\s*;/);
    expect(stripped).toMatch(/\bCOMMIT\s*;/);
  });
});
