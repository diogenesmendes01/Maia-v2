/**
 * P9a Task 6 — SkillSlice builder + cache tests.
 *
 * Verifica:
 *  - Cache miss → cache_hit=false, ttl=600
 *  - Segunda chamada com mesmo cacheKey → cache_hit=true
 *  - Cache invalidation por tenant
 *  - Slice contém selected + candidates limitados a 5
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
    '@/db/repositories.js',
  );
  return {
    ...actual,
    skillsRepo: {
      ...actual.skillsRepo,
      getById: vi.fn(),
      listByCategory: vi.fn(async () => []),
      findActive: vi.fn(),
      propose: vi.fn(),
      activate: vi.fn(),
      deprecate: vi.fn(),
      rollback: vi.fn(),
      getByDescriptor: vi.fn(),
      listVersions: vi.fn(async () => []),
    },
  };
});

import { buildSkillSlice } from '@/skills/skill-slice-builder.js';
import { sliceCache, invalidateSkillSliceCacheForTenant } from '@/skills/cache.js';
import { skillsRepo } from '@/db/repositories.js';

const sampleRow = {
  id: 'skill-a',
  skill_descriptor: 'a',
  category: 'classify',
  execution_mode: 'prompt_only',
  goal: 'Goal',
  when_to_use: 'Always',
  version: 1,
  runtime_hints: { max_output_tokens: 100 },
} as any;

describe('buildSkillSlice', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await sliceCache.clear();
  });

  it('returns cache_hit=false on first call', async () => {
    vi.mocked(skillsRepo.getById).mockResolvedValue(sampleRow);
    const slice = await buildSkillSlice({
      tenant_id: 'tenant1',
      decision: { routing: { selected_skill_id: 'skill-a', candidate_skill_ids: [] } },
    });
    expect(slice.builder_metadata.cache_hit).toBe(false);
    expect(slice.builder_metadata.ttl_seconds).toBe(600);
    expect(slice.selected?.id).toBe('skill-a');
    expect(slice.candidates).toEqual([]);
  });

  it('returns cache_hit=true on second call with same cacheKey', async () => {
    vi.mocked(skillsRepo.getById).mockResolvedValue(sampleRow);
    await buildSkillSlice({
      tenant_id: 'tenant1',
      decision: { routing: { selected_skill_id: 'skill-a', candidate_skill_ids: [] } },
    });
    const second = await buildSkillSlice({
      tenant_id: 'tenant1',
      decision: { routing: { selected_skill_id: 'skill-a', candidate_skill_ids: [] } },
    });
    expect(second.builder_metadata.cache_hit).toBe(true);
  });

  it('limits candidates to 5', async () => {
    vi.mocked(skillsRepo.getById).mockImplementation(async (id: string) => ({
      ...sampleRow,
      id,
      skill_descriptor: id,
    }));
    const slice = await buildSkillSlice({
      tenant_id: 'tenant1',
      decision: {
        routing: {
          candidate_skill_ids: ['s1', 's2', 's3', 's4', 's5', 's6', 's7'],
        },
      },
    });
    expect(slice.candidates.length).toBe(5);
    expect(slice.candidates.map((c) => c.id)).toEqual(['s1', 's2', 's3', 's4', 's5']);
  });

  it('invalidateSkillSliceCacheForTenant clears cache for that tenant', async () => {
    vi.mocked(skillsRepo.getById).mockResolvedValue(sampleRow);
    await buildSkillSlice({
      tenant_id: 'tenant-A',
      decision: { routing: { selected_skill_id: 'skill-a' } },
    });
    expect(sliceCache.size()).toBeGreaterThan(0);
    await invalidateSkillSliceCacheForTenant('tenant-A');
    const refetched = await buildSkillSlice({
      tenant_id: 'tenant-A',
      decision: { routing: { selected_skill_id: 'skill-a' } },
    });
    expect(refetched.builder_metadata.cache_hit).toBe(false);
  });

  it('total_active_in_tenant aggregates across categories', async () => {
    vi.mocked(skillsRepo.listByCategory).mockResolvedValue([{} as any, {} as any]);
    const slice = await buildSkillSlice({
      tenant_id: 'tenant1',
      decision: {},
    });
    // 2 per category × 8 categories = 16
    expect(slice.total_active_in_tenant).toBe(16);
  });
});
