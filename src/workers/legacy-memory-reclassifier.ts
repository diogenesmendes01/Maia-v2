import { runWithTenantContext } from '@/db/tenant-context.js';
import { memoryEntryRepo, behavioralHintRepo } from '@/db/repositories.js';
import { classifyMemory } from '@/cognition/memory-classifier.js';
import { deriveBehavioralHint } from '@/cognition/behavioral-hint-deriver.js';
import { validateBehavioralHint } from '@/workers/behavioral-hint-validator.js';
import { logger } from '@/lib/logger.js';

/**
 * Reclassifica memory_entry com needs_review=true (legacy migration).
 * P0-era single-tenant shim: roda em escopo do tenant 'default'.
 * P6 introduz iteração por tenant.
 */
export async function runLegacyMemoryReclassifier(): Promise<void> {
  await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
    const pending = await memoryEntryRepo.listNeedsReview(100);
    if (pending.length === 0) {
      logger.info('legacy_memory_reclassifier.idle');
      return;
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

    logger.info(
      { reclassified, failed, pending: pending.length },
      'legacy_memory_reclassifier.done',
    );
  });
}
