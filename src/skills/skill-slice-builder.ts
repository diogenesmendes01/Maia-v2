/**
 * P9a — SkillSlice builder.
 *
 * Constrói um `SkillSlice` (subset de Context Packet — master spec §6)
 * a partir de uma decisão de roteamento. O slice contém:
 *  - `selected`: skill escolhida pela decisão (se houver routing.selected_skill_id)
 *  - `candidates`: até 5 skills consideradas (routing.candidate_skill_ids)
 *  - `total_active_in_tenant`: número total de skills ativas no tenant (para Admin UI)
 *  - `builder_metadata`: cache hit + ttl
 *
 * Cache: 5-10min TTL via `sliceCache` (in-process). Invalidação é
 * event-based (`invalidateSkillSliceCacheForTenant`), disparada por
 * `skillsRepo.activate/rollback` indiretamente em P9b.
 */
import { skillsRepo } from '@/db/repositories.js';
import { sliceCache } from './cache.js';
import type { SkillSlice, SkillSummary } from './types.js';
import type { SkillRow } from '@/db/schema.js';
import type { SkillExecutionMode } from '@/types/enums.js';
import { logger } from '@/lib/logger.js';

const SLICE_TTL_SECONDS = 600; // 10min — middle of the 5-10min range
const MAX_CANDIDATES = 5;

export interface BuildSliceCtx {
  tenant_id: string;
  agent_id?: string | null;
  decision: {
    routing?: {
      selected_skill_id?: string | null;
      candidate_skill_ids?: string[];
    };
    intent?: {
      label?: string;
    };
  };
}

export async function buildSkillSlice(ctx: BuildSliceCtx): Promise<SkillSlice> {
  const routing = ctx.decision.routing ?? {};
  const cacheKey = buildCacheKey({
    tenant_id: ctx.tenant_id,
    agent_id: ctx.agent_id ?? null,
    selected: routing.selected_skill_id ?? null,
    candidates: routing.candidate_skill_ids ?? [],
  });

  const cached = await sliceCache.get<SkillSlice>(cacheKey);
  if (cached) {
    return {
      ...cached,
      builder_metadata: {
        ...cached.builder_metadata,
        cache_hit: true,
      },
    };
  }

  // Fetch selected
  let selected: SkillSummary | undefined;
  if (routing.selected_skill_id) {
    try {
      const row = await skillsRepo.getById(routing.selected_skill_id);
      if (row) selected = toSummary(row);
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, id: routing.selected_skill_id },
        'p9a.slice.selected_lookup_failed',
      );
    }
  }

  // Fetch candidates (max 5)
  const candidateIds = (routing.candidate_skill_ids ?? []).slice(0, MAX_CANDIDATES);
  const candidates: SkillSummary[] = [];
  for (const id of candidateIds) {
    try {
      const row = await skillsRepo.getById(id);
      if (row) candidates.push(toSummary(row));
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, id },
        'p9a.slice.candidate_lookup_failed',
      );
    }
  }

  // Total active across all categories (best-effort; reads up to 8 categories)
  const total = await countActiveInTenant();

  const slice: SkillSlice = {
    selected,
    candidates,
    total_active_in_tenant: total,
    builder_metadata: {
      cache_hit: false,
      cached_at: new Date().toISOString(),
      ttl_seconds: SLICE_TTL_SECONDS,
    },
  };

  await sliceCache.set(cacheKey, slice, SLICE_TTL_SECONDS);
  return slice;
}

function buildCacheKey(args: {
  tenant_id: string;
  agent_id: string | null;
  selected: string | null;
  candidates: string[];
}): string {
  const agentPart = args.agent_id ?? 'tenant_wide';
  const selPart = args.selected ?? 'none';
  const candPart = [...args.candidates].sort().join(',');
  return `skill_slice:${args.tenant_id}:${agentPart}:${selPart}:${candPart}`;
}

function toSummary(row: SkillRow): SkillSummary {
  return {
    id: row.id,
    skill_descriptor: row.skill_descriptor,
    category: row.category,
    execution_mode: row.execution_mode as SkillExecutionMode,
    goal: row.goal,
    when_to_use: row.when_to_use,
    version: row.version,
    runtime_hints: (row.runtime_hints ?? {}) as SkillSummary['runtime_hints'],
  };
}

async function countActiveInTenant(): Promise<number> {
  // Sum over the 8 known categories. Cheap because each query hits the
  // partial index `idx_skills_tenant_category_active`.
  const categories = [
    'classify',
    'extract',
    'compose',
    'decide',
    'tool_mediated',
    'diagnose',
    'plan',
    'evaluator',
  ];
  let total = 0;
  for (const c of categories) {
    try {
      const rows = await skillsRepo.listByCategory(c);
      total += rows.length;
    } catch (err) {
      logger.warn({ err: (err as Error).message, category: c }, 'p9a.slice.count_failed');
    }
  }
  return total;
}
