/**
 * P10a — Knowledge State auto-promoter worker.
 *
 * Cron: every 1h (`0 * * * *`) — registered in workers/index.ts.
 *
 * For each of the 4 knowledge tables, sweeps rows in eligible states
 * and applies KnowledgeStateMachine.transition() to mature or expire
 * them. All transitions are individually validated against
 * ALLOWED_TRANSITIONS (no bulk UPDATE) so the lifecycle_transitions
 * audit trail is complete.
 *
 * Master §5.1 thresholds (Architecture Lock):
 *   - ephemeral  → observed     : evidence_count >= 1 within 24h
 *   - observed   → reinforced   : evidence_count >= 3 within 30d
 *   - reinforced → verified     : evidence_count >= 7 within 90d
 *   - verified   → active       : confidence >= 0.9 AND evidence_count >= 10
 *   - ephemeral  → deprecated   : updated_at < now - 30d (TTL expired)
 *   - active/verified → deprecated : last_recall_at < now - 90d
 *
 * Idempotency: each tick re-queries by lifecycle_status filter so
 * rows already promoted don't re-appear in the next tick. Running the
 * worker twice in a row produces the same final state (property test
 * §11.4 in p10a-knowledge-lifecycle integration).
 */

import { sql } from 'drizzle-orm';
import { runCognitiveModule } from '@/cognition/runner.js';
import { logger } from '@/lib/logger.js';
import { featureFlags } from '@/config/feature-flags.js';
import { FeatureFlagName } from '@/types/enums.js';
import { KnowledgeStateMachine } from '@/control-plane/knowledge-state-machine/state-machine.js';
import { knowledgeRepos } from '@/control-plane/knowledge-state-machine/repos.js';
import { IllegalTransitionError } from '@/control-plane/knowledge-state-machine/transitions.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import type {
  KnowledgeKind,
  KnowledgeDecidedBy,
  KnowledgeLifecycleStatus,
} from '@/control-plane/knowledge-state-machine/types.js';

const KINDS: KnowledgeKind[] = ['memory', 'fact', 'rule', 'behavioral_hint'];
const PER_TICK_LIMIT = 100;

/**
 * P10a (review #104 high): the four knowledge tables don't share a
 * confidence column. Facts/rules use the legacy Portuguese `confianca`
 * (numeric(3,2)); memories/hints use the English `confidence`
 * (numeric(4,3)). Building a single `COALESCE(confidence, confianca, 0)`
 * predicate raises `column does not exist` on PostgreSQL the moment the
 * query touches a table that lacks one of them — so the verified→active
 * promotion silently fails for every table and only the list error is
 * logged.
 *
 * Build the maturity predicate per-table using the actual column name.
 */
function maturityFilter(kind: KnowledgeKind, minConfidence: number, minEvidence: number) {
  const confCol =
    kind === 'fact' || kind === 'rule' ? sql.raw('confianca') : sql.raw('confidence');
  return sql`evidence_count >= ${minEvidence} AND ${confCol} >= ${minConfidence}`;
}

