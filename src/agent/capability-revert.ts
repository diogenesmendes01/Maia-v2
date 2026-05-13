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
import { capabilityGapsRepo } from '@/db/repositories.js';
import type { CapabilityProposal } from '@/db/schema.js';

export async function revertCapability(args: {
  proposal: CapabilityProposal;
  reason: string;
}): Promise<{ technical_gap_id: string }> {
  const newGap = await capabilityGapsRepo.create({
    capability_description: `[técnica] ${args.proposal.title} falhou pós-ativação`,
    tipo: 'technical',
    contexto: args.reason,
  });
  return { technical_gap_id: newGap.id };
}
