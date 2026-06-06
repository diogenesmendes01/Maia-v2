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
    const opts: { signal?: AbortSignal } = {};
    if (input.signal) opts.signal = input.signal;
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
    const tool_reductions: NonNullable<ContinueDecision['tool_reductions']> = [];

    for (const policy of midPolicies) {
      const body = await this.deps.policyRepo.getBody(policy.policy_id, opts);
      if (!body) continue;

      const verdict = await this.deps.evaluator.evaluate(
        body,
        {
          actor: input.base.actor,
          channel: input.base.channel,
          input: input.base.input,
          intent: input.intent,
          risk: input.risk_profile,
          skill: {
            id: input.selected_skill_id,
            candidates: input.candidate_skill_ids,
            // Codex round-2 finding 2: expose the actual scoped Skill (with
            // its allowed_tools/blocked_tools/runtime_hints) so tool-based
            // predicates evaluate against the real surface instead of the
            // previously empty preview.
            selected: input.selected_skill,
          },
          workflow: { id: input.workflow_id },
          tools: input.tool_permissions_preview,
          tenant_id: input.base.tenant_id,
        },
        opts,
      );

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
        // Issue #437 — the boleto write/risk policies (migration 078) BOTH encode
        // the DSL `require_dual_approval` effect; `effect.metadata.intent`
        // (forwarded by the evaluator adapter as `parameters.intent`)
        // disambiguates the PEP outcome WITHOUT extending the DSL vocabulary
        // (decision: option b):
        //   - 'escalate_to_human'  → hand off to a human (escalate).
        //   - 'confirm_before_write' (or unset) → require explicit confirmation /
        //     dual approval before the sensitive write.
        const intent = verdict.parameters?.['intent'];
        if (intent === 'escalate_to_human') {
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
          ? (verdict.parameters['removed_tools'] as string[]).filter(
              (t): t is string => typeof t === 'string' && t.length > 0,
            )
          : [];
        // Codex review #103: a reduce_tool_set policy MUST be enforceable.
        // We emit BOTH a structured reduction (consumed by ActionDecider) and
        // a warning row (preserved for audit visibility in PepAudit).
        tool_reductions.push({
          policy_id: policy.policy_id,
          rule_descriptor: policy.descriptor,
          removed_tools: removed,
          reason: verdict.reason,
        });
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

    const out: ContinueDecision = { pep: 'mid', warnings };
    if (tool_reductions.length > 0) out.tool_reductions = tool_reductions;
    return out;
  }
}