interface PromoteStats {
  ephemeral_to_observed: number;
  observed_to_reinforced: number;
  reinforced_to_verified: number;
  verified_to_active: number;
  ephemeral_to_deprecated: number;
  active_to_deprecated: number;
  errors: number;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Per-tick promotion across all 4 user-layer knowledge tables.
 *
 * `filter` is either a single SQL fragment that works for every table
 * (e.g. "evidence_count >= N AND updated_at >= cutoff") or a factory
 * returning per-table fragments — needed for the verified→active
 * maturity check because facts/rules and memories/hints store
 * confidence in different columns.
 */
async function promote(args: {
  from: KnowledgeLifecycleStatus;
  to: KnowledgeLifecycleStatus;
  filter:
    | ReturnType<typeof sql>
    | ((kind: KnowledgeKind) => ReturnType<typeof sql>);
  reason: string;
  decided_by: KnowledgeDecidedBy;
  stats: PromoteStats;
  counterKey: keyof PromoteStats;
}): Promise<void> {
  const filterFor = (kind: KnowledgeKind) =>
    typeof args.filter === 'function' ? args.filter(kind) : args.filter;

  for (const kind of KINDS) {
    let rows: Array<{ id: string; tenant_id: string; agent_id: string }>;
    try {
      rows = await knowledgeRepos.listEligible({
        kind,
        from: args.from,
        extraFilter: filterFor(kind),
        limit: PER_TICK_LIMIT,
      });
    } catch (err) {
      args.stats.errors++;
      logger.error(
        { err, kind, from: args.from, to: args.to },
        'knowledge_state_promoter.list_eligible_failed',
      );
      continue;
    }

    for (const row of rows) {
      try {
        // Issue #234 — establish ALS tenant context per row using the
        // row's persisted tenant_id+agent_id. The KSM facade's
        // findById/update for `kind: 'rule'` enforce
        // tenant_id+agent_id scoping via ALS (mirrors rulesRepo
        // mutators from PR #232). Without this wrapper the auto-
        // promoter would throw MissingTenantContextError on every
        // transition() against a rule. Same scope is used for non-rule
        // kinds for consistency.
        //
        // Issue #255 — the per-row `runCognitiveModule` wrap ALSO lives
        // inside the tenant-context. Audit-write paths
        // (`cognitiveModuleLogRepo.record` and the runner's
        // `tryGetCurrentContext`) require an ALS context to attribute the
        // execution to the correct tenant/agent. Before this fix a single
        // outer `runCognitiveModule` enclosed the whole batch loop, so its
        // audit row landed under ('default','default') and an entire
        // batch spanning N tenants was attributed to none of them. We now
        // emit one `knowledge-state-machine.auto-promoter.row` audit per
        // row, scoped to that row's tenant_id+agent_id. The cron tick
        // still produces a single batch-level log line below
        // ('knowledge_state_promoter.tick.done'), so operators retain a
        // batch summary without the audit-attribution leak.
        await runWithTenantContext(
          { tenant_id: row.tenant_id, agent_id: row.agent_id },
          async () => {
            // Issue #255 Codex review (MAJOR) — preserve error identity
            // across the runCognitiveModule boundary. The runner catches
            // the inner throw, classifies it as status='error'|'timeout',
            // and DOES NOT re-throw — so by the time `rowResult.status`
            // is observed the original Error object (e.g.
            // `IllegalTransitionError` from a parallel-promote race) is
            // unreachable. Without capturing it here, the outer catch's
            // `err instanceof IllegalTransitionError` branch (used to
            // mark benign races as debug-skip) becomes dead code and
            // every race increments `stats.errors`.
            //
            // We close over `capturedError` inside the inner callback,
            // assign the real thrown object there, and re-throw it after
            // runCognitiveModule returns. Status='timeout' (no error
            // ever thrown — the runner generated the 'timeout' message
            // itself) falls back to a synthetic Error so audit
            // attribution still lands and the outer catch logs it
            // through the normal "transition_failed" path.
            let capturedError: unknown = null;
            const rowResult = await runCognitiveModule(
              {
                name: 'knowledge-state-machine.auto-promoter.row',
                version: 'v1',
                triggered_by: 'async_event',
                // Per-row budget: each transition is a single
                // findById+update round trip. 10s leaves comfortable
                // headroom even on a contended DB while keeping the
                // outer cron tick bounded (PER_TICK_LIMIT × KINDS ×
                // promote steps × 10s would still finish well under the
                // hourly cron interval).
                timeoutMs: 10_000,
                audit: true,
              },
              async () => {
                try {
                  return await KnowledgeStateMachine.transition({
                    kind,
                    proposal_id: row.id,
                    to: args.to,
                    reason: args.reason,
                    decided_by: args.decided_by,
                  });
                } catch (err) {
                  // Capture BEFORE the runner swallows the throw so the
                  // outer catch can pattern-match on `IllegalTransitionError`
                  // (parallel-promote race = benign) vs everything else.
                  capturedError = err;
                  throw err;
                }
              },
            );
            // Re-raise the original error if transition() threw — keeps
            // IllegalTransitionError identity intact for the outer catch.
            // Timeout case: runCognitiveModule synthesizes its own
            // 'timeout' Error in the race; nothing was captured, so we
            // surface a synthetic Error tagged with the timeout reason.
            if (rowResult.status === 'error' || rowResult.status === 'timeout') {
              if (capturedError !== null) {
                throw capturedError;
              }
              throw new Error(
                `auto_promoter_row_${rowResult.status}` +
                  (rowResult.fallback_triggered ? ':fallback_triggered' : ''),
              );
            }
          },
        );
        (args.stats[args.counterKey] as number)++;
      } catch (err) {
        // IllegalTransitionError from a row that was already moved
        // by a parallel tick is benign; everything else logs.
        if (err instanceof IllegalTransitionError) {
          logger.debug(
            { err, kind, id: row.id, from: args.from, to: args.to },
            'knowledge_state_promoter.skipped_illegal_transition',
          );
          continue;
        }
        args.stats.errors++;
        logger.error(
          { err, kind, id: row.id, from: args.from, to: args.to },
          'knowledge_state_promoter.transition_failed',
        );
      }
    }
  }
}

export async function runKnowledgeStatePromoter(): Promise<void> {
  // P10a (review #104 high): use the runtime feature-flag singleton
  // so a kill switch takes effect on the next tick without a redeploy.
  // The previous code path read the module-level constant
  // FEATURE_KNOWLEDGE_STATE_MACHINE_V1 at import time, which froze the
  // value at startup.
  if (!featureFlags.isEnabled(FeatureFlagName.KNOWLEDGE_STATE_MACHINE_V1)) {
    logger.debug({}, 'knowledge_state_promoter.skipped_disabled');
    return;
  }

  // Issue #255 — the outer `runCognitiveModule` wrap was removed: a
  // single batch can span multiple tenants (listEligible returns rows
  // from any tenant whose lifecycle_status matches), so there is no
  // valid tenant_id/agent_id to attribute the batch-level cognitive log
  // to. Before the fix, the outer wrap ran outside any
  // `runWithTenantContext` and the audit row landed on
  // ('default','default') — a metadata leak across tenants.
  //
  // The audit attribution now lives inside `promote()` per row, where
  // the row's persisted tenant_id+agent_id are routed through ALS
  // before `runCognitiveModule` calls `tryGetCurrentContext()`. The
  // batch-level summary remains as a `logger.info` line below so
  // operators still see "this tick did N things" without the leak.
  const tickStart = Date.now();
  const stats: PromoteStats = {
    ephemeral_to_observed: 0,
    observed_to_reinforced: 0,
    reinforced_to_verified: 0,
    verified_to_active: 0,
    ephemeral_to_deprecated: 0,
    active_to_deprecated: 0,
    errors: 0,
  };

  const ageCutoff = (days: number) =>
    new Date(Date.now() - days * ONE_DAY_MS);

  try {
    // 1. ephemeral → observed (evidence_count >= 1 within last 24h)
    await promote({
      from: 'ephemeral',
      to: 'observed',
      filter: sql`evidence_count >= 1 AND updated_at >= ${ageCutoff(1)}`,
      reason: 'evidence_threshold:1_in_24h',
      decided_by: 'auto_promoter:evidence_threshold',
      stats,
      counterKey: 'ephemeral_to_observed',
    });

    // 2. observed → reinforced (evidence_count >= 3 within 30d)
    await promote({
      from: 'observed',
      to: 'reinforced',
      filter: sql`evidence_count >= 3 AND updated_at >= ${ageCutoff(30)}`,
      reason: 'evidence_threshold:3_in_30d',
      decided_by: 'auto_promoter:evidence_threshold',
      stats,
      counterKey: 'observed_to_reinforced',
    });

    // 3. reinforced → verified (evidence_count >= 7 within 90d)
    await promote({
      from: 'reinforced',
      to: 'verified',
      filter: sql`evidence_count >= 7 AND updated_at >= ${ageCutoff(90)}`,
      reason: 'evidence_threshold:7_in_90d',
      decided_by: 'auto_promoter:evidence_threshold',
      stats,
      counterKey: 'reinforced_to_verified',
    });

    // 4. verified → active (conf>=0.9, evidence>=10 — conservative maturity)
    //    Per-table predicate: facts/rules store confidence as
    //    `confianca` (numeric(3,2)), memories/hints as `confidence`
    //    (numeric(4,3)). Referencing both in a single COALESCE
    //    raises "column does not exist" on PostgreSQL (review #104).
    await promote({
      from: 'verified',
      to: 'active',
      filter: (kind) => maturityFilter(kind, 0.9, 10),
      reason: 'maturity_threshold:conf_0.9_evidence_10',
      decided_by: 'auto_promoter:maturity_threshold',
      stats,
      counterKey: 'verified_to_active',
    });

    // 5. ephemeral → deprecated (TTL: 30d without updated_at refresh)
    await promote({
      from: 'ephemeral',
      to: 'deprecated',
      filter: sql`updated_at < ${ageCutoff(30)}`,
      reason: 'ttl_expired:30d_no_update',
      decided_by: 'auto_promoter:ttl_expired',
      stats,
      counterKey: 'ephemeral_to_deprecated',
    });

    // 6. active → deprecated (90d no usage; uses last_recall_at, falls
    //    back to updated_at when null — matches master §5.1).
    await promote({
      from: 'active',
      to: 'deprecated',
      filter: sql`COALESCE(last_recall_at, updated_at) < ${ageCutoff(90)}`,
      reason: 'no_usage_90d',
      decided_by: 'auto_promoter:no_usage_90d',
      stats,
      counterKey: 'active_to_deprecated',
    });

    logger.info(
      { ...stats, latency_ms: Date.now() - tickStart },
      'knowledge_state_promoter.tick.done',
    );
  } catch (err) {
    // Unexpected throw at the batch level — individual promote() calls
    // already swallow per-row errors and increment stats.errors. Surface
    // anything that escapes (e.g. listEligible at the outer promote()
    // failing in an unexpected way) so the cron tick stays visible.
    logger.error(
      { err: (err as Error).message, ...stats, latency_ms: Date.now() - tickStart },
      'knowledge_state_promoter.tick.degraded',
    );
  }
}
