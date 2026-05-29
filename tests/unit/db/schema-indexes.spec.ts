/**
 * Issue #281 — verifies the Drizzle schema declares the composite
 * `(tenant_id, agent_id, id)` indexes added by migration 065 on the
 * three KSM-backed tables (agent_facts, memory_entry, behavioral_hint).
 *
 * Why
 * ---
 * The KSM facade (`src/control-plane/knowledge-state-machine/repos.ts`)
 * scopes every `findById`/`update` by `(id, tenant_id, agent_id)` since
 * PR #243 (rules) and PR #267 (facts/memory/behavioral_hint). The PK
 * on `id` alone forces a PK-scan + filter step; the composite indexes
 * enable an index-only scan.
 *
 * This test pins the index *names* and *column tuples* declared in
 * `src/db/schema.ts` so any drift from migration 065 breaks the build
 * loudly (rather than silently regressing the read plan in production).
 */
import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from '../../../src/db/schema.js';

interface DrizzleIndex {
  config: {
    name?: string;
    columns: Array<unknown>;
  };
}

/**
 * Extract `[index_name, [col_names...]]` tuples from a Drizzle table
 * config. Each column carries a `name` property at runtime even though
 * the public type is wider — mirroring the pattern in
 * tests/unit/import-schema.spec.ts.
 */
function indexSignatures(
  cfg: ReturnType<typeof getTableConfig>,
): Array<[string, string[]]> {
  return (cfg.indexes as unknown as DrizzleIndex[]).map((idx) => {
    const name = idx.config.name ?? '<unnamed>';
    const cols = idx.config.columns.map(
      (c) => (c as { name?: string }).name ?? '<expr>',
    );
    return [name, cols];
  });
}

describe('issue #281 — KSM composite (tenant_id, agent_id, id) indexes', () => {
  it('agent_facts declares idx_agent_facts_tenant_agent_id on (tenant_id, agent_id, id)', () => {
    const cfg = getTableConfig(schema.agent_facts);
    expect(indexSignatures(cfg)).toContainEqual([
      'idx_agent_facts_tenant_agent_id',
      ['tenant_id', 'agent_id', 'id'],
    ]);
  });

  it('memory_entry declares idx_memory_entry_tenant_agent_id on (tenant_id, agent_id, id)', () => {
    const cfg = getTableConfig(schema.memory_entry);
    expect(indexSignatures(cfg)).toContainEqual([
      'idx_memory_entry_tenant_agent_id',
      ['tenant_id', 'agent_id', 'id'],
    ]);
  });

  it('behavioral_hint declares idx_behavioral_hint_tenant_agent_id on (tenant_id, agent_id, id)', () => {
    const cfg = getTableConfig(schema.behavioral_hint);
    expect(indexSignatures(cfg)).toContainEqual([
      'idx_behavioral_hint_tenant_agent_id',
      ['tenant_id', 'agent_id', 'id'],
    ]);
  });

  it('all three indexes are non-unique (PK already enforces uniqueness on id)', () => {
    const tables = [
      schema.agent_facts,
      schema.memory_entry,
      schema.behavioral_hint,
    ] as const;
    for (const table of tables) {
      const cfg = getTableConfig(table);
      const composite = (cfg.indexes as unknown as DrizzleIndex[]).find(
        (idx) =>
          idx.config.name?.endsWith('_tenant_agent_id') &&
          idx.config.columns.length === 3,
      );
      expect(composite).toBeDefined();
      // `unique` is the IndexConfig flag set by Drizzle's `index()` vs
      // `uniqueIndex()` builders. We use `index()`, so this must be false.
      expect(
        (composite as unknown as { config: { unique: boolean } }).config.unique,
      ).toBe(false);
    }
  });
});
