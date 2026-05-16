/**
 * P5 Task 8 — capability-revert.
 *
 * Quando uma capability proposta cai em outcome='fail' no loop fechado
 * (runCapabilityTests), o sistema cria um novo capability_gap derivado com
 * tipo='technical'. Esse gap não vira nova proposal automaticamente — fica no
 * backlog para investigação humana (ou ciclo seguinte do engine determinístico).
 *
 * Invariantes:
 *  - capability_description tem prefixo `[técnica]` para distinguir de gaps
 *    descobertos via reflexão normal (tool/knowledge/procedure).
 *  - tipo='technical' depende da migration 030 (CHECK constraint expandida).
 *  - Não escala automaticamente; respeita o engine de escalação do P5 Task 6.
 *  - args.reason vira `contexto` do gap (auditável; aparece em listagens do
 *    dashboard e nas evidências passadas ao proposer no próximo ciclo).
 */
import { capabilityGapsRepo, skillsRepo } from '@/db/repositories.js';
import type { CapabilityProposal } from '@/db/schema.js';
import { logger } from '@/lib/logger.js';

export async function revertCapability(args: {
  proposal: CapabilityProposal;
  reason: string;
}): Promise<{ technical_gap_id: string }> {
  // P9a: skill branch — se o artefato delivered for uma skill, marcar
  // como rolled_back (que reativa a versão anterior dentro da mesma
  // transação no skillsRepo). O technical gap é criado em qualquer caso
  // — preserva auditoria e backlog para investigação humana.
  if (args.proposal.capability_type === 'skill' && args.proposal.delivery_artifact_ref) {
    try {
      await skillsRepo.rollback(
        args.proposal.delivery_artifact_ref,
        args.reason,
        'capability-revert',
      );
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, skill_id: args.proposal.delivery_artifact_ref },
        'p9a.capability_revert.skill_rollback_failed',
      );
    }
  }

  const newGap = await capabilityGapsRepo.create({
    capability_description: `[técnica] ${args.proposal.title} falhou pós-ativação`,
    tipo: 'technical',
    contexto: args.reason,
  });
  return { technical_gap_id: newGap.id };
}
