import { db } from '@/db/client.js';
import { audit_log } from '@/db/schema.js';
import { sql } from 'drizzle-orm';
import { auditRepo } from '@/db/repositories.js';
import { reflect } from '@/cognition/reflector.js';
import { classify } from '@/cognition/classifier.js';
import { persistCandidate } from '@/cognition/persister.js';
import { CognitiveEventType } from '@/types/enums.js';
import {
  runWithTenantContext,
  getCurrentTenant,
  getCurrentAgent,
} from '@/db/tenant-context.js';
import { logger } from '@/lib/logger.js';

const MIN_OCCURRENCES = 3;

/**
 * Issue #345 (Phase 4 of #323) — per-tenant fan-out for `pattern-detector`.
 *
 * BEFORE: `runPatternDetector` opened a HARDCODED
 * `runWithTenantContext({ tenant_id: 'default', agent_id: 'default' })` and ran
 * the inner once. WORSE, the inner's `audit_log` aggregation carried a hardcoded
 * SQL literal `WHERE tenant_id = 'default' AND agent_id = 'default'` (the old
 * FIXME), so even under a multi-tenant deployment ONLY the `default` agent's
 * audit patterns were ever reflected on — every real tenant's repeated-correction
 * patterns were invisible to the reflection pipeline.
 *
 * AFTER: the worker is a DISPATCHER. It enumerates — OUTSIDE any tenant context —
 * the DISTINCT (tenant_id, agent_id) tuples with audit rows in the same 24h
 * window (`auditRepo.listTenantAgentPairsWithRecentAudit`), then runs the inner
 * once PER tuple inside `runWithTenantContext`. The inner's SQL literal is
 * REPLACED with `getCurrentTenant()`/`getCurrentAgent()` bindings, so each pass
 * aggregates EXCLUSIVELY the current tuple's audit rows — `array_agg(alvo_id)`
 * therefore only ever contains ids from the running tenant/agent, preserving the
 * inviolable cross-tenant isolation invariant.
 *
 * Behavior-preserving in single-tenant mode: when the only audit data lives
 * under `('default','default')`, the enumeration yields exactly that one tuple,
 * so the inner still runs once under default. Fail-isolated per tuple (mirrors
 * reflection-batch #251 / conversation-summarizer #350).
 */
export async function runPatternDetector(): Promise<void> {
  const tuples = await auditRepo.listTenantAgentPairsWithRecentAudit();

  if (tuples.length === 0) {
    logger.debug('pattern_detector.idle');
    return;
  }

  let agents_processed = 0;
  let agents_failed = 0;

  for (const { tenant_id, agent_id } of tuples) {
    try {
      await runWithTenantContext({ tenant_id, agent_id }, runPatternDetectorInner);
      agents_processed++;
    } catch (err) {
      // Fail-isolated per (tenant, agent): a throw under one tuple must not
      // abort the others.
      agents_failed++;
      logger.warn(
        {
          tenant_id,
          agent_id,
          err: (err as Error).message,
          stack: (err as Error).stack,
        },
        'pattern_detector.agent_failed',
      );
    }
  }

  logger.info(
    { tuples: tuples.length, agents_processed, agents_failed },
    'pattern_detector.done',
  );
}

/**
 * Detecta padrões repetidos em audit_log nas últimas 24h para o (tenant_id,
 * agent_id) ATUAL.
 *
 * Issue #345 (Phase 4): this inner runs ONCE PER enumerated (tenant_id,
 * agent_id) tuple. The aggregation below is a RAW `db.execute()` that does NOT
 * pass through the tenant guard, so it MUST carry an EXPLICIT (tenant_id,
 * agent_id) predicate bound from the ALS context — otherwise a per-tuple run
 * would aggregate EVERY tenant's audit rows and `array_agg(alvo_id)` would mix
 * ids across tenants, violating the inviolable cross-tenant isolation invariant.
 * Bind the same pair the dispatcher partitions on.
 */
async function runPatternDetectorInner(): Promise<void> {
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();

  // The WHERE clause restricts to the CURRENT tenant/agent (bound from ALS),
  // so `array_agg(alvo_id)` cannot contain ids from other tenants.
  const rows = await db.execute<{ pattern: string; count: number; alvo_ids: string[] }>(sql`
    SELECT
      acao || '|' || COALESCE((metadata->>'descricao'), '') AS pattern,
      count(*) AS count,
      array_agg(DISTINCT alvo_id::text) FILTER (WHERE alvo_id IS NOT NULL) AS alvo_ids
    FROM ${audit_log}
    WHERE tenant_id = ${tenant_id}
      AND agent_id = ${agent_id}
      AND created_at >= now() - interval '24 hours'
    GROUP BY pattern
    HAVING count(*) >= ${MIN_OCCURRENCES}
    ORDER BY count DESC
    LIMIT 20
  `);

  for (const r of rows.rows as Array<{ pattern: string; count: number; alvo_ids: string[] }>) {
    const event = {
      type: CognitiveEventType.PATTERN_DETECTED,
      pattern_descriptor: r.pattern,
      evidence_count: Number(r.count),
      evidence_ids: r.alvo_ids ?? [],
    } as const;
    try {
      const reflected = await reflect(event);
      if (!reflected) continue;
      const classified = await classify(reflected.insight);
      if (!classified) continue;
      await persistCandidate(classified, event, 'worker');
    } catch (err) {
      logger.warn({ err: (err as Error).message, pattern: r.pattern }, 'pattern_detector.failed');
    }
  }
}
