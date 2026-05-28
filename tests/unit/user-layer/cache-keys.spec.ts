import { describe, it, expect } from 'vitest';
import {
  buildUserSliceCacheKey,
  buildKnowledgeSliceCacheKey,
  assertValidScope,
  InvalidCacheScopeError,
} from '@/user-layer/internal/cache-keys.js';

describe('user-layer cache-keys', () => {
  describe('buildUserSliceCacheKey', () => {
    it('canonical shape user_slice:v2:tenant:agent:pessoa:depth:intent:scope', () => {
      const key = buildUserSliceCacheKey({
        tenant_id: 'tenant-A',
        agent_id: 'agent-1',
        pessoa_id: 'pessoa-1',
        depth: 'relevant',
      });
      // Issue #235: v2 layout includes agent_id in the prefix.
      expect(key).toMatch(/^user_slice:v2:tenant-A:agent-1:pessoa-1:relevant:/);
    });

    it('is deterministic for same inputs', () => {
      const args = {
        tenant_id: 'tenant-A',
        agent_id: 'agent-1',
        pessoa_id: 'pessoa-1',
        depth: 'deep',
        intent_label: 'support',
        scope_hint: ['personal', 'work'],
      };
      const a = buildUserSliceCacheKey(args);
      const b = buildUserSliceCacheKey(args);
      expect(a).toBe(b);
    });

    it('differs for different tenants (cross-tenant isolation)', () => {
      const baseArgs = {
        agent_id: 'agent-1',
        pessoa_id: 'pessoa-1',
        depth: 'relevant',
      };
      const a = buildUserSliceCacheKey({ ...baseArgs, tenant_id: 'tenant-A' });
      const b = buildUserSliceCacheKey({ ...baseArgs, tenant_id: 'tenant-B' });
      expect(a).not.toBe(b);
    });

    it('differs for different intent_label', () => {
      const baseArgs = {
        tenant_id: 'tenant-A',
        agent_id: 'agent-1',
        pessoa_id: 'pessoa-1',
        depth: 'relevant',
      };
      const a = buildUserSliceCacheKey({ ...baseArgs, intent_label: 'support' });
      const b = buildUserSliceCacheKey({ ...baseArgs, intent_label: 'sales' });
      expect(a).not.toBe(b);
    });

    it('handles missing optional fields with deterministic defaults', () => {
      const key = buildUserSliceCacheKey({
        tenant_id: 'tenant-A',
        agent_id: 'agent-1',
        pessoa_id: 'pessoa-1',
        depth: 'minimal',
      });
      expect(key).toContain('none'); // intent default
      expect(key).toContain('default'); // scope default
    });

    // ─── Issue #235 — cross-agent isolation (HIGH, in-scope) ───────────────
    // `buildUserSlice` threads `boundary.agent_id` into memory/hints resolver
    // calls (`user-slice-builder.ts:57, 67`), so the cache key MUST also
    // include `agent_id` — otherwise two agents on the same tenant looking
    // at the same pessoa would silently collide and leak each other's
    // memories.

    it('Issue #235: differs for different agents on the same tenant (same pessoa)', () => {
      const a = buildUserSliceCacheKey({
        tenant_id: 'tenant-A',
        agent_id: 'agent-A',
        pessoa_id: 'pessoa-1',
        depth: 'relevant',
      });
      const b = buildUserSliceCacheKey({
        tenant_id: 'tenant-A',
        agent_id: 'agent-B',
        pessoa_id: 'pessoa-1',
        depth: 'relevant',
      });
      expect(a).not.toBe(b);
    });

    it('Issue #235: symmetric — swapping agent ids swaps the keys', () => {
      const baseArgs = {
        tenant_id: 'tenant-A',
        pessoa_id: 'pessoa-1',
        depth: 'relevant' as const,
      };
      const a1 = buildUserSliceCacheKey({ ...baseArgs, agent_id: 'agent-A' });
      const b1 = buildUserSliceCacheKey({ ...baseArgs, agent_id: 'agent-B' });
      const a2 = buildUserSliceCacheKey({ ...baseArgs, agent_id: 'agent-A' });
      const b2 = buildUserSliceCacheKey({ ...baseArgs, agent_id: 'agent-B' });
      expect(a1).toBe(a2);
      expect(b1).toBe(b2);
      expect(a1).not.toBe(b1);
    });

    it('Issue #235: version bumped to v2 (regression for v1 → v2 cache invalidation)', () => {
      const key = buildUserSliceCacheKey({
        tenant_id: 'tenant-A',
        agent_id: 'agent-1',
        pessoa_id: 'pessoa-1',
        depth: 'relevant',
      });
      expect(key.startsWith('user_slice:v2:')).toBe(true);
      expect(key).not.toContain('user_slice:v1:');
    });

    it('Issue #235: agent_id appears in the prefix, before pessoa', () => {
      const key = buildUserSliceCacheKey({
        tenant_id: 'tenant-A',
        agent_id: 'agent-XYZ',
        pessoa_id: 'pessoa-XYZ',
        depth: 'relevant',
      });
      // Layout: user_slice:v2:{tenant}:{agent}:{pessoa}:{depth}:...
      const parts = key.split(':');
      expect(parts[0]).toBe('user_slice');
      expect(parts[1]).toBe('v2');
      expect(parts[2]).toBe('tenant-A');
      expect(parts[3]).toBe('agent-XYZ');
      expect(parts[4]).toBe('pessoa-XYZ');
      expect(parts[5]).toBe('relevant');
    });

    // ─── Issue #235 — fail-closed on empty/invalid scope (Codex reval) ─────
    it('Issue #235: throws InvalidCacheScopeError when agent_id is empty string', () => {
      expect(() =>
        buildUserSliceCacheKey({
          tenant_id: 'tenant-A',
          agent_id: '',
          pessoa_id: 'pessoa-1',
          depth: 'relevant',
        }),
      ).toThrow(InvalidCacheScopeError);
    });

    it('Issue #235: throws InvalidCacheScopeError when tenant_id is empty string', () => {
      expect(() =>
        buildUserSliceCacheKey({
          tenant_id: '',
          agent_id: 'agent-1',
          pessoa_id: 'pessoa-1',
          depth: 'relevant',
        }),
      ).toThrow(InvalidCacheScopeError);
    });

    it('Issue #235: throws InvalidCacheScopeError when agent_id is missing (undefined cast)', () => {
      expect(() =>
        buildUserSliceCacheKey({
          tenant_id: 'tenant-A',
          // @ts-expect-error — testing runtime fail-closed
          agent_id: undefined,
          pessoa_id: 'pessoa-1',
          depth: 'relevant',
        }),
      ).toThrow(InvalidCacheScopeError);
    });
  });

  describe('buildKnowledgeSliceCacheKey', () => {
    it('canonical shape knowledge_slice:v2:tenant:agent:depth:scope:domain:intent', () => {
      const key = buildKnowledgeSliceCacheKey({
        tenant_id: 'tenant-A',
        agent_id: 'agent-1',
        depth: 'relevant',
      });
      // Issue #235: v2 layout includes agent_id in the prefix.
      expect(key).toMatch(/^knowledge_slice:v2:tenant-A:agent-1:relevant:/);
    });

    it('is deterministic for same inputs', () => {
      const args = {
        tenant_id: 'tenant-A',
        agent_id: 'agent-1',
        depth: 'deep',
        domain: 'billing',
      };
      expect(buildKnowledgeSliceCacheKey(args)).toBe(buildKnowledgeSliceCacheKey(args));
    });

    it('differs for different tenants', () => {
      const a = buildKnowledgeSliceCacheKey({
        tenant_id: 'tenant-A',
        agent_id: 'agent-1',
        depth: 'relevant',
      });
      const b = buildKnowledgeSliceCacheKey({
        tenant_id: 'tenant-B',
        agent_id: 'agent-1',
        depth: 'relevant',
      });
      expect(a).not.toBe(b);
    });

    it('domain defaults to "global" when omitted', () => {
      const key = buildKnowledgeSliceCacheKey({
        tenant_id: 'tenant-A',
        agent_id: 'agent-1',
        depth: 'relevant',
      });
      expect(key).toContain(':global:');
    });

    // ─── Issue #235 — cross-agent isolation (LOW, latent) ───────────────────
    // The slice builder threads `boundary.agent_id` into fact/rule resolver
    // calls (`knowledge-slice-builder.ts:50-68`), so the cache key MUST also
    // include `agent_id` — otherwise two agents on the same tenant would
    // silently collide on cached slices if a real cache backend were wired.

    it('Issue #235: differs for different agents on the same tenant', () => {
      const a = buildKnowledgeSliceCacheKey({
        tenant_id: 'tenant-A',
        agent_id: 'agent-A',
        depth: 'relevant',
        domain: 'billing',
      });
      const b = buildKnowledgeSliceCacheKey({
        tenant_id: 'tenant-A',
        agent_id: 'agent-B',
        depth: 'relevant',
        domain: 'billing',
      });
      expect(a).not.toBe(b);
    });

    it('Issue #235: symmetric — swapping agent ids swaps the keys', () => {
      const baseArgs = {
        tenant_id: 'tenant-A',
        depth: 'relevant' as const,
        domain: 'billing',
      };
      const a1 = buildKnowledgeSliceCacheKey({ ...baseArgs, agent_id: 'agent-A' });
      const b1 = buildKnowledgeSliceCacheKey({ ...baseArgs, agent_id: 'agent-B' });
      const a2 = buildKnowledgeSliceCacheKey({ ...baseArgs, agent_id: 'agent-A' });
      const b2 = buildKnowledgeSliceCacheKey({ ...baseArgs, agent_id: 'agent-B' });
      expect(a1).toBe(a2);
      expect(b1).toBe(b2);
      expect(a1).not.toBe(b1);
    });

    it('Issue #235: version bumped to v2 (regression for v1 → v2 cache invalidation)', () => {
      const key = buildKnowledgeSliceCacheKey({
        tenant_id: 'tenant-A',
        agent_id: 'agent-1',
        depth: 'relevant',
      });
      expect(key.startsWith('knowledge_slice:v2:')).toBe(true);
      expect(key).not.toContain('knowledge_slice:v1:');
    });

    it('Issue #235: agent_id appears in the prefix, before depth', () => {
      const key = buildKnowledgeSliceCacheKey({
        tenant_id: 'tenant-A',
        agent_id: 'agent-XYZ',
        depth: 'relevant',
      });
      // Layout: knowledge_slice:v2:{tenant}:{agent}:{depth}:...
      const parts = key.split(':');
      expect(parts[0]).toBe('knowledge_slice');
      expect(parts[1]).toBe('v2');
      expect(parts[2]).toBe('tenant-A');
      expect(parts[3]).toBe('agent-XYZ');
      expect(parts[4]).toBe('relevant');
    });

    // ─── Issue #235 — fail-closed on empty/invalid scope (Codex reval) ─────
    it('Issue #235: throws InvalidCacheScopeError when agent_id is empty string', () => {
      expect(() =>
        buildKnowledgeSliceCacheKey({
          tenant_id: 'tenant-A',
          agent_id: '',
          depth: 'relevant',
        }),
      ).toThrow(InvalidCacheScopeError);
    });

    it('Issue #235: throws InvalidCacheScopeError when tenant_id is empty string', () => {
      expect(() =>
        buildKnowledgeSliceCacheKey({
          tenant_id: '',
          agent_id: 'agent-1',
          depth: 'relevant',
        }),
      ).toThrow(InvalidCacheScopeError);
    });
  });

  describe('assertValidScope (fail-closed helper)', () => {
    it('accepts valid non-empty strings', () => {
      expect(() => assertValidScope('tenant-A', 'agent-A')).not.toThrow();
    });

    it('throws InvalidCacheScopeError for empty tenant_id', () => {
      expect(() => assertValidScope('', 'agent-A')).toThrow(InvalidCacheScopeError);
    });

    it('throws InvalidCacheScopeError for empty agent_id', () => {
      expect(() => assertValidScope('tenant-A', '')).toThrow(InvalidCacheScopeError);
    });

    it('throws InvalidCacheScopeError for null', () => {
      expect(() => assertValidScope('tenant-A', null)).toThrow(InvalidCacheScopeError);
    });

    it('throws InvalidCacheScopeError for undefined', () => {
      expect(() => assertValidScope(undefined, 'agent-A')).toThrow(InvalidCacheScopeError);
    });

    it('throws InvalidCacheScopeError for non-string types', () => {
      expect(() => assertValidScope(123, 'agent-A')).toThrow(InvalidCacheScopeError);
      expect(() => assertValidScope('tenant-A', { id: 1 })).toThrow(InvalidCacheScopeError);
    });

    it('error carries stable `code` for programmatic handling', () => {
      try {
        assertValidScope('', 'agent-A');
        expect.fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidCacheScopeError);
        expect((err as InvalidCacheScopeError).code).toBe('INVALID_CACHE_SCOPE');
      }
    });
  });
});
