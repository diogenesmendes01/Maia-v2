/**
 * P9b — Mid PEP (Camada 2, PEP 2/3).
 *
 * Spec §4.2: blocks or requires approval AFTER intent/risk/skill are known.
 * Filters policies with `applies_to_peps` containing `'mid'` (default
 * `['mid', 'late']` per spec §5).
 *
 * Budget target: <150ms.
 * Invariante 14: cannot be bypassed by feature flag.
 */
import type {
  BlockDecision,
  ContinueDecision,
  MidPep,
  MidPepInput,
  MidPepOutput,
  PolicyEvaluator,
  PolicyRulesRepo,
  RequireDualApprovalDecision,
} from './types.js';

export interface MidPepDeps {
  policyRepo: PolicyRulesRepo;
  evaluator: PolicyEvaluator;
}

export class MidPepImpl implements MidPep {
  constructor(private deps: MidPepDeps) {}

  async evaluate(input: MidPepInput): Promise<MidPepOutput> {
    // Filter: default to ['mid', 'late'] (spec §5) so any policy not explicit
    // about applies_to_peps still runs through Mid.
    const midPolicies = input.resolved_policies.filter((p) => {
      const declared = p.applies_to_peps;
      if (declared) return declared.includes('mid');
      const cached = this.deps.policyRepo.getBodySync(p.policy_id);
      const peps = cached?.applies_to_peps ?? ['mid', 'late'];
      return peps.includes('mid');
    });

    const warnings: ContinueDecision['warnings'] = [];

    for (const policy of midPolicies) {
      const body = await this.deps.policyRepo.getBody(policy.policy_id);
      if (!body) continue;

      const verdict = await this.deps.evaluator.evaluate(body, {
        actor: input.base.actor,
        channel: input.base.channel,
        input: input.base.input,
        intent: input.intent,
        risk: input.risk_profile,
        skill: {
          id: input.selected_skill_id,
          candidates: input.candidate_skill_ids,
        },
        workflow: { id: input.workflow_id },
        tools: input.tool_permissions_preview,
        tenant_id: input.base.tenant_id,
      });

      if (verdict.action === 'block') {
        const block: BlockDecision = {
          pep: 'mid',
          policy_id: policy.policy_id,
          rule_descriptor: policy.descriptor,
          decision: 'block',
          reason: verdict.reason,
          severity: verdict.severity ?? 'high',
        };
        if (verdict.message !== undefined) {
          block.user_facing_message = verdict.message;
        }
        return block;
      }

      if (verdict.action === 'escalate') {
        const block: BlockDecision = {
          pep: 'mid',
          policy_id: policy.policy_id,
          rule_descriptor: policy.descriptor,
          decision: 'escalate',
          reason: verdict.reason,
          severity: verdict.severity ?? 'high',
        };
        if (verdict.message !== undefined) {
          block.user_facing_message = verdict.message;
        }
        return block;
      }

      if (verdict.action === 'require_dual_approval') {
        const approval: RequireDualApprovalDecision = {
          pep: 'mid',
          policy_id: policy.policy_id,
          rule_descriptor: policy.descriptor,
          decision: 'require_dual_approval',
          reason: verdict.reason,
          approval_class:
            (verdict.parameters?.['approval_class'] as
              | 'owner_plus_compliance'
              | 'owner_plus_technical') ?? 'owner_plus_technical',
        };
        return approval;
      }

      if (verdict.action === 'reduce_tool_set') {
        const removed = Array.isArray(verdict.parameters?.['removed_tools'])
          ? (verdict.parameters['removed_tools'] as string[])
          : [];
        warnings.push({
          policy_id: policy.policy_id,
          rule_descriptor: policy.descriptor,
          reason: `tool_set reduzido: ${removed.join(', ')}`,
        });
      }

      if (verdict.action === 'warn_in_trace') {
        warnings.push({
          policy_id: policy.policy_id,
          rule_descriptor: policy.descriptor,
          reason: verdict.reason,
        });
      }
    }

    return { pep: 'mid', warnings };
  }
}
