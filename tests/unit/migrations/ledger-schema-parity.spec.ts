/**
 * Issue #516 §2 — the ledger v2 DDL exists in TWO places on purpose, and this
 * spec is what keeps them honest.
 *
 *   - `src/migrations/ledger.ts` `LEDGER_V2_DDL` bootstraps the table, because
 *     the ledger must exist BEFORE migration 001 can be recorded in it;
 *   - `migrations/108_schema_migrations_v2.sql` carries the identical
 *     idempotent DDL so the change is reviewable and reversible like every
 *     other schema change (AGENTS.md §4 rule 6).
 *
 * Drift between them is exactly the failure this guards: a column added to the
 * bootstrap but not to the migration would exist on machines that ran the
 * binary and be missing on machines that ran `psql -f`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEDGER_V2_COLUMNS, LEDGER_V2_DDL, LEDGER_TABLE } from '@/migrations/ledger.js';

const DIR = join(process.cwd(), 'migrations');
const UP = readFileSync(join(DIR, '108_schema_migrations_v2.sql'), 'utf8');
const DOWN = readFileSync(join(DIR, '108_schema_migrations_v2_down.sql'), 'utf8');

describe('ledger v2 — migration 108 mirrors the runner bootstrap', () => {
  it('adds every v2 column, idempotently', () => {
    for (const column of LEDGER_V2_COLUMNS) {
      expect(UP, `108 is missing ${column}`).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
      expect(LEDGER_V2_DDL.join('\n')).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
    }
  });

  it('creates the table with IF NOT EXISTS (the runner may have created it first)', () => {
    expect(UP).toContain(`CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE}`);
    expect(LEDGER_V2_DDL[0]).toContain(`CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE}`);
  });

  it('drops NOT NULL on applied_at so a `running` row is representable', () => {
    expect(UP).toContain('ALTER COLUMN applied_at DROP NOT NULL');
    expect(LEDGER_V2_DDL.join('\n')).toContain('ALTER COLUMN applied_at DROP NOT NULL');
  });

  it('constrains status and checksum_source to the documented vocabularies', () => {
    for (const source of [UP, LEDGER_V2_DDL.join('\n')]) {
      expect(source).toContain("CHECK (status IN ('running', 'applied', 'dirty', 'failed'))");
      expect(source).toContain("IN ('computed', 'backfilled')");
      // Idempotent constraint creation — re-running must not error.
      expect(source).toContain('EXCEPTION WHEN duplicate_object THEN NULL');
    }
  });

  it('keeps the v1 runner able to write: applied_at keeps its default', () => {
    // The old runner does `INSERT INTO schema_migrations (id) VALUES ($1)`.
    expect(UP).toContain('applied_at TIMESTAMPTZ NOT NULL DEFAULT now()');
    expect(UP).toContain("status TEXT NOT NULL DEFAULT 'applied'");
  });
});

describe('ledger v2 — the down migration truly reverses the up', () => {
  it('drops every column the up adds', () => {
    for (const column of LEDGER_V2_COLUMNS) {
      expect(DOWN, `down is missing ${column}`).toContain(`DROP COLUMN IF EXISTS ${column}`);
    }
  });

  it('drops both constraints and restores NOT NULL on applied_at', () => {
    expect(DOWN).toContain('DROP CONSTRAINT IF EXISTS schema_migrations_status_check');
    expect(DOWN).toContain('DROP CONSTRAINT IF EXISTS schema_migrations_checksum_source_check');
    expect(DOWN).toContain('ALTER COLUMN applied_at SET NOT NULL');
  });

  it('never drops the ledger itself — the applied history must survive', () => {
    expect(DOWN).not.toMatch(/DROP TABLE/i);
    expect(DOWN).not.toMatch(/DELETE FROM/i);
  });
});

describe('ledger v2 — reservation ledger', () => {
  it('is reserved in migrations/RESERVATIONS.md', () => {
    const reservations = readFileSync(join(DIR, 'RESERVATIONS.md'), 'utf8');
    expect(reservations).toContain('108 | 108_schema_migrations_v2.sql |');
  });
});
