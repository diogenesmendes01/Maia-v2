/**
 * P8a — buildContextPacket() orchestrator (Camada 3 → ExecutionContextPacket).
 *
 * Assembles the seven slice builders in parallel, plus a history loader.
 *
 * Budget enforcement (spec §3.3):
 *   - **Per-slice timeout** (default 100ms): each builder is wrapped in
 *     `Promise.race([build, timeout])`. If the builder ignores the AbortSignal
 *     and hangs on a downstream dep (DB, Redis, registry), the race forces a
 *     timeout-result and the orchestrator moves on. This is the key defence
 *     against degraded ports — the AbortSignal alone is not enough because
 *     repo/cache/registry APIs do not all observe it.
 *   - **Total budget** (default 600ms): a budget tracker short-circuits
 *     remaining slices when exceeded — any slice not yet resolved when the
 *     deadline passes resolves to its fallback. Documented in §3.3.
 *
 * Hard rules:
 *   - Policy builder failure OR timeout → throw. Policy is non-negotiable
 *     ("fail closed"). The budget cannot rescue a missing policy slice.
 *   - Any other builder failure OR timeout → fall back to cached value if
 *     available, else conservative empty slice; record fallback_depth_applied
 *     ('timeout' | 'degraded') in assembly_meta.
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
import type { SliceCache } from './cache/slice-cache.js';
import { instrumentContextLoad } from '@/observability/instrumentation.js';
import { CONTEXT_LOAD_STAGE } from '@/observability/taxonomy.js';

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
  /** Total budget for the parallel assembly. Default 600ms. */
  budgetMs?: number;
  /** Per-slice timeout enforced via Promise.race. Default 100ms. */
  timeoutPerSliceMs?: number;
  /**
   * Optional cache reader for fallback-to-cached-value when a slice times out.
   * When provided, on timeout we attempt `cache.get(builder.cacheKey(...))`
   * BEFORE falling back to a conservative empty slice. Per spec §3.2.
   */
  cache?: SliceCache;
}

/** Spec §3.3 — defaults. Exported so callers and tests can reference. */
export const DEFAULT_TOTAL_BUDGET_MS = 600;
export const DEFAULT_TIMEOUT_PER_SLICE_MS = 100;

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
  soul: (): SoulSlice => ({
    active_biases: [],
    rendered_block: null,
    total_active: 0,
    truncated_to: 0,
    cache_key: '',
    resolved_at: new Date(0),
  }),
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

/**
 * Internal marker — produced by raceWithTimeout when the per-slice or global
 * deadline trips before the builder resolves. We distinguish from a real
 * builder rejection so the fallback path can apply 'timeout' instead of
 * 'degraded'.
 */
const TIMEOUT_MARKER = Symbol('builder.timeout');
interface TimeoutOutcome {
  __timeout__: typeof TIMEOUT_MARKER;
  remaining_ms_at_start: number;
}
function isTimeoutOutcome(v: unknown): v is TimeoutOutcome {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { __timeout__?: symbol }).__timeout__ === TIMEOUT_MARKER
  );
}

/**
 * Race a builder against the effective per-slice deadline. The deadline is
 * `min(timeoutPerSliceMs, remainingTotalBudgetMs)` — so a slice cannot eat
 * the whole budget on its own, and the orchestrator returns even when the
 * builder ignores its AbortSignal.
 *
 * If the builder rejects → the outer promise rejects (Promise.allSettled
 * records it as 'rejected'). If the deadline trips first → resolves with
 * a TimeoutOutcome marker for the orchestrator to branch on.
 */
function raceBuilderAgainstDeadline<T>(
  builderPromise: Promise<T>,
  effectiveTimeoutMs: number,
): Promise<T | TimeoutOutcome> {
  if (effectiveTimeoutMs <= 0) {
    return Promise.resolve<TimeoutOutcome>({
      __timeout__: TIMEOUT_MARKER,
      remaining_ms_at_start: 0,
    });
  }
  const timeoutPromise = new Promise<TimeoutOutcome>((resolve) => {
    const t = setTimeout(() => {
      resolve({
        __timeout__: TIMEOUT_MARKER,
        remaining_ms_at_start: effectiveTimeoutMs,
      });
    }, effectiveTimeoutMs);
    // Don't keep the event loop alive for the timer (Node only — no-op in browser).
    if (typeof t === 'object' && t !== null && 'unref' in t) {
      (t as { unref: () => void }).unref();
    }
  });
  // Also attach a non-throwing handler to the builder promise so an
  // unhandled rejection from a slow builder that eventually fails (after
  // the timeout fires) doesn't crash the process.
  builderPromise.catch(() => undefined);
  return Promise.race([builderPromise, timeoutPromise]);
}

