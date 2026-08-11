/**
 * P8.5 — Approval matrix (16 classes).
 *
 * Each entry defines: name, requiredRoles, requiresDistinctApprovers,
 * architectureLocks. The matrix is the single source of truth for
 * approval gating across the admin-ui (tRPC procedures + React modals).
 *
 * Hard limits, soul core values, dangerous tools, and identity drift
 * corrections require dual approval (owner + compliance_officer).
 */
import type { ApprovalClassId, ProposalTypeId, RiskLevelId } from '../../db/schema.js';

export interface ApprovalClassDef {
  id: ApprovalClassId;
  name: string;
  /** Roles that can record an approval. For dual approval, ALL must approve. */
  requiredRoles: string[];
  /** True ⇒ same person cannot fulfil both required-role slots. */
  requiresDistinctApprovers: boolean;
  /** Architecture lock identifiers this approval class touches. */
  architectureLocks: string[];
  /** Short description for UI tooltip. */
  description: string;
}

export const approvalMatrix: Record<ApprovalClassId, ApprovalClassDef> = {
  policy_rule_soft_guidance: {
    id: 'policy_rule_soft_guidance',
    name: 'Policy Rule (Soft Guidance)',
    requiredRoles: ['owner'],
    requiresDistinctApprovers: false,
    architectureLocks: [],
    description: 'Non-binding heuristic; agent may override with reason.',
  },
  policy_rule_hard_limit: {
    id: 'policy_rule_hard_limit',
    name: 'Policy Rule (Hard Limit)',
    requiredRoles: ['owner', 'compliance_officer'],
    requiresDistinctApprovers: true,
    architectureLocks: ['precedence_pyramid'],
    description: 'Binding constraint; agent cannot override. Dual approval.',
  },
  soul_bias_core_value: {
    id: 'soul_bias_core_value',
    name: 'Soul Bias (Core Value)',
    requiredRoles: ['owner', 'compliance_officer'],
    requiresDistinctApprovers: true,
    architectureLocks: ['soul_immutable_core'],
    description: 'Touches the immutable soul core. Dual approval + lock.',
  },
  soul_bias_peripheral: {
    id: 'soul_bias_peripheral',
    name: 'Soul Bias (Peripheral)',
    requiredRoles: ['owner'],
    requiresDistinctApprovers: false,
    architectureLocks: [],
    description: 'Adjusts peripheral bias; no architectural impact.',
  },
  skill_new_domain: {
    id: 'skill_new_domain',
    name: 'Skill (New Domain)',
    requiredRoles: ['owner'],
    requiresDistinctApprovers: false,
    architectureLocks: [],
    description: 'Adds a new skill domain to the agent.',
  },
  skill_refinement: {
    id: 'skill_refinement',
    name: 'Skill (Refinement)',
    requiredRoles: ['owner', 'analyst'],
    requiresDistinctApprovers: false,
    architectureLocks: [],
    description: 'Iterates an existing skill. Either role can approve.',
  },
  capability_safe_tool: {
    id: 'capability_safe_tool',
    name: 'Capability (Safe Tool)',
    requiredRoles: ['owner'],
    requiresDistinctApprovers: false,
    architectureLocks: [],
    description: 'Adds a read-only or stateless tool capability.',
  },
  capability_dangerous_tool: {
    id: 'capability_dangerous_tool',
    name: 'Capability (Dangerous Tool)',
    requiredRoles: ['owner', 'compliance_officer'],
    requiresDistinctApprovers: true,
    architectureLocks: ['tool_blast_radius'],
    description: 'Side-effectful or destructive tool. Dual approval.',
  },
  capability_side_effect: {
    id: 'capability_side_effect',
    name: 'Capability (Side Effect)',
    requiredRoles: ['owner', 'compliance_officer'],
    requiresDistinctApprovers: true,
    architectureLocks: [],
    description: 'Tool that mutates external state. Dual approval.',
  },
  knowledge_rule: {
    id: 'knowledge_rule',
    name: 'Knowledge (Rule)',
    requiredRoles: ['owner'],
    requiresDistinctApprovers: false,
    architectureLocks: [],
    description: 'Hardens a learned fact into a binding rule.',
  },
  knowledge_guidance: {
    id: 'knowledge_guidance',
    name: 'Knowledge (Guidance)',
    requiredRoles: ['analyst'],
    requiresDistinctApprovers: false,
    architectureLocks: [],
    description: 'Adds non-binding domain knowledge.',
  },
  knowledge_deprecated: {
    id: 'knowledge_deprecated',
    name: 'Knowledge (Deprecate)',
    requiredRoles: ['owner'],
    requiresDistinctApprovers: false,
    architectureLocks: [],
    description: 'Removes outdated knowledge; can be auto-rolled-back.',
  },
  identity_drift_correction: {
    id: 'identity_drift_correction',
    name: 'Identity Drift Correction',
    requiredRoles: ['owner', 'compliance_officer'],
    requiresDistinctApprovers: true,
    architectureLocks: ['identity_immutable_core'],
    description: 'Corrects detected identity drift. Dual approval + lock.',
  },
  procedure_update: {
    id: 'procedure_update',
    name: 'Procedure Update',
    requiredRoles: ['owner'],
    requiresDistinctApprovers: false,
    architectureLocks: [],
    description: 'Updates an executable procedure definition.',
  },
  // Spec perfil-inbox v4 §1.3 — duas classes selecionadas por risco, porque
  // ApprovalClassDef tem papéis FIXOS por classe (uma classe única não
  // representa "owner para low/medium, dual para high").
  operational_profile_change: {
    id: 'operational_profile_change',
    name: 'Operational Profile (Change)',
    requiredRoles: ['owner', 'founder'],
    requiresDistinctApprovers: false,
    architectureLocks: [],
    description: 'Low/medium-risk profile change; owner OR founder approves.',
  },
  operational_profile_change_high: {
    id: 'operational_profile_change_high',
    name: 'Operational Profile (High-Risk Change)',
    requiredRoles: ['owner', 'founder'],
    requiresDistinctApprovers: true,
    architectureLocks: [],
    description: 'High-risk profile change. Dual approval (owner + founder).',
  },
};

