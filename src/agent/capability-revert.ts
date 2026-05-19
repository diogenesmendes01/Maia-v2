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

export type RevertCapabilityResult =
  | { ok: true; technical_gap_id: string }
  | { ok: false; revert_failed: true; reason: string };

export async function revertCapability(args: {
  proposal: CapabilityProposal;
  reason: string;
}): Promise<RevertCapabilityResult> {
  // P9a: skill branch — se o artefato delivered for uma skill, rollback
  // deve ser atômico. Round-2 review #99 finding 2:
  //  - delivery_artifact_ref é obrigatório para capability_type='skill'.
  //  - Falhas de rollback propagam (não são silenciadas): a skill ruim
  //    permanece ativa e o audit NÃO pode mentir dizendo que reverteu.
  //  - O gap técnico só é criado após o rollback ter sucedido.
  if (args.proposal.capability_type === 'skill') {
    if (!args.proposal.delivery_artifact_ref) {
      const msg =
        'p9a.capability_revert.missing_artifact: capability_type=skill requires delivery_artifact_ref to rollback';
      logger.error(
        { proposal_id: args.proposal.id },
        msg,
      );
      return { ok: false, revert_failed: true, reason: msg };
    }
    try {
      await skillsRepo.rollback(
        args.proposal.delivery_artifact_ref,
        args.reason,
        'capability-revert',
      );
    } catch (err) {
      const msg = (err as Error).message;
      logger.error(
        { err: msg, skill_id: args.proposal.delivery_artifact_ref, proposal_id: args.proposal.id },
        'p9a.capability_revert.skill_rollback_failed',
      );
      // Rollback failed: do NOT create a gap that implies revert succeeded.
      // Caller must treat this as a hard failure and keep the skill active
      // in the state machine without marking triggered_revert=true.
      return { ok: false, revert_failed: true, reason: msg };
    }
  }

  // Only reached for non-skill proposals OR after successful skill rollback.
  const newGap = await capabilityGapsRepo.create({
    capability_description: `[técnica] ${args.proposal.title} falhou pós-ativação`,
    tipo: 'technical',
    contexto: args.reason,
  });
  return { ok: true, technical_gap_id: newGap.id };
}
