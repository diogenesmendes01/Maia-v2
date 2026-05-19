/**
 * P8.5 — Proposal type registry. Maps each proposal type to its diff-renderer
 * component name and supported risk levels. Used by Tela 2 (diff-renderer.tsx)
 * to dispatch to the correct sub-component.
 */
import type { ProposalTypeId, RiskLevelId } from '../../db/schema.js';

export interface ProposalTypeDef {
  id: ProposalTypeId;
  /** Component import name in src/admin-ui/app/proposals/[id]/_components/ */
  diffComponent: string;
  /** All risk levels this type supports. Used to validate `risk` field. */
  riskLevels: RiskLevelId[];
  /** Human-readable display name. */
  displayName: string;
  /** Default approval-class hint when risk is unknown. */
  defaultApprovalClass: string;
}

export const proposalTypeRegistry: Record<ProposalTypeId, ProposalTypeDef> = {
  policy_rule: {
    id: 'policy_rule',
    diffComponent: 'DiffPolicyRule',
    riskLevels: ['low', 'medium', 'high', 'critical'],
    displayName: 'Policy Rule',
    defaultApprovalClass: 'policy_rule_soft_guidance',
  },
  soul_bias: {
    id: 'soul_bias',
    diffComponent: 'DiffSoulBias',
    riskLevels: ['low', 'medium', 'high', 'critical'],
    displayName: 'Soul Bias',
    defaultApprovalClass: 'soul_bias_peripheral',
  },
  skill: {
    id: 'skill',
    diffComponent: 'DiffSkill',
    riskLevels: ['low', 'medium', 'high'],
    displayName: 'Skill',
    defaultApprovalClass: 'skill_refinement',
  },
  capability_proposal: {
    id: 'capability_proposal',
    diffComponent: 'DiffCapability',
    riskLevels: ['low', 'medium', 'high', 'critical'],
    displayName: 'Capability',
    defaultApprovalClass: 'capability_safe_tool',
  },
  knowledge_proposal: {
    id: 'knowledge_proposal',
    diffComponent: 'DiffKnowledge',
    riskLevels: ['low', 'medium', 'high'],
    displayName: 'Knowledge',
    defaultApprovalClass: 'knowledge_guidance',
  },
};

export function getDiffComponent(type: ProposalTypeId): string {
  return proposalTypeRegistry[type].diffComponent;
}

export function getDisplayName(type: ProposalTypeId): string {
  return proposalTypeRegistry[type].displayName;
}

export function isValidRiskFor(type: ProposalTypeId, risk: RiskLevelId): boolean {
  return proposalTypeRegistry[type].riskLevels.includes(risk);
}