/**
 * Issue #535 gate 6 — the `stage="packet"` call site.
 *
 * `instrumentContextLoad` shipped with a spec and no caller: the histogram
 * `maia_context_load_ms`, the counter `maia_context_slices_total` and the span
 * `context.load` were declared, dashboarded (`maia:context_load_ms:p95`) and
 * never produced a single series. This wrapper is the production emitter for
 * the `packet` stage.
 *
 * Why HERE and not inside the body:
 *   - the span must cover the COMPLETE assembly — including the budget timer
 *     setup and the `finally` that clears it — and exactly once per assembly.
 *     Wrapping the exported entry point is the only position where "once per
 *     montagem" is structural instead of a review note (same shape as
 *     `dispatchTool` → `dispatchToolInner` in `src/tools/_dispatcher.ts`);
 *   - it cannot nest: `buildContextPacketInner` never calls back into the
 *     exported name, so there is no path that opens two `context.load` spans
 *     for one packet.
 *
 * Cardinality: the stage is the module-level constant
 * `CONTEXT_LOAD_STAGE.PACKET`. Nothing here reads a name out of `input`,
 * `deps`, config or the tenant, so no caller can mint a new `stage` series —
 * the property `tests/unit/observability/context-load-call-site.spec.ts`
 * proves with hostile input.
 *
 * Transparency: `instrumentContextLoad` returns the value and rethrows the
 * error unchanged, so the fail-closed policy path (throw on policy
 * rejection/timeout) reaches the caller exactly as before — it just also
 * records `status="error"`.
 */
export async function buildContextPacket(
  input: BuildContextPacketInput,
  deps: BuildContextPacketDeps,
): Promise<ExecutionContextPacket> {
  return instrumentContextLoad(CONTEXT_LOAD_STAGE.PACKET, () =>
    buildContextPacketInner(input, deps),
  );
}

