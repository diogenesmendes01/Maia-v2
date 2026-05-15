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
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rulesResolver } from '@/user-layer/resolvers/rules-resolver.js';

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

    // Drizzle's `and(...)` returns an opaque SQL object — serialise to JSON
    // so we can grep for the tenant_id literal injected via `eq(..., 't-a')`.
    const expr = whereSpy.mock.calls[0]?.[0];
    expect(expr).toBeDefined();
    const serialised = JSON.stringify(expr);
    expect(serialised).toContain('t-a');
  });
});
