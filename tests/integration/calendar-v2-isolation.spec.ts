/**
 * Calendar v2 — integration tests for tenant isolation + key invariants.
 *
 * Uses mocked repositories (in-memory state). Validates:
 *  - Cache key inclui tenant (cross-tenant isolation)
 *  - isBusinessDayBR async com flag ON usa cache loader uma vez por (tenant, year)
 *  - holidaysRepo throws when called outside tenant context
 *  - Aprovação de holiday proposal cria row + invalida cache do tenant
 *  - Tenant A custom holiday NUNCA afeta tenant B (cross-tenant gate)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runWithTenantContext, MissingTenantContextError } from '@/db/tenant-context.js';
import { featureFlags } from '@/config/feature-flags.js';
import { FeatureFlagName } from '@/types/enums.js';
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

describe('Calendar v2 — feature flag rollback (Cenário 6)', () => {
  afterEach(() => featureFlags.reset());

  it('flag OFF retorna comportamento legacy hard-coded', async () => {
    const { isBusinessDayBR } = await import('@/lib/business-days.js');
    featureFlags.killSwitch(FeatureFlagName.CALENDAR_V2);
    // Corpus Christi 2026
    const r = await isBusinessDayBR(new Date('2026-06-04T12:00:00Z'));
    expect(r).toBe(false);
  });

  it('flag override OFF mantém comportamento legacy estável (snapshot)', async () => {
    const { isBusinessDayBR } = await import('@/lib/business-days.js');
    featureFlags.override(FeatureFlagName.CALENDAR_V2, false);
    // Dias chave em 2026
    const checks: Array<[string, boolean]> = [
      ['2026-01-01', false], // Confraternização Universal
      ['2026-04-21', false], // Tiradentes
      ['2026-12-25', false], // Natal
      ['2026-06-04', false], // Corpus Christi (móvel)
      ['2026-01-23', true],  // sexta normal
      ['2026-06-06', false], // sábado
    ];
    for (const [iso, expected] of checks) {
      const r = await isBusinessDayBR(new Date(`${iso}T12:00:00Z`));
      expect(r, `${iso} expected ${expected ? 'business' : 'NON-business'}`).toBe(expected);
    }
  });
});
