/**
 * Issue #316 — pins the `idempotency_effect_outbox` Drizzle schema against
 * migrations 068 (table + unique key) and 069 (relayer hot-path index).
 *
 * A drift between the schema and the migrations would silently break the
 * relayer's read plan (or its exactly-once UNIQUE guarantee). This test
 * fails the build loudly if the columns, the (tenant_id, agent_id,
 * idempotency_key) UNIQUE, the relayer composite index, or the status /
 * failed-has-error CHECKs are removed or renamed.
 */
import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from '../../../src/db/schema.js';

interface DrizzleIndex {
  config: { name?: string; columns: Array<unknown>; unique?: boolean };
}

function indexSignatures(
  cfg: ReturnType<typeof getTableConfig>,
): Array<[string, string[], boolean]> {
  return (cfg.indexes as unknown as DrizzleIndex[]).map((idx) => {
    const name = idx.config.name ?? '<unnamed>';
    const cols = idx.config.columns.map((c) => (c as { name?: string }).name ?? '<expr>');
    return [name, cols, idx.config.unique ?? false];
  });
}

describe('issue #316 — idempotency_effect_outbox schema', () => {
  const cfg = getTableConfig(schema.idempotency_effect_outbox);

  it('table name matches the migration', () => {
    expect(cfg.name).toBe('idempotency_effect_outbox');
  });

  it('declares the columns the dispatcher + relayer read/write', () => {
    const cols = new Set(cfg.columns.map((c) => c.name));
    for (const expected of [
      'id',
      'tenant_id',
      'agent_id',
      'idempotency_key',
      'effect_type',
      'effect_payload',
      'status',
      'attempts',
      'max_attempts',
      'last_error',
      'next_attempt_at',
      'provider_ref',
      'created_at',
      'updated_at',
    ]) {
      expect(cols.has(expected), `missing column ${expected}`).toBe(true);
    }
  });

  it('tenant_id + agent_id are NOT NULL (inviolable isolation scope)', () => {
    const tenant = cfg.columns.find((c) => c.name === 'tenant_id');
    const agent = cfg.columns.find((c) => c.name === 'agent_id');
    expect(tenant!.notNull).toBe(true);
    expect(agent!.notNull).toBe(true);
  });

  it('exactly-once enqueue guard: UNIQUE (tenant_id, agent_id, idempotency_key)', () => {
    // `unique(...)` declares a table CONSTRAINT (not an index), so it lives in
    // cfg.uniqueConstraints (mirrors tests/unit/import-schema.spec.ts).
    const uniques = (cfg.uniqueConstraints as unknown as Array<{
      name?: string;
      columns: Array<{ name: string }>;
    }>).map((u) => ({ name: u.name, cols: u.columns.map((c) => c.name) }));
    expect(uniques).toContainEqual({
      name: 'idempotency_effect_outbox_tenant_agent_key',
      cols: ['tenant_id', 'agent_id', 'idempotency_key'],
    });
  });

  it('relayer hot-path index: (tenant_id, agent_id, status, next_attempt_at), non-unique', () => {
    expect(indexSignatures(cfg)).toContainEqual([
      'idx_idempotency_effect_outbox_tenant_agent_status_next',
      ['tenant_id', 'agent_id', 'status', 'next_attempt_at'],
      false,
    ]);
  });

  it('declares the status + failed-has-error CHECK constraints', () => {
    const checkNames = new Set(
      (cfg.checks as unknown as Array<{ name: string }>).map((c) => c.name),
    );
    expect(checkNames.has('idempotency_effect_outbox_status_chk')).toBe(true);
    expect(checkNames.has('idempotency_effect_outbox_failed_has_error_chk')).toBe(true);
  });
});
