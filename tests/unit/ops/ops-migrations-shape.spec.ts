import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as schema from '@/db/schema.js';

/**
 * Issue #520 — the migrations for backup evidence (101) and data lifecycle
 * (102) encode invariants that must not silently drift. This spec reads the
 * SQL directly so it runs WITHOUT Postgres (the integration suite exercises
 * the same tables against a real DB in
 * tests/integration/ops-data-lifecycle-real-db.spec.ts).
 */

const MIGRATIONS = join(process.cwd(), 'migrations');
const sql101 = readFileSync(join(MIGRATIONS, '101_backup_runs_manifests.sql'), 'utf8');
const sql102 = readFileSync(join(MIGRATIONS, '102_data_lifecycle.sql'), 'utf8');
const sql112 = readFileSync(join(MIGRATIONS, '112_restore_drill_cleanup_status.sql'), 'utf8');

/** SQL with `--` comments removed, so prose about a literal is not mistaken for it. */
function statementsOnly(sql: string): string {
  return sql
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');
}

const stmt101 = statementsOnly(sql101);
const stmt102 = statementsOnly(sql102);

describe('migrations are append-only with a _down sibling (AGENTS.md §4.6)', () => {
  it.each([
    '101_backup_runs_manifests',
    '102_data_lifecycle',
    '112_restore_drill_cleanup_status',
  ])('%s has both _up and _down', (name) => {
    expect(existsSync(join(MIGRATIONS, `${name}.sql`))).toBe(true);
    expect(existsSync(join(MIGRATIONS, `${name}_down.sql`))).toBe(true);
  });

  it('102 down drops in FK-safe order (tombstones before privacy_requests)', () => {
    const down = readFileSync(join(MIGRATIONS, '102_data_lifecycle_down.sql'), 'utf8');
    expect(down.indexOf('data_tombstones')).toBeLessThan(down.indexOf('privacy_requests'));
  });

  it('both down migrations warn that they destroy compliance evidence', () => {
    for (const f of ['101_backup_runs_manifests_down.sql', '102_data_lifecycle_down.sql']) {
      const body = readFileSync(join(MIGRATIONS, f), 'utf8');
      expect(body).toMatch(/dev\/CI/);
      expect(body).toMatch(/evid[êe]ncia/i);
    }
  });
});

describe('101 — backup evidence is scoped to the reserved `system` sentinel', () => {
  it.each(['backup_runs', 'backup_manifests', 'restore_drills'])(
    '%s pins tenant/agent to system and can never be `default`',
    (table) => {
      const re = new RegExp(`${table}_system_scope_chk[\\s\\S]*?tenant_id = 'system'`, 'm');
      expect(sql101).toMatch(re);
    },
  );

  it('never contains the legacy `default` literal in an executable statement', () => {
    expect(stmt101).not.toMatch(/'default'/);
  });

  it('enumerates exactly the 12 lifecycle states of the state machine', () => {
    for (const state of [
      'scheduled',
      'running',
      'dump_created',
      'locally_verified',
      'encrypted',
      'uploaded',
      'remotely_verified',
      'completed',
      'completed_degraded',
      'failed',
      'expired',
      'deleted',
    ]) {
      expect(sql101).toContain(`'${state}'`);
    }
  });

  it('enforces single-flight with a partial unique on non-terminal runs', () => {
    expect(sql101).toMatch(/backup_runs_single_active_uq[\s\S]*?WHERE state IN/);
  });

  it('refuses a terminal run without outcome, reason and finished_at', () => {
    expect(sql101).toMatch(/backup_runs_terminal_shape_chk/);
    expect(sql101).toMatch(/outcome IS NOT NULL AND outcome_reason IS NOT NULL/);
  });

  it('refuses a declared encryption mode without a key identifier', () => {
    expect(sql101).toMatch(/backup_runs_encryption_key_chk/);
  });

  it('binds a manifest 1:1 to its run (manifests are immutable)', () => {
    expect(sql101).toMatch(/backup_run_id uuid NOT NULL UNIQUE REFERENCES backup_runs/);
  });
});

