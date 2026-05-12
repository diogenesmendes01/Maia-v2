import { runWithTenantContext } from '@/db/tenant-context.js';
import { capabilitiesDomainRepo, capabilitiesSkillRepo } from '@/db/repositories.js';
import { computeConfidence, daysSinceLastFailure } from '@/cognition/self-model.js';
import { logger } from '@/lib/logger.js';

/**
 * Recalcula confidence em todas as capabilities.
 * Necessário porque recency_factor depende do tempo decorrido desde a última falha:
 * uma capability que falhou há 7 dias tem confidence menor que a mesma capability
 * cuja última falha foi há 60 dias, mesmo sem novos sinais.
 *
 * Update só dispara quando |new - current| > 0.005 pra evitar churn em rows
 * cuja confidence já está estabilizada (mantém updated_at significativo).
 */
export async function runConfidenceRecompute(): Promise<void> {
  await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
    const domains = await capabilitiesDomainRepo.listAll();
    const skills = await capabilitiesSkillRepo.listAll();

    let updated = 0;

    for (const d of domains) {
      const newConfidence = computeConfidence({
        success_count: d.success_count,
        failure_count: d.failure_count,
        evidence_count: d.evidence_count,
        days_since_last_failure: daysSinceLastFailure(d.last_failure),
      });
      const currentConfidence = Number(d.confidence);
      if (Math.abs(newConfidence - currentConfidence) > 0.005) {
        await capabilitiesDomainRepo.upsertConfidence(d.domain, {
          confidence: newConfidence.toFixed(3) as unknown as typeof d.confidence,
        });
        updated++;
      }
    }

    for (const s of skills) {
      const newConfidence = computeConfidence({
        success_count: s.success_count,
        failure_count: s.failure_count,
        evidence_count: s.evidence_count,
        days_since_last_failure: daysSinceLastFailure(s.last_failure),
      });
      const currentConfidence = Number(s.confidence);
      if (Math.abs(newConfidence - currentConfidence) > 0.005) {
        await capabilitiesSkillRepo.upsertConfidence(s.domain, s.skill_name, {
          confidence: newConfidence.toFixed(3) as unknown as typeof s.confidence,
        });
        updated++;
      }
    }

    logger.info(
      { updated, domains: domains.length, skills: skills.length },
      'confidence_recompute.done',
    );
  });
}
