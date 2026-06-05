/**
 * Issue #407 — AudienceSliceBuilder unit tests.
 *
 * Asserts: cache key scoped by (tenant, agent, contact); fail-closed null
 * audience for no-contact / no-active-profile; happy-path projection of the
 * AudienceContext; per-agent isolation in the cache key.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  AudienceSliceBuilder,
  type AudienceRepoPort,
  type AudienceSlice,
} from '@/runtime/context-assembly/slice-builders/audience-slice-builder.js';
import { InMemorySliceCache } from '@/runtime/context-packet/cache/slice-cache.js';
import { mkBaseContextPacket } from '../../../fixtures/base-context-packet.js';
import { mockDecision } from './_fixture.js';
import type { Pessoa, AgentAudienceProfile } from '@/db/schema.js';

const pessoa = {
  id: 'p1',
  tenant_id: 'tenant-fixture',
  agent_id: 'agent-fixture',
  telefone_whatsapp: '+5511999990000',
  tipo: 'cliente',
  status: 'ativa',
} as unknown as Pessoa;

function profile(over: Partial<AgentAudienceProfile> = {}): AgentAudienceProfile {
  return {
    id: 'aud-1',
    tenant_id: 'tenant-fixture',
    agent_id: 'agent-fixture',
    pessoa_id: 'p1',
    audience_type: 'customer',
    trust_level: 'known_external',
    status: 'active',
    permission_profile_ids: [],
    labels: [],
    metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  } as AgentAudienceProfile;
}

function mkPort(over: Partial<AudienceRepoPort> = {}): AudienceRepoPort {
  // Stable profile instance: the cache key now encodes `updated_at`, so the
  // port must return the SAME row across calls for an unchanged profile to be a
  // cache hit (a fresh `new Date()` per call would look like a mutation).
  const stableProfile = profile();
  return {
    getPessoa: async () => pessoa,
    getProfile: async () => stableProfile,
    getAllowedEntityIds: async () => ['ent-1'],
    ...over,
  };
}

const signal = new AbortController().signal;

let cache: InMemorySliceCache;
beforeEach(() => {
  cache = new InMemorySliceCache();
});

describe('AudienceSliceBuilder (#407)', () => {
  it('cacheKey is scoped by tenant_id, agent_id and contact_id', () => {
    const b = new AudienceSliceBuilder(mkPort(), cache);
    const base = mkBaseContextPacket({
      tenant_id: 'tA',
      agent_id: 'aX',
      actor: { user_id: null, pessoa_id: 'contact-1', role: 'x', is_authenticated: true },
    });
    const key = b.cacheKey(base, { depth: 'minimal' });
    expect(key.startsWith('maia:context:v2:tA:aX:audience:')).toBe(true);

    // Different contact → different key (no collision within an agent).
    const base2 = mkBaseContextPacket({
      tenant_id: 'tA',
      agent_id: 'aX',
      actor: { user_id: null, pessoa_id: 'contact-2', role: 'x', is_authenticated: true },
    });
    expect(b.cacheKey(base2, { depth: 'minimal' })).not.toBe(key);

    // Different agent, same contact → different key (per-agent isolation).
    const base3 = mkBaseContextPacket({
      tenant_id: 'tA',
      agent_id: 'aY',
      actor: { user_id: null, pessoa_id: 'contact-1', role: 'x', is_authenticated: true },
    });
    expect(b.cacheKey(base3, { depth: 'minimal' })).not.toBe(key);

    // Different tenant, same agent + contact → different key (per-tenant
    // isolation; tenant_id is in the key prefix).
    const base4 = mkBaseContextPacket({
      tenant_id: 'tB',
      agent_id: 'aX',
      actor: { user_id: null, pessoa_id: 'contact-1', role: 'x', is_authenticated: true },
    });
    expect(b.cacheKey(base4, { depth: 'minimal' })).not.toBe(key);
  });

  it('builds an AudienceContext slice on the happy path', async () => {
    const b = new AudienceSliceBuilder(mkPort(), cache);
    const base = mkBaseContextPacket({
      actor: { user_id: null, pessoa_id: 'p1', role: 'x', is_authenticated: true },
    });
    const res = await b.build({
      base,
      requirements: { depth: 'full' },
      decision: mockDecision(),
      signal,
    });
    expect(res.cache_hit).toBe(false);
    expect(res.slice.audience).toMatchObject({
      contact_id: 'p1',
      audience_type: 'customer',
      trust_level: 'known_external',
      allowed_entity_ids: ['ent-1'],
      status: 'active',
    });
  });

  it('caches the result (second build is a cache hit)', async () => {
    const b = new AudienceSliceBuilder(mkPort(), cache);
    const base = mkBaseContextPacket({
      actor: { user_id: null, pessoa_id: 'p1', role: 'x', is_authenticated: true },
    });
    const req = { depth: 'minimal' as const };
    const first = await b.build({ base, requirements: req, decision: mockDecision(), signal });
    expect(first.cache_hit).toBe(false);
    const second = await b.build({ base, requirements: req, decision: mockDecision(), signal });
    expect(second.cache_hit).toBe(true);
    expect(second.slice.audience?.audience_type).toBe('customer');
  });

  it('does not serve a stale active audience after an in-place deactivation (#5)', async () => {
    const active = profile({
      id: 'aud-1',
      status: 'active',
      updated_at: new Date('2026-01-01T00:00:00Z'),
    });
    const deactivated = profile({
      id: 'aud-1',
      status: 'inactive',
      updated_at: new Date('2026-02-01T00:00:00Z'),
    });
    let current: AgentAudienceProfile = active;
    const b = new AudienceSliceBuilder(mkPort({ getProfile: async () => current }), cache);
    const base = mkBaseContextPacket({
      actor: { user_id: null, pessoa_id: 'p1', role: 'x', is_authenticated: true },
    });
    const req = { depth: 'minimal' as const };

    const first = await b.build({ base, requirements: req, decision: mockDecision(), signal });
    expect(first.slice.audience?.status).toBe('active');

    // Same profile id, deactivated in place (status flip + updated_at bump):
    // must re-derive (cache miss) and fail closed — never serve the stale active.
    current = deactivated;
    const second = await b.build({ base, requirements: req, decision: mockDecision(), signal });
    expect(second.cache_hit).toBe(false);
    expect(second.slice.audience).toBeNull();
  });

  it('fails closed (null audience) when there is no contact on the turn', async () => {
    const b = new AudienceSliceBuilder(mkPort(), cache);
    const base = mkBaseContextPacket({
      actor: { user_id: null, pessoa_id: null, role: 'system', is_authenticated: false },
    });
    const res = await b.build({
      base,
      requirements: { depth: 'minimal' },
      decision: mockDecision(),
      signal,
    });
    expect(res.slice).toEqual<AudienceSlice>({ audience: null });
  });

  it('fails closed (null audience) when the profile is not active', async () => {
    const b = new AudienceSliceBuilder(
      mkPort({ getProfile: async () => profile({ status: 'quarantined' }) }),
      cache,
    );
    const base = mkBaseContextPacket({
      actor: { user_id: null, pessoa_id: 'p1', role: 'x', is_authenticated: true },
    });
    const res = await b.build({
      base,
      requirements: { depth: 'minimal' },
      decision: mockDecision(),
      signal,
    });
    expect(res.slice.audience).toBeNull();
  });

  it('fails closed (null audience) when no profile row exists', async () => {
    const b = new AudienceSliceBuilder(
      mkPort({ getProfile: async () => null }),
      cache,
    );
    const base = mkBaseContextPacket({
      actor: { user_id: null, pessoa_id: 'p1', role: 'x', is_authenticated: true },
    });
    const res = await b.build({
      base,
      requirements: { depth: 'minimal' },
      decision: mockDecision(),
      signal,
    });
    expect(res.slice.audience).toBeNull();
  });
});
