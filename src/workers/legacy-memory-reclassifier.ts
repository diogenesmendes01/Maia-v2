import { runWithTenantContext } from '@/db/tenant-context.js';
import { memoryEntryRepo, behavioralHintRepo } from '@/db/repositories.js';
import { classifyMemory } from '@/cognition/memory-classifier.js';
import { deriveBehavioralHint } from '@/cognition/behavioral-hint-deriver.js';
import { validateBehavioralHint } from '@/workers/behavioral-hint-validator.js';
import { logger } from '@/lib/logger.js';
import { db } from '@/db/client.js';
import { sql } from 'drizzle-orm';

/**
 * Reclassifica memory_entry com needs_review=true (legacy migration).
 *
 * PR #82 review (Codex + Superpowers Critical #5): itera por (tenant_id,
 * agent_id) DISTINCT da tabela memory_entry e roda cada lote dentro do
 * próprio runWithTenantContext. Antes desta correção o worker hardcodava
 * 'default'/'default', deixando memórias de outros tenants permanentemente
 * presas em needs_review=true (bloqueadas do prompt).
 */
type TenantAgentRow = { tenant_id: string; agent_id: string };

async function listTenantsWithPendingReview(): Promise<TenantAgentRow[]> {
  const result = await db.execute<TenantAgentRow>(sql`
    SELECT DISTINCT tenant_id, agent_id
    FROM memory_entry
    WHERE needs_review = true
  `);
  return Array.from(result.rows as unknown as TenantAgentRow[]);
}

async function reclassifyForTenant(): Promise<{ reclassified: number; failed: number; pending: number }> {
  const pending = await memoryEntryRepo.listNeedsReview(100);
  if (pending.length === 0) {
    return { reclassified: 0, failed: 0, pending: 0 };
  }

  let reclassified = 0;
  let failed = 0;

  for (const entry of pending) {
    try {
      const classified = await classifyMemory(entry.content);
      if (!classified) {
        failed++;
        continue;
      }

      const expires_at = classified.ttl_days
        ? new Date(Date.now() + classified.ttl_days * 24 * 60 * 60 * 1000)
        : null;

      await memoryEntryRepo.markReviewed(entry.id, {
        memory_type: classified.memory_type,
        scope_type: classified.scope_type,
        subject_id: entry.subject_id ?? undefined,
        sensitivity: classified.sensitivity,
        proactive_use: classified.proactive_use,
        mention_allowed: classified.mention_allowed,
        ttl_days: classified.ttl_days ?? null,
      });

      // If sensitive, derive + validate + persist hint
      if (classified.memory_type === 'sensitive') {
        try {
          const derived = await deriveBehavioralHint(entry.content);
          if (derived) {
            const validation = await validateBehavioralHint(derived.hint_text, entry.content);
            if (validation.approved) {
              await behavioralHintRepo.create({
                scope_type: classified.scope_type,
                subject_id: entry.subject_id ?? null,
                hint_text: derived.hint_text,
                derived_from_memory_id: entry.id,
                derived_sensitivity: derived.derived_sensitivity,
                ttl_days: classified.ttl_days,
                extension_reason: null,
                extension_approved_by: null,
                extension_approved_at: null,
                lifecycle_status: 'active',
                evidence_count: 1,
                // PR #94 round-2: pass [] not JSON.stringify([]) — Drizzle
                // jsonb mapper serializes; double-encoding fails CHECK.
                lifecycle_transitions: [],
                confidence: '0.5',
                expires_at,
                revoked_at: null,
              });
            }
          }
        } catch (err) {
          logger.warn(
            { err: (err as Error).message, memory_id: entry.id },
            'legacy_reclassifier.hint_failed',
          );
        }
      }

      reclassified++;
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, memory_id: entry.id },
        'legacy_reclassifier.failed',
      );
      failed++;
    }
  }

  return { reclassified, failed, pending: pending.length };
}

export async function runLegacyMemoryReclassifier(): Promise<void> {
  const tenants = await listTenantsWithPendingReview();
  if (tenants.length === 0) {
    logger.info('legacy_memory_reclassifier.idle');
    return;
  }

  let totalReclassified = 0;
  let totalFailed = 0;
  let totalPending = 0;

  for (const { tenant_id, agent_id } of tenants) {
    const stats = await runWithTenantContext({ tenant_id, agent_id }, () =>
      reclassifyForTenant(),
    );
    totalReclassified += stats.reclassified;
    totalFailed += stats.failed;
    totalPending += stats.pending;
    logger.info(
      { tenant_id, agent_id, ...stats },
      'legacy_memory_reclassifier.tenant_done',
    );
  }

  logger.info(
    {
      tenants: tenants.length,
      reclassified: totalReclassified,
      failed: totalFailed,
      pending: totalPending,
    },
    'legacy_memory_reclassifier.done',
  );
}
