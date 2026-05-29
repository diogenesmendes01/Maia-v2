/**
 * Issue #281 (redesigned in PR #310) — verifies the Drizzle schema
 * declares the KSM auto-promoter lifecycle PARTIAL indexes added by
 * migration 065 on all FOUR knowledge tables (agent_facts, memory_entry,
 * behavioral_hint, learned_rules).
 *
 * Why the redesign
 * ----------------
 * The first cut declared `(tenant_id, agent_id, id)` composite indexes to
 * "help" the KSM facade's `findById`/`update` queries
 * (src/control-plane/knowledge-state-machine/repos.ts), which filter by
 * `WHERE id = $1 AND tenant_id = $2 AND agent_id = $3`. That was
 * redundant: `id` is the PRIMARY KEY (a defaultRandom() UUID), so the PK
 * index already locates exactly one row and tenant_id/agent_id are a
 * cheap filter on that single tuple.
 *
 * The real hot path is the auto-promoter
 * (src/workers/knowledge-state-promoter.ts → repos.ts `listEligible`),
 * which sweeps `WHERE lifecycle_status = $1 AND <updated_at / evidence
 * filter> LIMIT 100` hourly across all four tables. Two partial indexes
 * per table serve it:
 *   - `*_lifecycle_inflight` on (lifecycle_status, updated_at) WHERE
 *     lifecycle_status IN ('ephemeral','observed','reinforced','verified')
 *   - `*_lifecycle_active` on (lifecycle_status, last_recall_at,
 *     updated_at) WHERE lifecycle_status = 'active'
 *
 * This test pins the index *names*, *column tuples*, and *partiality* so
 * any drift from migration 065 breaks the build loudly (rather than
 * silently regressing the promoter's read plan in production).
 */
import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from '../../../src/db/schema.js';

interface DrizzleIndex {
  config: {
    name?: string;
    columns: Array<unknown>;
    where?: unknown;
    unique?: boolean;
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

function findIndex(
  table: ReturnType<typeof getTableConfig>,
  name: string,
): DrizzleIndex | undefined {
  return (table.indexes as unknown as DrizzleIndex[]).find(
    (idx) => idx.config.name === name,
  );
}

const KSM_TABLES = [
  { table: schema.agent_facts, prefix: 'idx_agent_facts' },
  { table: schema.memory_entry, prefix: 'idx_memory_entry' },
  { table: schema.behavioral_hint, prefix: 'idx_behavioral_hint' },
  { table: schema.learned_rules, prefix: 'idx_learned_rules' },
] as const;

describe('issue #281 (PR #310 redesign) — KSM lifecycle partial indexes', () => {
  for (const { table, prefix } of KSM_TABLES) {
    const cfg = getTableConfig(table);

    it(`${cfg.name} declares ${prefix}_lifecycle_inflight on (lifecycle_status, updated_at)`, () => {
      expect(indexSignatures(cfg)).toContainEqual([
        `${prefix}_lifecycle_inflight`,
        ['lifecycle_status', 'updated_at'],
      ]);
    });

    it(`${cfg.name} declares ${prefix}_lifecycle_active on (lifecycle_status, last_recall_at, updated_at)`, () => {
      expect(indexSignatures(cfg)).toContainEqual([
        `${prefix}_lifecycle_active`,
        ['lifecycle_status', 'last_recall_at', 'updated_at'],
      ]);
    });

    it(`${cfg.name} lifecycle indexes are PARTIAL (carry a WHERE predicate)`, () => {
      const inflight = findIndex(cfg, `${prefix}_lifecycle_inflight`);
      const active = findIndex(cfg, `${prefix}_lifecycle_active`);
      expect(inflight, `${prefix}_lifecycle_inflight missing`).toBeDefined();
      expect(active, `${prefix}_lifecycle_active missing`).toBeDefined();
      // Partial indexes set `config.where` to an SQL object; a non-partial
      // index leaves it undefined. This guards against accidentally
      // dropping the `WHERE lifecycle_status ...` clause (which would
      // bloat the index to cover the whole table).
      expect(inflight!.config.where, 'inflight index must be partial').toBeDefined();
      expect(active!.config.where, 'active index must be partial').toBeDefined();
    });

    it(`${cfg.name} lifecycle indexes are non-unique`, () => {
      const inflight = findIndex(cfg, `${prefix}_lifecycle_inflight`);
      const active = findIndex(cfg, `${prefix}_lifecycle_active`);
      // We use `index()` (not `uniqueIndex()`), so `unique` must be falsy.
      expect(inflight!.config.unique ?? false).toBe(false);
      expect(active!.config.unique ?? false).toBe(false);
    });
  }

  it('the redundant (tenant_id, agent_id, id) composite indexes are gone', () => {
    // Regression guard for the B1 blocker: these were redundant with the
    // PK on `id` and must not creep back in.
    const removed = [
      'idx_agent_facts_tenant_agent_id',
      'idx_memory_entry_tenant_agent_id',
      'idx_behavioral_hint_tenant_agent_id',
    ];
    for (const { table } of KSM_TABLES) {
      const names = (getTableConfig(table).indexes as unknown as DrizzleIndex[]).map(
        (idx) => idx.config.name,
      );
      for (const gone of removed) {
        expect(names).not.toContain(gone);
      }
    }
  });
});