/**
 * Map (proposal type + risk) → approval class.
 *
 * Risk-based escalation:
 *   - critical / high → hard / dual approval variant when one exists
 *   - medium → owner-only (or analyst for refinement)
 *   - low → owner-only soft variant
 */
export function getApprovalClassFor(type: ProposalTypeId, risk: RiskLevelId): ApprovalClassId {
  switch (type) {
    case 'policy_rule':
      return risk === 'critical' || risk === 'high'
        ? 'policy_rule_hard_limit'
        : 'policy_rule_soft_guidance';
    case 'soul_bias':
      return risk === 'critical' || risk === 'high'
        ? 'soul_bias_core_value'
        : 'soul_bias_peripheral';
    case 'skill':
      return risk === 'critical' || risk === 'high' ? 'skill_new_domain' : 'skill_refinement';
    case 'capability_proposal':
      if (risk === 'critical') return 'capability_dangerous_tool';
      if (risk === 'high') return 'capability_side_effect';
      return 'capability_safe_tool';
    case 'knowledge_proposal':
      if (risk === 'critical' || risk === 'high') return 'knowledge_rule';
      if (risk === 'low') return 'knowledge_guidance';
      return 'knowledge_guidance';
    case 'operational_profile':
      // Spec perfil-inbox v4 §1.3: low/medium ⇒ owner OU founder (paridade
      // com o caminho bespoke atual); high ⇒ dual owner + founder. `critical`
      // não está nos riskLevels do tipo — se chegar, escala para dual.
      return risk === 'critical' || risk === 'high'
        ? 'operational_profile_change_high'
        : 'operational_profile_change';
    default: {
      // Exhaustiveness check — TypeScript ensures all branches covered.
      const _exhaustive: never = type;
      throw new Error(`Unknown proposal type: ${String(_exhaustive)}`);
    }
  }
}

export function requiredRolesFor(approvalClass: ApprovalClassId): string[] {
  return approvalMatrix[approvalClass].requiredRoles;
}

export function requiresDualApproval(approvalClass: ApprovalClassId): boolean {
  return approvalMatrix[approvalClass].requiresDistinctApprovers;
}

export function architectureLocksFor(approvalClass: ApprovalClassId): string[] {
  return approvalMatrix[approvalClass].architectureLocks;
}
