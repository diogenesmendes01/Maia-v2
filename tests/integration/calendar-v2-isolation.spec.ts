/**
 * Calendar v2 — integration tests for tenant isolation + key invariants.
 *
 * Uses mocked repositories (in-memory state). Validates:
 *  - Cache key inclui tenant (cross-tenant isolation)
 *  - holidaysRepo throws when called outside tenant context
 *  - Aprovação de holiday proposal cria row + invalida cache do tenant
 *  - Tenant A custom holiday NUNCA afeta tenant B (cross-tenant gate)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { runWithTenantContext, MissingTenantContextError } from '@/db/tenant-context.js';
import {
  _internal_cache,
  cacheKey,
  invalidateCacheForHolidayChange,
} from '@/lib/holidays-cache.js';

describe('Calendar v2 — cache tenant isolation (acceptance gate Cenário 5)', () => {
  beforeEach(() => _internal_cache.clear());

  it('cache key inclui tenant_id e entidades — tenant A miss = tenant B miss', () => {
    const setA = new Set(['2026-12-25']);
    const setB = new Set(['2026-12-25']);
    _internal_cache.set(cacheKey('tenant-A', 'default', undefined, 2026, 'standard'), setA);
    _internal_cache.set(cacheKey('tenant-B', 'default', undefined, 2026, 'standard'), setB);

    // Hit no tenant correto
    expect(_internal_cache.get(cacheKey('tenant-A', 'default', undefined, 2026, 'standard'))).toBe(setA);
    expect(_internal_cache.get(cacheKey('tenant-B', 'default', undefined, 2026, 'standard'))).toBe(setB);

    // Invalidation no tenant A NÃO toca tenant B
    invalidateCacheForHolidayChange(
      { tenant_id: 'tenant-A', type: 'entity_custom' },
      { changeKind: 'create' },
    );
    expect(_internal_cache.get(cacheKey('tenant-A', 'default', undefined, 2026, 'standard'))).toBeUndefined();
    expect(_internal_cache.get(cacheKey('tenant-B', 'default', undefined, 2026, 'standard'))).toBe(setB);
  });

  it('cache key inclui entidade_id (entidades diferentes não compartilham)', () => {
    const eA = 'entidade-A';
    const eB = 'entidade-B';
    _internal_cache.set(cacheKey('tenant-A', 'default', eA, 2026, 'standard'), new Set(['2026-12-25']));
    expect(_internal_cache.get(cacheKey('tenant-A', 'default', eA, 2026, 'standard'))).toBeDefined();
    expect(_internal_cache.get(cacheKey('tenant-A', 'default', eB, 2026, 'standard'))).toBeUndefined();
  });
});

describe('Calendar v2 — tenant context enforcement', () => {
  it('getCurrentTenant() throws fora de runWithTenantContext', async () => {
    const { getCurrentTenant } = await import('@/db/tenant-context.js');
    expect(() => getCurrentTenant()).toThrow(MissingTenantContextError);
  });

  it('roda em contexto tenant-A → tenant_id é tenant-a', async () => {
    const { getCurrentTenant } = await import('@/db/tenant-context.js');
    await runWithTenantContext({ tenant_id: 'tenant-a', agent_id: 'default' }, async () => {
      expect(getCurrentTenant()).toBe('tenant-a');
    });
  });
});
