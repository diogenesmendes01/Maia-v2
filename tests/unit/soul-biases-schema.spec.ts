/**
 * P8b — Schema verification for `soul_biases` table.
 *
 * These tests only inspect the Drizzle table object (no DB connection).
 * They guard against accidentally dropping invariant columns or removing the
 * DEFAULT 'proposed' status (invariante 5 do master spec §15).
 */
import { describe, it, expect } from 'vitest';
import { soul_biases } from '@/db/schema.js';

describe('soul_biases — schema (P8b)', () => {
  it('exposes the required columns', () => {
    const cols = Object.keys(soul_biases);
    const required = [
      'id',
      'tenant_id',
      'agent_id',
      'scope',
      'scope_value',
      'principle',
      'guidance',
      'origin',
      'strength',
      'activation_context',
      'status',
      'version',
      'previous_version_id',
      'proposed_by',
      'proposed_reason',
      'approved_by',
      'approved_at',
      'activated_at',
      'deprecated_at',
      'deprecated_reason',
      'rolled_back_at',
      'rollback_reason',
      'proposal_id',
      'source_drift_alert_id',
      'created_at',
    ];
    for (const c of required) {
      expect(cols).toContain(c);
    }
  });

  it('status column defaults to proposed (invariante 5)', () => {
    // Drizzle stores the default value on the column object.
    const statusCol = (soul_biases as unknown as Record<string, { default?: unknown }>).status;
    expect(statusCol?.default).toBe('proposed');
  });

  it('declares status NOT NULL + version NOT NULL + principle NOT NULL', () => {
    const cols = soul_biases as unknown as Record<string, { notNull?: boolean }>;
    expect(cols.status?.notNull).toBe(true);
    expect(cols.version?.notNull).toBe(true);
    expect(cols.principle?.notNull).toBe(true);
    expect(cols.guidance?.notNull).toBe(true);
    expect(cols.origin?.notNull).toBe(true);
    expect(cols.scope?.notNull).toBe(true);
    expect(cols.tenant_id?.notNull).toBe(true);
    expect(cols.agent_id?.notNull).toBe(true);
  });
});
