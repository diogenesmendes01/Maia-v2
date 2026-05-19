import { describe, it, expect } from 'vitest';
import {
  buildUserSliceCacheKey,
  buildKnowledgeSliceCacheKey,
} from '@/user-layer/internal/cache-keys.js';

describe('user-layer cache-keys', () => {
  describe('buildUserSliceCacheKey', () => {
    it('canonical shape user_slice:v1:tenant:pessoa:depth:intent:scope', () => {
      const key = buildUserSliceCacheKey({
        tenant_id: 'tenant-A',
        pessoa_id: 'pessoa-1',
        depth: 'relevant',
      });
      expect(key).toMatch(/^user_slice:v1:tenant-A:pessoa-1:relevant:/);
    });

    it('is deterministic for same inputs', () => {
      const args = {
        tenant_id: 'tenant-A',
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
        pessoa_id: 'pessoa-1',
        depth: 'minimal',
      });
      expect(key).toContain('none'); // intent default
      expect(key).toContain('default'); // scope default
    });
  });

  describe('buildKnowledgeSliceCacheKey', () => {
    it('canonical shape knowledge_slice:v1:tenant:depth:scope:domain:intent', () => {
      const key = buildKnowledgeSliceCacheKey({
        tenant_id: 'tenant-A',
        depth: 'relevant',
      });
      expect(key).toMatch(/^knowledge_slice:v1:tenant-A:relevant:/);
    });

    it('is deterministic for same inputs', () => {
      const args = {
        tenant_id: 'tenant-A',
        depth: 'deep',
        domain: 'billing',
      };
      expect(buildKnowledgeSliceCacheKey(args)).toBe(buildKnowledgeSliceCacheKey(args));
    });

    it('differs for different tenants', () => {
      const a = buildKnowledgeSliceCacheKey({ tenant_id: 'tenant-A', depth: 'relevant' });
      const b = buildKnowledgeSliceCacheKey({ tenant_id: 'tenant-B', depth: 'relevant' });
      expect(a).not.toBe(b);
    });

    it('domain defaults to "global" when omitted', () => {
      const key = buildKnowledgeSliceCacheKey({ tenant_id: 'tenant-A', depth: 'relevant' });
      expect(key).toContain(':global:');
    });
  });
});