describe('102 — data lifecycle is genuinely per-tenant', () => {
  it.each(['legal_holds', 'privacy_requests', 'data_tombstones', 'retention_runs'])(
    '%s rejects the legacy `default` literal fail-closed',
    (table) => {
      const re = new RegExp(
        `${table}_scope_chk CHECK \\(tenant_id <> 'default' AND agent_id <> 'default'\\)`,
      );
      expect(sql102).toMatch(re);
    },
  );

  it('never pins a lifecycle table to the `system` sentinel (that would collapse tenants)', () => {
    expect(stmt102).not.toMatch(/tenant_id = 'system'/);
  });

  it('requires identity verification before a privacy request leaves intake', () => {
    expect(sql102).toMatch(/privacy_requests_identity_chk/);
    expect(sql102).toMatch(/identity_verified_by IS NOT NULL AND identity_verified_at IS NOT NULL/);
  });

  it('refuses a privacy export without an expiry', () => {
    expect(sql102).toMatch(/privacy_requests_export_expiry_chk/);
  });

  it('refuses a released hold without releaser and timestamp', () => {
    expect(sql102).toMatch(/legal_holds_released_shape_chk/);
  });

  it('makes it impossible for a dry-run retention pass to record a deletion', () => {
    expect(sql102).toMatch(/retention_runs_dry_run_chk CHECK \(NOT dry_run OR deleted = 0\)/);
  });

  it('requires a tombstone to name a target', () => {
    expect(sql102).toMatch(/data_tombstones_target_chk/);
  });

  it('indexes tombstones by effective_at so the post-restore watermark query is bounded', () => {
    expect(sql102).toMatch(/data_tombstones_watermark_idx[\s\S]*?\(effective_at/);
  });

  it('codes hold reasons instead of storing free-text (no sensitive reason in logs)', () => {
    expect(sql102).toMatch(/reason_code text NOT NULL/);
  });

  it('hardcodes no legal retention period — deadlines stay configuration pending DPO', () => {
    // A column literally named `retention_days` with a baked-in DEFAULT would
    // be exactly the "suposição jurídica como fato" the issue forbids.
    expect(sql102).not.toMatch(/retention_days\s+integer\s+NOT NULL DEFAULT/);
    expect(sql102).toMatch(/DPO/);
  });
});

describe('112 — the drill teardown verdict is its own axis (issue #536, review of #541)', () => {
  it('defaults to `unknown`, never to `clean`', () => {
    // A row whose process died between `createDrill` and `finishDrill` must not
    // read as a host that was checked. `clean` here would manufacture the very
    // certification the column exists to withhold.
    expect(sql112).toMatch(/cleanup_status text NOT NULL DEFAULT 'unknown'/);
  });

  it('constrains the vocabulary in the database, not only in TypeScript', () => {
    expect(sql112).toMatch(
      /CHECK \(cleanup_status IN \('unknown', 'clean', 'unsafe'\)\)/,
    );
  });

  it('indexes the residue question, which is the one asked in an incident', () => {
    // Partial: the healthy answer is zero rows, so a full index over a column
    // that is 99% `clean` would not serve the query it exists for.
    expect(sql112).toMatch(/CREATE INDEX IF NOT EXISTS restore_drills_unsafe_idx[\s\S]*?WHERE cleanup_status = 'unsafe'/);
  });

  it('adds a column instead of overloading failure_code', () => {
    // The whole point: a probe failure and a teardown failure are different
    // diagnoses that can happen together, and one column cannot hold both
    // without the first masking the second.
    expect(sql112).not.toMatch(/DROP COLUMN/);
    expect(sql112).toMatch(/ADD COLUMN IF NOT EXISTS cleanup_status/);
  });
});

describe('Drizzle schema mirrors the migrations', () => {
  it.each([
    'backup_runs',
    'backup_manifests',
    'restore_drills',
    'legal_holds',
    'privacy_requests',
    'data_tombstones',
    'retention_runs',
  ])('exports %s', (table) => {
    expect((schema as Record<string, unknown>)[table]).toBeDefined();
  });

  it('backup_runs carries the evidence columns the manifest needs', () => {
    const cols = Object.keys(schema.backup_runs);
    for (const c of [
      'correlation_id',
      'state',
      'outcome',
      'outcome_reason',
      'artifact_ref',
      'sha256',
      'encryption_mode',
      'encryption_key_id',
      'destination_locator',
      'local_verified',
      'remote_verified',
      'tombstone_watermark',
      'error_code',
    ]) {
      expect(cols).toContain(c);
    }
  });

  it('stores a key IDENTIFIER, never key material', () => {
    const cols = Object.keys(schema.backup_runs);
    expect(cols).toContain('encryption_key_id');
    expect(cols).not.toContain('encryption_key');
    expect(cols.some((c) => /secret|password|keyring/i.test(c))).toBe(false);
  });

  it('tombstones store pseudonymised references, not raw identifiers', () => {
    const cols = Object.keys(schema.data_tombstones);
    expect(cols).toContain('subject_ref');
    expect(cols).toContain('hmac');
    expect(cols.some((c) => /telefone|phone|email|nome/i.test(c))).toBe(false);
  });
});
