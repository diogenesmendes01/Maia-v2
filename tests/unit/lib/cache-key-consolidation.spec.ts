/**
 * Issue #287 — consolidation of ad-hoc cache-key builders onto the
 * centralized `buildCacheKey()` helper (`src/lib/cache-key.ts`).
 *
 * This spec covers the PURE, EXPORTED key builders that previously
 * interpolated tenant/agent segments by hand:
 *
 *   - `user-layer/internal/cache-keys.ts` (user + knowledge slices)
 *   - `runtime/context-packet/cache/slice-cache.ts` (`sliceCacheKey` +
 *     tenant-wide invalidation patterns)
 *   - `lib/holidays-cache.ts` (`cacheKey` + tenant-wide invalidation prefix)
 *   - `skills/skill-slice-builder.ts` (`skillSliceCacheKey`) +
 *     `skills/cache.ts` (`invalidateSkillSliceCacheForTenant` prefix)
 *
 * The Redis-backed builders with module-private key functions
 * (bot-detection, rate-limit, dedup, debouncer, working memory, vision
 * cache) are covered by #287 additions inside their existing cross-tenant
 * specs, where the redis stubs already capture the emitted key strings.
 *
 * Two properties are load-bearing for every builder:
 *
 *   1. PARITY — the emitted key is EXACTLY what `buildCacheKey(prefix,
 *      ...segments)` produces (proves the call site routes through the
 *      central helper rather than reimplementing encoding locally).
 *   2. KEY COMPATIBILITY — for the production id charset (admin-UI slugs
 *      `[a-z0-9][a-z0-9_-]*`, UUIDs, hex hashes, enum literals) the key is
 *      byte-identical to the pre-#287 format, so NO version bump was needed
 *      and no live cache entry is orphaned by this consolidation.
 *
 * Plus the encoding upgrades the consolidation buys for free:
 *   - `:`-aliasing between segments is impossible (`acme:dev`+`x` vs
 *     `acme`+`dev:x`).
 *   - glob metachars (`* ? [ ] !`) are neutralized, so tenant-wide
 *     invalidation prefixes/patterns can never widen across tenants.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildCacheKey } from '@/lib/cache-key.js';
import {
  buildUserSliceCacheKey,
  buildKnowledgeSliceCacheKey,
} from '@/user-layer/internal/cache-keys.js';
import {
  sliceCacheKey,
  InMemorySliceCache,
} from '@/runtime/context-packet/cache/slice-cache.js';
import { cacheKey as holidaysCacheKey } from '@/lib/holidays-cache.js';

// `skill-slice-builder.ts` imports `skillsRepo` from the repositories barrel;
// stub it so this stays a pure unit spec (the key builder itself never
// touches the repo).
vi.mock('@/db/repositories.js', () => ({ skillsRepo: {} }));

const { skillSliceCacheKey } = await import('@/skills/skill-slice-builder.js');
const { sliceCache, invalidateSkillSliceCacheForTenant } = await import(
  '@/skills/cache.js'
);

// ---------------------------------------------------------------------------
// user-layer/internal/cache-keys.ts
// ---------------------------------------------------------------------------
describe('#287 — user-layer slice cache keys route through buildCacheKey', () => {
  const base = {
    tenant_id: 'tenant-a',
    agent_id: 'agent-1',
    pessoa_id: 'pessoa-1',
    depth: 'relevant',
  };

  it('user slice key is byte-identical to the pre-#287 raw interpolation for production ids (no bump needed)', () => {
    const key = buildUserSliceCacheKey(base);
    expect(key).toBe('user_slice:v2:tenant-a:agent-1:pessoa-1:relevant:none:default');
  });

  it('user slice key equals the buildCacheKey composition (parity)', () => {
    const key = buildUserSliceCacheKey(base);
    expect(key).toBe(
      buildCacheKey(
        'user_slice:v2:',
        base.tenant_id,
        base.agent_id,
        base.pessoa_id,
        base.depth,
        'none',
        'default',
      ),
    );
  });

  it('a `:` inside tenant_id can no longer alias across the tenant/agent boundary', () => {
    const a = buildUserSliceCacheKey({ ...base, tenant_id: 'acme:dev', agent_id: 'x' });
    const b = buildUserSliceCacheKey({ ...base, tenant_id: 'acme', agent_id: 'dev:x' });
    expect(a).not.toBe(b);
    expect(a).toContain('acme%3Adev');
  });

  it('glob metachars in ids are neutralized', () => {
    const key = buildUserSliceCacheKey({ ...base, tenant_id: 'acme*' });
    expect(key).toContain('acme%2A');
    expect(/[*?[\]!]/.test(key.slice('user_slice:v2:'.length))).toBe(false);
  });

  it('knowledge slice key is byte-identical to the pre-#287 format AND matches buildCacheKey (parity)', () => {
    const key = buildKnowledgeSliceCacheKey({
      tenant_id: 'tenant-a',
      agent_id: 'agent-1',
      depth: 'relevant',
    });
    expect(key).toBe('knowledge_slice:v2:tenant-a:agent-1:relevant:default:global:none');
    expect(key).toBe(
      buildCacheKey(
        'knowledge_slice:v2:',
        'tenant-a',
        'agent-1',
        'relevant',
        'default',
        'global',
        'none',
      ),
    );
  });

  it('knowledge slice: a `:` inside the free-form domain cannot bleed into the intent slot', () => {
    const a = buildKnowledgeSliceCacheKey({
      tenant_id: 't',
      agent_id: 'a',
      depth: 'relevant',
      domain: 'fin:ops',
    });
    expect(a).toContain('fin%3Aops');
  });
});

// ---------------------------------------------------------------------------
// runtime/context-packet/cache/slice-cache.ts
// ---------------------------------------------------------------------------
describe('#287 — sliceCacheKey routes through buildCacheKey', () => {
  it('is byte-identical to the pre-#287 raw interpolation for production ids (no bump needed)', () => {
    expect(sliceCacheKey('tenant1', 'agentA', 'identity', 'abc123')).toBe(
      'maia:context:v2:tenant1:agentA:identity:abc123',
    );
  });

  it('equals the buildCacheKey composition (parity)', () => {
    expect(sliceCacheKey('tenant1', 'agentA', 'identity', 'abc123')).toBe(
      buildCacheKey('maia:context:v2:', 'tenant1', 'agentA', 'identity', 'abc123'),
    );
  });

  it('a `:` in tenant_id cannot alias across the tenant/agent boundary', () => {
    const a = sliceCacheKey('acme:dev', 'x', 'identity', 'h');
    const b = sliceCacheKey('acme', 'dev:x', 'identity', 'h');
    expect(a).not.toBe(b);
  });

  it('invalidateSliceForTenant("acme") does NOT clear tenant "acme:dev" entries (delimiter aliasing)', async () => {
    const cache = new InMemorySliceCache();
    await cache.set(sliceCacheKey('acme', 'agentA', 'identity', 'h1'), { a: 1 }, 300);
    await cache.set(sliceCacheKey('acme:dev', 'agentA', 'identity', 'h1'), { b: 2 }, 300);

    const removed = await cache.invalidateSliceForTenant('acme', 'identity');
    expect(removed).toBe(1);
    expect(await cache.get(sliceCacheKey('acme', 'agentA', 'identity', 'h1'))).toBeNull();
    expect(await cache.get(sliceCacheKey('acme:dev', 'agentA', 'identity', 'h1'))).toEqual({
      b: 2,
    });
  });

  it('a glob metachar in tenant_id cannot widen the invalidation pattern across tenants', async () => {
    const cache = new InMemorySliceCache();
    // A literal-`*` tenant must invalidate ONLY itself — pre-#287 the raw
    // `*` in the MATCH pattern would have matched EVERY tenant.
    await cache.set(sliceCacheKey('*', 'agentA', 'identity', 'h1'), { star: 1 }, 300);
    await cache.set(sliceCacheKey('tenant1', 'agentA', 'identity', 'h1'), { t1: 1 }, 300);

    const removed = await cache.invalidateSliceForTenant('*', 'identity');
    expect(removed).toBe(1);
    expect(await cache.get(sliceCacheKey('tenant1', 'agentA', 'identity', 'h1'))).toEqual({
      t1: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// lib/holidays-cache.ts
// ---------------------------------------------------------------------------
describe('#287 — holidays cacheKey routes through buildCacheKey', () => {
  it('is byte-identical to the pre-#287 inline encodeURIComponent concat (no bump needed)', () => {
    expect(holidaysCacheKey('tenant-a', 'agent-1', 'ent-1', 2026, 'clt')).toBe(
      'holidays:v3:tenant-a:agent-1:ent-1:2026:clt',
    );
    expect(holidaysCacheKey('tenant-a', 'agent-1', undefined, 2026, 'standard')).toBe(
      'holidays:v3:tenant-a:agent-1:global:2026:standard',
    );
  });

  it('equals the buildCacheKey composition (parity)', () => {
    expect(holidaysCacheKey('tenant-a', 'agent-1', 'ent-1', 2026, 'clt')).toBe(
      buildCacheKey('holidays:v3:', 'tenant-a', 'agent-1', 'ent-1', 2026, 'clt'),
    );
  });

  it('neutralizes glob metachars that inline encodeURIComponent left raw', () => {
    const key = holidaysCacheKey('acme*', 'agent!', 'ent-1', 2026, 'standard');
    expect(key).toContain('acme%2A');
    expect(key).toContain('agent%21');
  });
});

// ---------------------------------------------------------------------------
// skills/skill-slice-builder.ts + skills/cache.ts
// ---------------------------------------------------------------------------
describe('#287 — skillSliceCacheKey routes through buildCacheKey', () => {
  beforeEach(async () => {
    await sliceCache.clear();
  });

  it('is byte-identical to the pre-#287 format for UUID skill ids and slug tenants', () => {
    // (Process-local cache — even a format change would carry zero risk, but
    // for the production charset minus the `,` join it happens to match.)
    expect(
      skillSliceCacheKey({
        tenant_id: 'tenant-a',
        agent_id: null,
        selected: 'skill-1',
        candidates: [],
      }),
    ).toBe('skill_slice:tenant-a:tenant_wide:skill-1:');
  });

  it('equals the buildCacheKey composition (parity), with candidates sorted then encoded as one segment', () => {
    const key = skillSliceCacheKey({
      tenant_id: 'tenant-a',
      agent_id: 'agent-1',
      selected: null,
      candidates: ['skill-b', 'skill-a'],
    });
    expect(key).toBe(
      buildCacheKey('skill_slice:', 'tenant-a', 'agent-1', 'none', 'skill-a,skill-b'),
    );
    // The `,` join inside the candidates segment is encoded — it can never
    // be confused with a `:` delimiter or split into extra segments.
    expect(key).toBe('skill_slice:tenant-a:agent-1:none:skill-a%2Cskill-b');
  });

  it('invalidateSkillSliceCacheForTenant("acme") does NOT clear tenant "acme:dev" entries', async () => {
    const keyAcme = skillSliceCacheKey({
      tenant_id: 'acme',
      agent_id: null,
      selected: null,
      candidates: [],
    });
    const keyAcmeDev = skillSliceCacheKey({
      tenant_id: 'acme:dev',
      agent_id: null,
      selected: null,
      candidates: [],
    });
    await sliceCache.set(keyAcme, { v: 'acme' }, 300);
    await sliceCache.set(keyAcmeDev, { v: 'acme:dev' }, 300);

    await invalidateSkillSliceCacheForTenant('acme');

    expect(await sliceCache.get(keyAcme)).toBeNull();
    // Pre-#287 the raw prefix `skill_slice:acme:` ALSO matched
    // `skill_slice:acme:dev:…` — cross-tenant invalidation by aliasing.
    expect(await sliceCache.get(keyAcmeDev)).toEqual({ v: 'acme:dev' });
  });
});
