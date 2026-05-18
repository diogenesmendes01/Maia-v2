/**
 * rules-resolver — regression test for the cross-tenant leak vector
 * called out in the adversarial review (PR #94 blocker #1).
 *
 * The bug was: `.where(and(tenant + lifecycle)).where(ilike(...))`.
 * Pre-Drizzle 0.29 the second `.where()` SILENTLY substitutes the first,
 * which means `intent_filter` queries returned rows from every tenant.
 *
 * The contract we lock in: `.where()` is called EXACTLY ONCE, and ALL
 * filters (including the optional `ilike` from `intent_filter`) are
 * inside that single `and(...)`.
 *
 * Drizzle SQL expressions are circular (table ↔ column back-refs) so we
 * can't JSON.stringify the root. Instead we walk the tree extracting
 * string params from `.value` and `.queryChunks` recursively.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/db/tenant-context.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/db/tenant-context.js')>(
    '@/db/tenant-context.js',
  );
  return { ...actual, tryGetCurrentContext: () => null };
});

// Capture the chain so we can assert on it.
const whereSpy = vi.fn();
const limitSpy = vi.fn().mockResolvedValue([]);
const orderBySpy = vi.fn(() => ({ limit: limitSpy }));
const fromSpy = vi.fn(() => ({
  where: whereSpy.mockReturnValue({ orderBy: orderBySpy }),
}));
const selectSpy = vi.fn(() => ({ from: fromSpy }));

vi.mock('@/db/client.js', () => ({
  db: {
    select: (...args: unknown[]) => selectSpy(...args),
  },
}));

import { rulesResolver } from '@/user-layer/resolvers/rules-resolver.js';

// Safe walker — Drizzle SQL roots are circular; we extract string params only.
function collectStringParams(node: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 8 || node == null) return out;
  if (typeof node === 'string') {
    out.push(node);
    return out;
  }
  if (typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) collectStringParams(item, depth + 1, out);
    return out;
  }
  const n = node as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(n, 'value')) {
    collectStringParams(n.value, depth + 1, out);
  }
  if (Array.isArray(n.queryChunks)) {
    collectStringParams(n.queryChunks, depth + 1, out);
  }
  if (Array.isArray(n.params)) {
    collectStringParams(n.params, depth + 1, out);
  }
  return out;
}

describe('rulesResolver.list — tenant isolation regression', () => {
  beforeEach(() => {
    whereSpy.mockClear();
    limitSpy.mockClear();
    orderBySpy.mockClear();
    fromSpy.mockClear();
    selectSpy.mockClear();
    whereSpy.mockReturnValue({ orderBy: orderBySpy });
  });

  it('calls .where() exactly once even when intent_filter is set (no chained .where)', async () => {
    await rulesResolver.list({
      tenant_id: 't-a',
      intent_filter: 'aluguel',
      only_active: true,
      limit: 10,
    });

    expect(whereSpy).toHaveBeenCalledTimes(1);
  });

  it('calls .where() exactly once even with no intent_filter', async () => {
    await rulesResolver.list({
      tenant_id: 't-a',
      only_active: true,
      limit: 10,
    });

    expect(whereSpy).toHaveBeenCalledTimes(1);
  });

  it('the single .where() expression carries the tenant guard', async () => {
    await rulesResolver.list({
      tenant_id: 't-a',
      intent_filter: 'aluguel',
      only_active: true,
      limit: 10,
    });

    const expr = whereSpy.mock.calls[0]?.[0];
    expect(expr).toBeDefined();
    const params = collectStringParams(expr);
    expect(params).toContain('t-a');
  });
});
