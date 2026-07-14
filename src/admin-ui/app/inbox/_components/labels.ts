import type { ProposalTypeId, RiskLevelId } from '../../../trpc/types.js';

/** Rótulos pt-BR dos tipos de proposta (espelham proposal-type-registry). */
export const TYPE_LABELS: Record<ProposalTypeId, string> = {
  policy_rule: 'Regra de política',
  soul_bias: 'Viés de identidade',
  skill: 'Skill',
  capability_proposal: 'Capacidade',
  knowledge_proposal: 'Conhecimento',
};

export const ALL_TYPES: ProposalTypeId[] = [
  'policy_rule',
  'soul_bias',
  'skill',
  'capability_proposal',
  'knowledge_proposal',
];

/** Rótulos pt-BR dos níveis de risco (valores brutos seguem em inglês na API). */
export const RISK_LABELS: Record<RiskLevelId, string> = {
  low: 'Baixo',
  medium: 'Médio',
  high: 'Alto',
  critical: 'Crítico',
};

export const ALL_RISKS: RiskLevelId[] = ['low', 'medium', 'high', 'critical'];
