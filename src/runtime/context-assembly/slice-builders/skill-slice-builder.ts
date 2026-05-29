/**
 * P8a — SkillSliceBuilder.
 *
 * Mode selection (master §3.9):
 *   - decision.routing.selected_skill_id present → mode='selected_only'
 *     (load full skill detail including runtime_hints/constraints)
 *   - otherwise → mode='candidates' (load summarised candidate skills with
 *     reason hints from decision.routing.candidate_skill_ids).
 *
 * Spec §3.8 / Plan Task 10.
 */
import { createHash } from 'node:crypto';
import type { BaseContextPacket, SkillSlice } from '../../context-packet/types.js';
import { sliceCacheKey, type SliceCache } from '../../context-packet/cache/slice-cache.js';
import { getTTLForSlice } from '../../context-packet/cache/ttl-policy.js';
import type {
  SliceBuilder,
  SliceBuilderInput,
  SliceBuilderResult,
} from './_types.js';

/**
 * Requirement: chosen by Decision Engine. P8a derives from
 * `decision.context_requirements.skill` (`'selected_only' | 'candidates'`).
 */
export type SkillRequirements = 'selected_only' | 'candidates';

export interface SkillRecord {
  id: string;
  name: string;
  version: number;
  input_schema_ref: string;
  output_schema_ref: string;
  procedure_ref: string;
  constraints: Record<string, unknown>;
  success_criteria: Record<string, unknown>;
  runtime_hints: {
    max_prompt_tokens?: number;
    max_output_tokens?: number;
    max_tool_calls?: number;
    allow_deep_context?: boolean;
    preferred_model?: string;
  };
}

export interface SkillSummary {
  id: string;
  name: string;
  reason: string;
}

export interface SkillRepoPort {
  getSkillById(tenant_id: string, skill_id: string): Promise<SkillRecord | null>;
  listSkillSummaries(
    tenant_id: string,
    skill_ids: string[],
  ): Promise<SkillSummary[]>;
}

export class SkillSliceBuilder
  implements SliceBuilder<SkillRequirements, SkillSlice>
{
  readonly name = 'skill' as const;

  constructor(
    private readonly repo: SkillRepoPort,
    private readonly cache: SliceCache,
  ) {}

  cacheKey(base: BaseContextPacket, _req: SkillRequirements): string {
    // Skill slice depends primarily on the decision's routing — caller passes
    // selected_skill_id via the decision, which we hash here. The base
    // signature alone isn't enough to key, so we hash both pieces below in
    // build() before each cache lookup.
    // Issue #235: agent_id flows in via sliceCacheKey's prefix.
    return sliceCacheKey(base.tenant_id, base.agent_id, 'skill', 'placeholder');
  }

  async build(
    input: SliceBuilderInput<SkillRequirements>,
  ): Promise<SliceBuilderResult<SkillSlice>> {
    const start = performance.now();
    throwIfAborted(input.signal);

    const selected_skill_id = input.decision.routing.selected_skill_id;
    const candidate_ids = input.decision.routing.candidate_skill_ids;

    const cacheScope = hashShort({
      mode: input.requirements,
      selected_skill_id: selected_skill_id ?? null,
      candidate_ids,
    });
    const key = sliceCacheKey(input.base.tenant_id, input.base.agent_id, 'skill', cacheScope);

    const cached = await this.cache.get<SkillSlice>(key);
    if (cached) {
      return {
        slice: cached,
        cache_hit: true,
        duration_ms: performance.now() - start,
      };
    }

    let slice: SkillSlice;

    if (selected_skill_id && input.requirements === 'selected_only') {
      const skill = await this.repo.getSkillById(
        input.base.tenant_id,
        selected_skill_id,
      );
      if (skill) {
        slice = {
          mode: 'selected_only',
          selected_skill: {
            id: skill.id,
            name: skill.name,
            version: skill.version,
            input_schema_ref: skill.input_schema_ref,
            output_schema_ref: skill.output_schema_ref,
            procedure_ref: skill.procedure_ref,
            constraints: skill.constraints,
            success_criteria: skill.success_criteria,
            runtime_hints: skill.runtime_hints,
          },
          candidate_skills: [],
        };
      } else {
        slice = {
          mode: 'selected_only',
          selected_skill: null,
          candidate_skills: [],
        };
      }
    } else {
      // candidates mode (or selected_only with no selected_skill_id)
      const summaries = await this.repo.listSkillSummaries(
        input.base.tenant_id,
        candidate_ids,
      );
      slice = {
        mode: 'candidates',
        selected_skill: null,
        candidate_skills: summaries.map((s) => ({
          id: s.id,
          name: s.name,
          reason: s.reason,
        })),
      };
    }

    await this.cache.set(key, slice, getTTLForSlice('skill'));
    return {
      slice,
      cache_hit: false,
      duration_ms: performance.now() - start,
    };
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

function hashShort(obj: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify(obj))
    .digest('hex')
    .substring(0, 12);
}
