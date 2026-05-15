/**
 * P8a — buildContextPacket() orchestrator (Camada 3 → ExecutionContextPacket).
 *
 * Assembles the seven slice builders in parallel via Promise.allSettled, plus
 * a history loader. Budget is <600ms p95 (master §3.6). Hard rules:
 *
 *  - Policy builder failure → throw. Policy slice is non-negotiable.
 *  - Any other builder failure → fall back to empty slice with
 *    fallback_depth_applied='degraded' recorded in assembly_meta.
 *  - Budget breach: AbortSignal fires; builders that respond to the signal
 *    throw → handled by the same fallback path.
 *
 * Cache hits / durations / fallbacks are all recorded in assembly_meta for
 * Trace (P10) visibility.
 */
import { createHash } from 'node:crypto';
import type {
  AssemblyMeta,
  BaseContextPacket,
  DecisionPacket,
  ExecutionContextPacket,
  HistorySlice,
  IdentitySlice,
  KnowledgeSlice,
  PolicySlice,
  SkillSlice,
  SliceName,
  SoulSlice,
  ToolPermissionSlice,
  UserSlice,
} from './types.js';
import type {
  SliceBuilder,
  SliceBuilderResult,
} from '../context-assembly/slice-builders/_types.js';

export interface HistoryRequirements {
  depth: 'none' | 'last_turns' | 'relevant';
  max_turns?: number;
  max_tokens_hint?: number;
}

export interface HistoryLoader {
  (
    base: BaseContextPacket,
    req: HistoryRequirements,
    signal: AbortSignal,
  ): Promise<HistorySlice>;
}

export interface MetricsClient {
  recordHistogram?(metric: string, value: number, labels?: Record<string, string>): void;
  recordCounter?(metric: string, labels?: Record<string, string>): void;
}

/**
 * Identifiable slice builder set. Each key is a SliceName.
 */
export interface SliceBuilderSet {
  identity: SliceBuilder<unknown, IdentitySlice>;
  user: SliceBuilder<unknown, UserSlice>;
  knowledge: SliceBuilder<unknown, KnowledgeSlice>;
  soul: SliceBuilder<unknown, SoulSlice>;
  policy: SliceBuilder<unknown, PolicySlice>;
  skill: SliceBuilder<unknown, SkillSlice>;
  tool: SliceBuilder<unknown, ToolPermissionSlice>;
}

export interface BuildContextPacketInput {
  base: BaseContextPacket;
  decision: DecisionPacket;
  signal?: AbortSignal;
}

export interface BuildContextPacketDeps {
  builders: SliceBuilderSet;
  historyLoader: HistoryLoader;
  metrics?: MetricsClient;
  clock?: () => number;
  /** Budget for the parallel assembly. Default 600ms. */
  budgetMs?: number;
}

const EMPTY_FALLBACKS = {
  identity: (): IdentitySlice => ({
    role_descriptor: '',
    voice: { tone: '', formality: 'medium', verbosity: 'concise' },
    cognitive_limits: {
      max_inference_depth: 0,
      max_speculation_in_response: 0,
      confidence_floor_for_action: 0.5,
    },
    priorities: [],
    learned_voice_modifiers: [],
    schema_version: 'v3.1.1-2026-05-15',
    version_id: '',
  }),
  user: (): UserSlice => ({
    pessoa: null,
    preferences: {},
    memories: [],
    behavioral_hints: [],
    truncated: false,
  }),
  knowledge: (): KnowledgeSlice => ({
    facts: [],
    rules: [],
    truncated: { facts: false, rules: false },
  }),
  soul: (): SoulSlice => ({ biases: [], truncated: false }),
  skill: (): SkillSlice => ({
    mode: 'candidates',
    selected_skill: null,
    candidate_skills: [],
  }),
  tool: (): ToolPermissionSlice => ({
    available_tools: [],
    blocked_tools: [],
    requires_confirmation: [],
  }),
};

