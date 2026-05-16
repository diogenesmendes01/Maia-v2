import { describe, it, expect, beforeEach } from 'vitest';
import {
  _internal_cache,
  cacheKey,
  invalidateCacheForHolidayChange,
} from '../../src/lib/holidays-cache.js';

describe('holidays cache', () => {
  beforeEach(() => _internal_cache.clear());

  it('cacheKey is tenant-scoped', () => {
    const a = cacheKey('tenantA', undefined, 2026, 'standard');
    const b = cacheKey('tenantB', undefined, 2026, 'standard');
    expect(a).not.toBe(b);
    expect(a).toContain('tenantA');
  });

  it('key inclui tenant_id (cross-tenant isolation)', () => {
    const set = new Set(['2026-12-25']);
    _internal_cache.set(cacheKey('tenantA', undefined, 2026, 'standard'), set);
    expect(_internal_cache.get(cacheKey('tenantA', undefined, 2026, 'standard'))).toBe(set);
    expect(_internal_cache.get(cacheKey('tenantB', undefined, 2026, 'standard'))).toBeUndefined();
  });

  it('invalidateCacheForHolidayChange scopes to tenant', () => {
    _internal_cache.set(cacheKey('tenantA', undefined, 2026, 'standard'), new Set(['2026-12-25']));
    _internal_cache.set(cacheKey('tenantB', undefined, 2026, 'standard'), new Set(['2026-12-25']));
    invalidateCacheForHolidayChange(
      { tenant_id: 'tenantA', type: 'national' },
      { changeKind: 'create' },
    );
    expect(_internal_cache.get(cacheKey('tenantA', undefined, 2026, 'standard'))).toBeUndefined();
    expect(_internal_cache.get(cacheKey('tenantB', undefined, 2026, 'standard'))).toBeDefined();
  });
});
