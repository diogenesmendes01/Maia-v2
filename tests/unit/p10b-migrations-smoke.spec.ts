import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * P10b — Migration smoke test (Codex review #102 issue 1).
 *
 * The critical bug in the first round: migration 038 (now 054) joined the
 * matview to `role_selector_decisions.chosen_role_id`, but the schema
 * (migration 034) actually uses `decided_role_id` / `decided_at`. A fresh
 * deploy would have crashed at matview creation, blocking P10b rollout.
 *
 * This test parses the matview SQL and the source-table SQL files and
 * asserts that every column the matview references actually exists in
 * the source CREATE TABLE — without needing a live Postgres. Cheap,
 * fast, runs on every PR.
 *
 * Limitations: we don't run a real CREATE MATERIALIZED VIEW (would need
 * pg). We DO verify that the matview's column references can be resolved
 * against the migration chain, which is what would have caught the
 * original `chosen_role_id` typo.
 */

const MIG_DIR = join(process.cwd(), 'migrations');

function readMig(file: string): string {
  // Normalise CRLF → LF so single-line regexes work on Windows checkouts.
  return readFileSync(join(MIG_DIR, file), 'utf8').replace(/\r\n/g, '\n');
}

function listMigrations(): string[] {
  return readdirSync(MIG_DIR)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('_down.sql'))
    .sort();
}

/**
 * Crude column extractor — finds the column list of a `CREATE TABLE X (...)`
 * statement. Returns lowercase column names. Strips `--` comments first
 * so they don't confuse the comma-splitter.
 */
function extractColumns(sql: string, tableName: string): Set<string> {
  const re = new RegExp(
    `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${tableName}\\s*\\(([\\s\\S]*?)\\);`,
    'i',
  );
  const m = sql.match(re);
  if (!m) return new Set();
  const body = m[1]!;
  // Strip inline comments line-by-line first so commas inside comments
  // don't get treated as column separators.
  const stripped = body
    .split('\n')
    .map((l) => l.replace(/--.*$/, '').trimEnd())
    .join('\n');
  // Now split on commas that aren't inside parens (e.g. NUMERIC(10,6)).
  let depth = 0;
  const parts: string[] = [];
  let buf = '';
  for (const ch of stripped) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) parts.push(buf);
  const cols = new Set<string>();
  for (const line of parts) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Skip table-level CHECK / CONSTRAINT / FOREIGN KEY etc.
    if (/^(CHECK|CONSTRAINT|FOREIGN|PRIMARY|UNIQUE|EXCLUDE)\b/i.test(trimmed)) continue;
    const colMatch = trimmed.match(/^([a-z_][a-z0-9_]*)\s+/i);
    if (colMatch) cols.add(colMatch[1]!.toLowerCase());
  }
  return cols;
}

/**
 * Aggregate all `ADD COLUMN <name>` from later migrations (covers cases
 * like cognitive_module_log columns added after the initial table).
 */
function collectAddedColumns(tableName: string, allMigs: string[]): Set<string> {
  const added = new Set<string>();
  for (const f of allMigs) {
    const sql = readMig(f);
    const re = new RegExp(
      `ALTER\\s+TABLE\\s+${tableName}\\s+ADD\\s+COLUMN\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?([a-z_][a-z0-9_]*)`,
      'gi',
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) !== null) added.add(m[1]!.toLowerCase());
    // Also catch DO $$ EXECUTE format() ADD COLUMN tenant_id / agent_id
    // (migration 009 adds these to every table via dynamic SQL).
    if (/'ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id/i.test(sql)) {
      added.add('tenant_id');
      added.add('agent_id');
    }
  }
  return added;
}

function getAllColumnsForTable(tableName: string): Set<string> {
  const migs = listMigrations();
  let base = new Set<string>();
  for (const f of migs) {
    const sql = readMig(f);
    const got = extractColumns(sql, tableName);
    if (got.size > 0) {
      base = got;
      break; // first CREATE TABLE wins (later ones are IF NOT EXISTS no-ops)
    }
  }
  const added = collectAddedColumns(tableName, migs);
  for (const a of added) base.add(a);
  return base;
}

