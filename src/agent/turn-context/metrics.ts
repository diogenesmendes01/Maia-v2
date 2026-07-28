/**
 * Issue #511 — observability surface for turn-context loading.
 *
 * Metric names are fixed by the issue's §Observabilidade:
 *   - `maia_turn_context_load_duration_ms{phase,result}`
 *   - `maia_turn_context_db_queries{phase}`
 *   - `maia_turn_context_cache_total{section,result}`
 *   - `maia_turn_context_section_total{section,status}`
 *   - `maia_turn_context_truncated_total{section,reason}`
 *   - `maia_turn_context_bytes{section}`
 *   - `maia_turn_context_tokens_estimated{section}`
 *
 * Label discipline (same rule as `RedisOomCaller` in `src/lib/redis.ts`): every
 * label value comes from a CLOSED code-set union below. Tenant/agent ids,
 * pessoa ids, conversa ids and free-form reasons are NEVER labels — they would
 * blow up Prometheus cardinality. Per-tenant attribution flows through the
 * structured turn log, which carries the trace id and the degraded section
 * names but never section CONTENT (issue #511 §Observabilidade).
 */
import { incCounter, observeHistogram } from '@/lib/metrics.js';

/**
 * Phase of the two-phase turn load.
 *
 *  - `critical`: cheap, security-relevant context loaded BEFORE the Decision
 *    Engine gate. A failure here is fail-closed.
 *  - `optional`: reasoner context, loaded only for turns the gate allowed.
 *  - `legacy`: the pre-#511 prompt-builder waterfall, kept as the baseline the
 *    optimisation is measured against.
 */
export type TurnContextPhase = 'critical' | 'optional' | 'legacy';

export type TurnContextResult = 'ok' | 'degraded' | 'error';

/**
 * Closed set of loadable context sections. Adding a member here is a
 * deliberate act — it is also a new Prometheus label value.
 */
export type TurnContextSection =
  | 'identity'
  | 'history'
  | 'entities'
  | 'entity_states'
  | 'facts'
  | 'rules'
  | 'memories'
  | 'hints'
  | 'capabilities'
  | 'gaps'
  | 'role'
  | 'procedure';

export type SectionStatus = 'loaded' | 'empty' | 'degraded';

/**
 * Cache outcomes. `negative_hit` is a cached "known absent" (so a repeated miss
 * does not re-hit the DB); `bypass` means the section is not cacheable or the
 * cache was disabled; `error` means the cache backend itself failed and the
 * loader fell through to the DB.
 */
export type CacheResult =
  | 'hit'
  | 'miss'
  | 'negative_hit'
  | 'bypass'
  | 'error'
  /**
   * The value was loaded but NOT stored, because this process is not confirmed
   * subscribed to the tenant's invalidation channel. A non-zero rate here means
   * the cache is doing nothing for that tenant — which is safe, but must be
   * visible rather than inferred from a mysteriously flat hit rate.
   */
  | 'unsubscribed';

/**
 * Why a section was truncated. Closed set — the actual counts go in the
 * structured log, not in labels.
 */
export type TruncationReason = 'max_items' | 'max_bytes';

export function recordTurnContextLoad(args: {
  phase: TurnContextPhase;
  result: TurnContextResult;
  duration_ms: number;
  query_count: number;
}): void {
  observeHistogram('maia_turn_context_load_duration_ms', args.duration_ms, {
    phase: args.phase,
    result: args.result,
  });
  incCounter('maia_turn_context_db_queries', { phase: args.phase }, args.query_count);
}

export function recordSectionStatus(section: TurnContextSection, status: SectionStatus): void {
  incCounter('maia_turn_context_section_total', { section, status });
}

export function recordCacheOutcome(section: TurnContextSection, result: CacheResult): void {
  incCounter('maia_turn_context_cache_total', { section, result });
}

export function recordTruncation(
  section: TurnContextSection,
  reason: TruncationReason,
  lost: number,
): void {
  // The counter tracks HOW MANY ITEMS were lost — removed entirely, or (for
  // `max_bytes`) clipped to fit — not how many truncation events happened. An
  // operator watching this wants "we are losing context at rate X", and one
  // event dropping 80 facts is not the same incident as 80 events dropping one
  // each. A section that hits BOTH limits reports each separately, so the
  // labels say which knob to turn.
  incCounter('maia_turn_context_truncated_total', { section, reason }, lost);
}

export function recordSectionSize(
  section: TurnContextSection,
  bytes: number,
  tokens_estimated: number,
): void {
  incCounter('maia_turn_context_bytes', { section }, bytes);
  incCounter('maia_turn_context_tokens_estimated', { section }, tokens_estimated);
}
