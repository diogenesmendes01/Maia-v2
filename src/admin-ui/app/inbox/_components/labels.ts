import type { ProposalTypeId, RiskLevelId } from '../../../trpc/types.js';

/** Rótulos pt-BR dos tipos de proposta (espelham proposal-type-registry). */
export const TYPE_LABELS: Record<ProposalTypeId, string> = {
  policy_rule: 'Regra de política',
  soul_bias: 'Viés de identidade',
  skill: 'Skill',
  capability_proposal: 'Capacidade',
  knowledge_proposal: 'Conhecimento',
  operational_profile: 'Perfil operacional',
};

// Spec perfil-inbox v4 §3 (fase C) — operational_profile é um source NATIVO
// do motor unificado: contador, tabela, diff e decisão vivem nesta fila.
export const ALL_TYPES: ProposalTypeId[] = [
  'policy_rule',
  'soul_bias',
  'skill',
  'capability_proposal',
  'knowledge_proposal',
  'operational_profile',
];

/** Rótulos pt-BR dos níveis de risco (valores brutos seguem em inglês na API). */
export const RISK_LABELS: Record<RiskLevelId, string> = {
  low: 'Baixo',
  medium: 'Médio',
  high: 'Alto',
  critical: 'Crítico',
};

export const ALL_RISKS: RiskLevelId[] = ['low', 'medium', 'high', 'critical'];