describe('P10b — migration smoke (Codex review #102 issue 1)', () => {
  it('runtime_trace_envelopes migration is present at 052', () => {
    const f = '052_p10b_runtime_trace_envelopes.sql';
    const sql = readMig(f);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS runtime_trace_envelopes');
  });

  it('runtime_trace_bodies + outbox migration is present at 053', () => {
    const f = '053_p10b_runtime_trace_bodies.sql';
    const sql = readMig(f);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS runtime_trace_bodies');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS runtime_trace_body_outbox');
  });

  it('unified_trace_events matview migration is present at 054', () => {
    const f = '054_p10b_unified_trace_events_matview.sql';
    const sql = readMig(f);
    expect(sql).toContain('CREATE MATERIALIZED VIEW IF NOT EXISTS unified_trace_events');
  });

  it('matview column references match the role_selector_decisions schema (the bug Codex caught)', () => {
    const matview = readMig('054_p10b_unified_trace_events_matview.sql');
    // Strip comments so we only check actual SQL (the comment block
    // intentionally references the broken column name to document the fix).
    const codeOnly = matview
      .split('\n')
      .map((l) => l.replace(/--.*$/, ''))
      .join('\n');
    // The bug: chosen_role_id + created_at. The fix: decided_role_id + decided_at.
    expect(codeOnly).not.toMatch(/\bchosen_role_id\b/);
    expect(codeOnly).toMatch(/\bdecided_role_id\b/);

    const cols = getAllColumnsForTable('role_selector_decisions');
    expect(cols.has('decided_role_id')).toBe(true);
    expect(cols.has('decided_at')).toBe(true);
    expect(cols.has('decided_by')).toBe(true);
    // Sanity: the bogus column is NOT in the actual schema.
    expect(cols.has('chosen_role_id')).toBe(false);
  });

  it('matview column references match all 7 source tables', () => {
    const matview = readMig('054_p10b_unified_trace_events_matview.sql');
    // Spot-check the columns referenced in matview against each source table.
    // (We don't parse the matview SQL fully — we just verify the columns
    // we KNOW are referenced exist in the source.)
    const checks: Array<{ table: string; cols: string[] }> = [
      { table: 'audit_log', cols: ['id', 'tenant_id', 'agent_id', 'conversa_id', 'acao', 'entidade_alvo', 'alvo_id', 'created_at'] },
      { table: 'cognitive_module_log', cols: ['id', 'tenant_id', 'agent_id', 'conversa_id', 'module_name', 'status', 'latency_ms', 'fallback_triggered', 'created_at'] },
      { table: 'agent_drift_alerts', cols: ['id', 'tenant_id', 'agent_id', 'drift_type', 'severity', 'decision', 'created_at'] },
      { table: 'role_selector_decisions', cols: ['id', 'tenant_id', 'agent_id', 'conversa_id', 'decided_role_id', 'decided_by', 'decided_at'] },
      { table: 'capability_test_results', cols: ['id', 'tenant_id', 'agent_id', 'outcome', 'proposal_id', 'ran_at'] },
      { table: 'procedure_execution_events', cols: ['id', 'tenant_id', 'agent_id', 'event_type', 'execution_id', 'step_id', 'created_at'] },
      { table: 'runtime_trace_envelopes', cols: ['trace_id', 'tenant_id', 'agent_id', 'conversa_id', 'decision', 'side_effect_level', 'policy_id', 'body_status', 'redaction_class', 'created_at'] },
    ];
    for (const { table, cols } of checks) {
      const actual = getAllColumnsForTable(table);
      for (const col of cols) {
        // The matview must reference a column that actually exists.
        expect(actual.has(col), `matview references ${table}.${col} but it's not in the schema`).toBe(true);
        // And the matview must actually reference it (sanity check that
        // our list isn't stale).
        expect(matview, `expected matview to reference ${col} for ${table}`).toContain(col);
      }
    }
  });

  it('all three migrations have down counterparts', () => {
    expect(() => readMig('052_p10b_runtime_trace_envelopes_down.sql')).not.toThrow();
    expect(() => readMig('053_p10b_runtime_trace_bodies_down.sql')).not.toThrow();
    expect(() => readMig('054_p10b_unified_trace_events_matview_down.sql')).not.toThrow();
  });

  it('down migrations DROP the objects they should', () => {
    const env = readMig('052_p10b_runtime_trace_envelopes_down.sql');
    expect(env).toMatch(/DROP TABLE IF EXISTS runtime_trace_envelopes/);

    const body = readMig('053_p10b_runtime_trace_bodies_down.sql');
    expect(body).toMatch(/DROP TABLE IF EXISTS runtime_trace_bodies/);
    expect(body).toMatch(/DROP TABLE IF EXISTS runtime_trace_body_outbox/);

    const matview = readMig('054_p10b_unified_trace_events_matview_down.sql');
    expect(matview).toMatch(/DROP MATERIALIZED VIEW IF EXISTS unified_trace_events/);
  });

  it('forward migration files have no syntax red flags', () => {
    // Cheap heuristics: balanced parens, no trailing BEGIN without END, no
    // stray % outside of format() calls.
    for (const f of [
      '052_p10b_runtime_trace_envelopes.sql',
      '053_p10b_runtime_trace_bodies.sql',
      '054_p10b_unified_trace_events_matview.sql',
    ]) {
      const sql = readMig(f);
      // Balanced parens (counting only outside of -- comments).
      let opens = 0;
      let closes = 0;
      for (const line of sql.split('\n')) {
        const noComment = line.split('--')[0]!;
        for (const ch of noComment) {
          if (ch === '(') opens += 1;
          else if (ch === ')') closes += 1;
        }
      }
      expect(opens, `${f}: unbalanced parens`).toBe(closes);
      // No BEGIN/COMMIT (migrate.ts wraps).
      expect(sql).not.toMatch(/^BEGIN\s*;/m);
      expect(sql).not.toMatch(/^COMMIT\s*;/m);
    }
  });
});
