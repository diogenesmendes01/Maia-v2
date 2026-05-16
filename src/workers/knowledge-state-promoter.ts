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
import { FEATURE_KNOWLEDGE_STATE_MACHINE_V1 } from '@/config/feature-flags.js';
import { KnowledgeStateMachine } from '@/control-plane/knowledge-state-machine/state-machine.js';
import { knowledgeRepos } from '@/control-plane/knowledge-state-machine/repos.js';
import { IllegalTransitionError } from '@/control-plane/knowledge-state-machine/transitions.js';
import type {
  KnowledgeKind,
  KnowledgeDecidedBy,
  KnowledgeLifecycleStatus,
} from '@/control-plane/knowledge-state-machine/types.js';

const KINDS: KnowledgeKind[] = ['memory', 'fact', 'rule', 'behavioral_hint'];
const PER_TICK_LIMIT = 100;

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

async function promote(args: {
  from: KnowledgeLifecycleStatus;
  to: KnowledgeLifecycleStatus;
  filter: ReturnType<typeof sql>;
  reason: string;
  decided_by: KnowledgeDecidedBy;
  stats: PromoteStats;
  counterKey: keyof PromoteStats;
}): Promise<void> {
  for (const kind of KINDS) {
    let rows: Array<{ id: string }>;
    try {
      rows = await knowledgeRepos.listEligible({
        kind,
        from: args.from,
        extraFilter: args.filter,
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
        await KnowledgeStateMachine.transition({
          kind,
          proposal_id: row.id,
          to: args.to,
          reason: args.reason,
          decided_by: args.decided_by,
        });
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
  if (!FEATURE_KNOWLEDGE_STATE_MACHINE_V1) {
    logger.debug({}, 'knowledge_state_promoter.skipped_disabled');
    return;
  }

  const result = await runCognitiveModule(
    {
      name: 'knowledge-state-machine.auto-promoter',
      version: 'v1',
      triggered_by: 'async_event',
      timeoutMs: 60_000,
      audit: true,
    },
    async () => {
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
      //    Some knowledge tables don't have a 'confidence' column; use the
      //    legacy 'confianca' fallback when present. Casting both to numeric
      //    in SQL avoids dialect-specific COALESCE quirks.
      await promote({
        from: 'verified',
        to: 'active',
        filter: sql`evidence_count >= 10 AND COALESCE(confidence, confianca, 0) >= 0.9`,
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

      logger.info(stats, 'knowledge_state_promoter.tick.done');
      return stats;
    },
  );

  if (result.status === 'error' || result.status === 'timeout') {
    logger.warn(
      { status: result.status, latency_ms: result.latency_ms },
      'knowledge_state_promoter.tick.degraded',
    );
  }
}