async function buildContextPacketInner(
  input: BuildContextPacketInput,
  deps: BuildContextPacketDeps,
): Promise<ExecutionContextPacket> {
  const clock = deps.clock ?? (() => performance.now());
  const startedAtMs = clock();
  const budgetMs = deps.budgetMs ?? DEFAULT_TOTAL_BUDGET_MS;
  const timeoutPerSliceMs =
    deps.timeoutPerSliceMs ?? DEFAULT_TIMEOUT_PER_SLICE_MS;

  // Compose final abort signal — combine caller-provided signal with our
  // internal budget timeout. Builders that DO respect the signal will abort
  // early; for builders that don't, raceBuilderAgainstDeadline provides the
  // hard ceiling.
  const internalController = new AbortController();
  const budgetTimer = setTimeout(() => internalController.abort(), budgetMs);
  if (typeof budgetTimer === 'object' && budgetTimer !== null && 'unref' in budgetTimer) {
    (budgetTimer as { unref: () => void }).unref();
  }
  if (input.signal) {
    if (input.signal.aborted) internalController.abort();
    else
      input.signal.addEventListener('abort', () => internalController.abort(), {
        once: true,
      });
  }
  const signal = internalController.signal;

  /**
   * Effective per-call deadline = min(perSlice budget, remaining global).
   * If the global budget has already elapsed, we return 0 (which the racer
   * treats as immediate timeout). Per spec §3.3 — short-circuit remaining
   * slices when the total budget is exhausted.
   */
  const remainingBudgetMs = (): number => {
    const elapsed = clock() - startedAtMs;
    return Math.max(0, budgetMs - elapsed);
  };
  const effectiveSliceDeadline = (): number =>
    Math.min(timeoutPerSliceMs, remainingBudgetMs());

  try {
    const ctxRequirements = input.decision.context_requirements;

    /**
     * Each builder is fired in parallel, then immediately raced against
     * the effective per-slice deadline. Critically we capture the deadline
     * at LAUNCH time — by the time the last slice's race starts, the global
     * remaining budget may already be much smaller than timeoutPerSliceMs.
     */
    const launch = <T>(
      builderPromise: Promise<SliceBuilderResult<T>>,
    ): Promise<SliceBuilderResult<T> | TimeoutOutcome> =>
      raceBuilderAgainstDeadline(builderPromise, effectiveSliceDeadline());

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
      launch(
        deps.builders.identity.build({
          base: input.base,
          requirements: ctxRequirements.identity,
          decision: input.decision,
          signal,
        }),
      ),
      launch(
        deps.builders.user.build({
          base: input.base,
          requirements: ctxRequirements.user,
          decision: input.decision,
          signal,
        }),
      ),
      launch(
        deps.builders.knowledge.build({
          base: input.base,
          requirements: ctxRequirements.knowledge,
          decision: input.decision,
          signal,
        }),
      ),
      launch(
        deps.builders.soul.build({
          base: input.base,
          requirements: ctxRequirements.soul,
          decision: input.decision,
          signal,
        }),
      ),
      launch(
        deps.builders.policy.build({
          base: input.base,
          requirements: ctxRequirements.policy,
          decision: input.decision,
          signal,
        }),
      ),
      launch(
        deps.builders.skill.build({
          base: input.base,
          requirements: ctxRequirements.skill,
          decision: input.decision,
          signal,
        }),
      ),
      launch(
        deps.builders.tool.build({
          base: input.base,
          // ToolRequirements is currently `unknown` from the builder's
          // perspective; pass an empty shape.
          requirements: {},
          decision: input.decision,
          signal,
        }),
      ),
      raceBuilderAgainstDeadline(
        deps.historyLoader(input.base, ctxRequirements.history, signal),
        effectiveSliceDeadline(),
      ),
    ]);

    // Policy is non-negotiable. Fail closed on rejection OR timeout — the
    // budget cannot rescue a missing policy slice (spec §3.2 — "fail
    // closed for policy").
    if (policyResult.status === 'rejected') {
      throw policyResult.reason instanceof Error
        ? policyResult.reason
        : new Error(`Policy slice builder failed: ${String(policyResult.reason)}`);
    }
    if (isTimeoutOutcome(policyResult.value)) {
      deps.metrics?.recordCounter?.('context_packet.policy_timeout');
      throw new Error(
        `Policy slice builder exceeded timeout (${timeoutPerSliceMs}ms per-slice / ${budgetMs}ms total). Failing closed.`,
      );
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

    /**
     * Resolve a non-policy slice outcome:
     *   1. Fulfilled with real result → use it.
     *   2. Fulfilled with TimeoutOutcome → try cache; else conservative
     *      empty slice. Mark 'timeout' (or 'cache' if recovered).
     *   3. Rejected → conservative empty slice. Mark 'degraded'.
     */
    const extract = async <T>(
      name: Exclude<SliceName, 'history' | 'policy'>,
      result: PromiseSettledResult<SliceBuilderResult<T> | TimeoutOutcome>,
      fallback: () => T,
      cacheKey: string | null,
    ): Promise<T> => {
      if (result.status === 'fulfilled') {
        if (isTimeoutOutcome(result.value)) {
          // Per-slice or global deadline trip. Try cache first, but ONLY if
          // the total budget still has time left — a hanging Redis get must
          // not defeat the 600ms guarantee (Codex round-2 finding #3).
          assemblyMeta.cache_hits[name] = false;
          let cached: T | null = null;
          const remainingForCache = remainingBudgetMs();
          if (deps.cache && cacheKey && remainingForCache > 0) {
            try {
              // Race the cache read against the remaining budget so a
              // degraded Redis instance cannot hang the entire orchestrator.
              cached = await Promise.race([
                deps.cache.get<T>(cacheKey),
                new Promise<null>((resolve) => {
                  const t = setTimeout(() => resolve(null), remainingForCache);
                  if (typeof t === 'object' && t !== null && 'unref' in t) {
                    (t as { unref: () => void }).unref();
                  }
                }),
              ]);
            } catch {
              cached = null;
            }
          }
          if (cached) {
            assemblyMeta.fallback_depths_applied[name] = 'timeout_cache';
            deps.metrics?.recordCounter?.('context_packet.fallback_applied', {
              slice: name,
              reason: 'timeout_cache',
            });
            return cached;
          }
          assemblyMeta.fallback_depths_applied[name] = 'timeout';
          deps.metrics?.recordCounter?.('context_packet.fallback_applied', {
            slice: name,
            reason: 'timeout',
          });
          return fallback();
        }
        // Real builder result.
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
        reason: 'degraded',
      });
      return fallback();
    };

    /**
     * Pre-compute cache keys so the timeout path can read the last-known value
     * without depending on the (possibly hanging) builder. We swallow any
     * cacheKey-builder error — best-effort lookup only.
     */
    const safeCacheKey = <TReq>(
      builder: SliceBuilder<TReq, unknown>,
      req: TReq,
    ): string | null => {
      try {
        return builder.cacheKey(input.base, req);
      } catch {
        return null;
      }
    };

    const identitySlice = await extract<IdentitySlice>(
      'identity',
      identityResult,
      EMPTY_FALLBACKS.identity,
      safeCacheKey(
        deps.builders.identity as SliceBuilder<unknown, IdentitySlice>,
        ctxRequirements.identity as unknown,
      ),
    );
    const userSlice = await extract<UserSlice>(
      'user',
      userResult,
      EMPTY_FALLBACKS.user,
      safeCacheKey(
        deps.builders.user as SliceBuilder<unknown, UserSlice>,
        ctxRequirements.user as unknown,
      ),
    );
    const knowledgeSlice = await extract<KnowledgeSlice>(
      'knowledge',
      knowledgeResult,
      EMPTY_FALLBACKS.knowledge,
      safeCacheKey(
        deps.builders.knowledge as SliceBuilder<unknown, KnowledgeSlice>,
        ctxRequirements.knowledge as unknown,
      ),
    );
    const soulSlice = await extract<SoulSlice>(
      'soul',
      soulResult,
      EMPTY_FALLBACKS.soul,
      safeCacheKey(
        deps.builders.soul as SliceBuilder<unknown, SoulSlice>,
        ctxRequirements.soul as unknown,
      ),
    );
    const skillSlice = await extract<SkillSlice>(
      'skill',
      skillResult,
      EMPTY_FALLBACKS.skill,
      safeCacheKey(
        deps.builders.skill as SliceBuilder<unknown, SkillSlice>,
        ctxRequirements.skill as unknown,
      ),
    );
    const toolSlice = await extract<ToolPermissionSlice>(
      'tool',
      toolResult,
      EMPTY_FALLBACKS.tool,
      safeCacheKey(
        deps.builders.tool as SliceBuilder<unknown, ToolPermissionSlice>,
        {} as unknown,
      ),
    );

    // Policy fulfilled (rejection / timeout threw earlier)
    assemblyMeta.cache_hits.policy = policySliceResult.cache_hit;
    assemblyMeta.builder_durations_ms.policy = policySliceResult.duration_ms;
    if (policySliceResult.fallback_depth_applied) {
      assemblyMeta.fallback_depths_applied.policy =
        policySliceResult.fallback_depth_applied;
    }

    let historySlice: HistorySlice;
    if (historyResult.status === 'fulfilled') {
      if (isTimeoutOutcome(historyResult.value)) {
        historySlice = { turns: [], truncated: false };
        assemblyMeta.fallback_depths_applied.history = 'timeout';
        deps.metrics?.recordCounter?.('context_packet.fallback_applied', {
          slice: 'history',
          reason: 'timeout',
        });
      } else {
        historySlice = historyResult.value;
        assemblyMeta.cache_hits.history = false; // history not slice-cached
      }
    } else {
      historySlice = { turns: [], truncated: false };
      assemblyMeta.fallback_depths_applied.history = 'degraded';
      deps.metrics?.recordCounter?.('context_packet.fallback_applied', {
        slice: 'history',
        reason: 'degraded',
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
    clearTimeout(budgetTimer);
  }
}

function hashShort16(obj: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(obj))
    .digest('hex')
    .substring(0, 16);
}
