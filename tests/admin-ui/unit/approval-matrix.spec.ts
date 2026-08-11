/**
 * P8.5 — approval matrix unit tests. Verifies all 16 classes are defined,
 * dual-approval flags + architecture locks are correctly attached, and the
 * type+risk → class mapping is exhaustive.
 */
import { describe, it, expect } from 'vitest';
import {
  approvalMatrix,
  getApprovalClassFor,
  requiredRolesFor,
  requiresDualApproval,
  architectureLocksFor,
} from '@/admin-ui/lib/approval-matrix.js';
import type { ProposalTypeId, RiskLevelId } from '@/db/schema.js';

describe('approval matrix', () => {
  it('has exactly 16 approval classes', () => {
    expect(Object.keys(approvalMatrix)).toHaveLength(16);
  });

  it('every class has required fields', () => {
    for (const [id, def] of Object.entries(approvalMatrix)) {
      expect(def.id).toBe(id);
      expect(def.name.length).toBeGreaterThan(0);
      expect(def.requiredRoles.length).toBeGreaterThanOrEqual(1);
      expect(def.description.length).toBeGreaterThan(0);
    }
  });

  it('policy_rule_hard_limit requires dual approval (owner + compliance_officer)', () => {
    const def = approvalMatrix.policy_rule_hard_limit;
    expect(def.requiredRoles).toEqual(['owner', 'compliance_officer']);
    expect(def.requiresDistinctApprovers).toBe(true);
    expect(def.architectureLocks).toContain('precedence_pyramid');
  });

  it('soul_bias_core_value requires dual approval + soul_immutable_core lock', () => {
    const def = approvalMatrix.soul_bias_core_value;
    expect(def.requiresDistinctApprovers).toBe(true);
    expect(def.architectureLocks).toContain('soul_immutable_core');
  });

  it('capability_dangerous_tool requires dual approval + tool_blast_radius lock', () => {
    const def = approvalMatrix.capability_dangerous_tool;
    expect(def.requiresDistinctApprovers).toBe(true);
    expect(def.architectureLocks).toContain('tool_blast_radius');
  });

  it('identity_drift_correction requires dual approval + identity_immutable_core lock', () => {
    const def = approvalMatrix.identity_drift_correction;
    expect(def.requiresDistinctApprovers).toBe(true);
    expect(def.architectureLocks).toContain('identity_immutable_core');
  });

  it('soft variants do not require dual approval', () => {
    expect(approvalMatrix.policy_rule_soft_guidance.requiresDistinctApprovers).toBe(false);
    expect(approvalMatrix.soul_bias_peripheral.requiresDistinctApprovers).toBe(false);
    expect(approvalMatrix.knowledge_guidance.requiresDistinctApprovers).toBe(false);
  });

  // Spec perfil-inbox v4 §1.3 — duas classes selecionadas por risco.
  it('operational_profile_change: owner OU founder, sem dual (paridade com hoje)', () => {
    const def = approvalMatrix.operational_profile_change;
    expect(def.requiredRoles).toEqual(['owner', 'founder']);
    expect(def.requiresDistinctApprovers).toBe(false);
  });

  it('operational_profile_change_high: dual owner + founder com aprovadores distintos', () => {
    const def = approvalMatrix.operational_profile_change_high;
    expect(def.requiredRoles).toEqual(['owner', 'founder']);
    expect(def.requiresDistinctApprovers).toBe(true);
  });
});

describe('getApprovalClassFor', () => {
  const cases: Array<[ProposalTypeId, RiskLevelId, string]> = [
    ['policy_rule', 'critical', 'policy_rule_hard_limit'],
    ['policy_rule', 'high', 'policy_rule_hard_limit'],
    ['policy_rule', 'medium', 'policy_rule_soft_guidance'],
    ['policy_rule', 'low', 'policy_rule_soft_guidance'],
    ['soul_bias', 'critical', 'soul_bias_core_value'],
    ['soul_bias', 'low', 'soul_bias_peripheral'],
    ['skill', 'critical', 'skill_new_domain'],
    ['skill', 'low', 'skill_refinement'],
    ['capability_proposal', 'critical', 'capability_dangerous_tool'],
    ['capability_proposal', 'high', 'capability_side_effect'],
    ['capability_proposal', 'medium', 'capability_safe_tool'],
    ['knowledge_proposal', 'high', 'knowledge_rule'],
    ['knowledge_proposal', 'low', 'knowledge_guidance'],
    // Spec perfil-inbox v4 §1.3: low/medium ⇒ classe simples; high ⇒ dual.
    ['operational_profile', 'low', 'operational_profile_change'],
    ['operational_profile', 'medium', 'operational_profile_change'],
    ['operational_profile', 'high', 'operational_profile_change_high'],
  ];

  it.each(cases)('%s + %s → %s', (type, risk, expected) => {
    expect(getApprovalClassFor(type, risk)).toBe(expected);
  });
});

describe('helper accessors', () => {
  it('requiredRolesFor returns the class roles', () => {
    expect(requiredRolesFor('policy_rule_hard_limit')).toEqual(['owner', 'compliance_officer']);
  });

  it('requiresDualApproval returns the dual flag', () => {
    expect(requiresDualApproval('policy_rule_hard_limit')).toBe(true);
    expect(requiresDualApproval('policy_rule_soft_guidance')).toBe(false);
  });

  it('architectureLocksFor returns the locks list', () => {
    expect(architectureLocksFor('identity_drift_correction')).toContain('identity_immutable_core');
    expect(architectureLocksFor('knowledge_guidance')).toEqual([]);
  });
});