export async function buildContextPacket(
  input: BuildContextPacketInput,
  deps: BuildContextPacketDeps,
): Promise<ExecutionContextPacket> {
  const clock = deps.clock ?? (() => performance.now());
  const startedAtMs = clock();
  const budgetMs = deps.budgetMs ?? 600;

  // Compose final abort signal — combine caller-provided signal with our
  // internal budget timeout.
  const internalController = new AbortController();
  const timeout = setTimeout(() => internalController.abort(), budgetMs);
  if (input.signal) {
    if (input.signal.aborted) internalController.abort();
    else
      input.signal.addEventListener('abort', () => internalController.abort(), {
        once: true,
      });
  }
  const signal = internalController.signal;

  try {
    const ctxRequirements = input.decision.context_requirements;

    const [
      identityResult,
      userResult,
      knowledgeResult,
      soulResult,
      policyResult,
      skillResult,
      toolResult,
      historyResult,
    ] = await Promise.allSettled([
      deps.builders.identity.build({
        base: input.base,
        requirements: ctxRequirements.identity,
        decision: input.decision,
        signal,
      }),
      deps.builders.user.build({
        base: input.base,
        requirements: ctxRequirements.user,
        decision: input.decision,
        signal,
      }),
      deps.builders.knowledge.build({
        base: input.base,
        requirements: ctxRequirements.knowledge,
        decision: input.decision,
        signal,
      }),
      deps.builders.soul.build({
        base: input.base,
        requirements: ctxRequirements.soul,
        decision: input.decision,
        signal,
      }),
      deps.builders.policy.build({
        base: input.base,
        requirements: ctxRequirements.policy,
        decision: input.decision,
        signal,
      }),
      deps.builders.skill.build({
        base: input.base,
        requirements: ctxRequirements.skill,
        decision: input.decision,
        signal,
      }),
      deps.builders.tool.build({
        base: input.base,
        // ToolRequirements is currently `unknown` from the builder's
        // perspective; pass an empty shape.
        requirements: {},
        decision: input.decision,
        signal,
      }),
      deps.historyLoader(input.base, ctxRequirements.history, signal),
    ]);

    // Policy is non-negotiable.
    if (policyResult.status === 'rejected') {
      throw policyResult.reason instanceof Error
        ? policyResult.reason
        : new Error(`Policy slice builder failed: ${String(policyResult.reason)}`);
    }
    const policySliceResult = policyResult.value;

    const assemblyMeta: AssemblyMeta = {
      started_at_ms: startedAtMs,
      finished_at_ms: 0,
      duration_ms: 0,
      cache_hits: {},
      fallback_depths_applied: {},
      builder_durations_ms: {},
    };

    const extract = <T>(
      name: Exclude<SliceName, 'history' | 'policy'>,
      result: PromiseSettledResult<SliceBuilderResult<T>>,
      fallback: () => T,
    ): T => {
      if (result.status === 'fulfilled') {
        assemblyMeta.cache_hits[name] = result.value.cache_hit;
        assemblyMeta.builder_durations_ms[name] = result.value.duration_ms;
        if (result.value.fallback_depth_applied) {
          assemblyMeta.fallback_depths_applied[name] =
            result.value.fallback_depth_applied;
        }
        return result.value.slice;
      }
      // Rejected — degrade
      assemblyMeta.cache_hits[name] = false;
      assemblyMeta.fallback_depths_applied[name] = 'degraded';
      deps.metrics?.recordCounter?.('context_packet.fallback_applied', {
        slice: name,
      });
      return fallback();
    };

    const identitySlice = extract<IdentitySlice>(
      'identity',
      identityResult,
      EMPTY_FALLBACKS.identity,
    );
    const userSlice = extract<UserSlice>('user', userResult, EMPTY_FALLBACKS.user);
    const knowledgeSlice = extract<KnowledgeSlice>(
      'knowledge',
      knowledgeResult,
      EMPTY_FALLBACKS.knowledge,
    );
    const soulSlice = extract<SoulSlice>('soul', soulResult, EMPTY_FALLBACKS.soul);
    const skillSlice = extract<SkillSlice>('skill', skillResult, EMPTY_FALLBACKS.skill);
    const toolSlice = extract<ToolPermissionSlice>(
      'tool',
      toolResult,
      EMPTY_FALLBACKS.tool,
    );

    // Policy fulfilled (rejection threw earlier)
    assemblyMeta.cache_hits.policy = policySliceResult.cache_hit;
    assemblyMeta.builder_durations_ms.policy = policySliceResult.duration_ms;
    if (policySliceResult.fallback_depth_applied) {
      assemblyMeta.fallback_depths_applied.policy =
        policySliceResult.fallback_depth_applied;
    }

    let historySlice: HistorySlice;
    if (historyResult.status === 'fulfilled') {
      historySlice = historyResult.value;
      assemblyMeta.cache_hits.history = false; // history not slice-cached
    } else {
      historySlice = { turns: [], truncated: false };
      assemblyMeta.fallback_depths_applied.history = 'degraded';
      deps.metrics?.recordCounter?.('context_packet.fallback_applied', {
        slice: 'history',
      });
    }

    const finishedAtMs = clock();
    assemblyMeta.finished_at_ms = finishedAtMs;
    assemblyMeta.duration_ms = finishedAtMs - startedAtMs;

    const packet: ExecutionContextPacket = {
      trace_id: input.base.trace_id,
      tenant_id: input.base.tenant_id,
      agent_id: input.base.agent_id,
      conversation_id: input.base.conversation_id,
      base_ref: hashShort16(input.base),
      decision_ref: hashShort16(input.decision),
      identity: identitySlice,
      user: userSlice,
      knowledge: knowledgeSlice,
      soul: soulSlice,
      policy: policySliceResult.slice,
      skill: skillSlice,
      tool: toolSlice,
      history: historySlice,
      assembly_meta: assemblyMeta,
    };

    deps.metrics?.recordHistogram?.(
      'context_assembly.duration_ms',
      assemblyMeta.duration_ms,
    );

    return packet;
  } finally {
    clearTimeout(timeout);
  }
}

function hashShort16(obj: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(obj))
    .digest('hex')
    .substring(0, 16);
}
