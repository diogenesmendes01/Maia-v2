import { runWithTenantContext } from '@/db/tenant-context.js';
import { capabilitiesDomainRepo, capabilitiesSkillRepo } from '@/db/repositories.js';
import { computeConfidence, daysSinceLastFailure } from '@/cognition/self-model.js';
import { logger } from '@/lib/logger.js';
import { db } from '@/db/client.js';
import { sql } from 'drizzle-orm';

/**
 * Recalcula confidence em todas as capabilities.
 * Necessário porque recency_factor depende do tempo decorrido desde a última falha:
 * uma capability que falhou há 7 dias tem confidence menor que a mesma capability
 * cuja última falha foi há 60 dias, mesmo sem novos sinais.
 *
 * Update só dispara quando |new - current| > 0.005 pra evitar churn em rows
 * cuja confidence já está estabilizada (mantém updated_at significativo).
 *
 * PR #82 review (Codex + Superpowers Critical #5): itera por (tenant_id,
 * agent_id) DISTINCT das tabelas de capabilities. Antes hardcodava 'default'
 * e o decay de confidence não chegava em tenants reais. UNION garante que
 * tenants com só domains ou só skills também entram.
 */
type TenantAgentRow = { tenant_id: string; agent_id: string };

async function listCapabilityTenants(): Promise<TenantAgentRow[]> {
  const result = await db.execute<TenantAgentRow>(sql`
    SELECT DISTINCT tenant_id, agent_id FROM agent_capabilities_domain
    UNION
    SELECT DISTINCT tenant_id, agent_id FROM agent_capabilities_skill
  `);
  return Array.from(result.rows as unknown as TenantAgentRow[]);
}

async function recomputeForTenant(): Promise<{ updated: number; domains: number; skills: number }> {
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

  return { updated, domains: domains.length, skills: skills.length };
}

export async function runConfidenceRecompute(): Promise<void> {
  const tenants = await listCapabilityTenants();
  if (tenants.length === 0) {
    logger.info('confidence_recompute.idle');
    return;
  }

  let totalUpdated = 0;
  let totalDomains = 0;
  let totalSkills = 0;

  for (const { tenant_id, agent_id } of tenants) {
    const stats = await runWithTenantContext({ tenant_id, agent_id }, () =>
      recomputeForTenant(),
    );
    totalUpdated += stats.updated;
    totalDomains += stats.domains;
    totalSkills += stats.skills;
    logger.info(
      { tenant_id, agent_id, ...stats },
      'confidence_recompute.tenant_done',
    );
  }

  logger.info(
    {
      tenants: tenants.length,
      updated: totalUpdated,
      domains: totalDomains,
      skills: totalSkills,
    },
    'confidence_recompute.done',
  );
}
