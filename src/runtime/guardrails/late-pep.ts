/**
 * P9b — Late PEP (PEP 3/3) in Camada 5 (Guardrails).
 *
 * Spec §4.3 + §8. Runs AFTER the skill produces output. Validates:
 *   1. Schema conformance (skill.output_schema_ref).
 *   2. Policies with `applies_to_peps` containing `'late'`.
 *
 * Late PEP is INVIOLABLE — runs even in fallback paths (invariante 14).
 * Budget: <200ms.
 */
import type {
  AgentOutputCandidate,
  ExecutionContextPacket,
  LatePep,
  LatePepDeps,
  PolicyValidationResult,
} from './types.js';
import type {
  DecisionPacket,
  PolicyDecision,
} from '../context-packet/types.js';
import type { PolicyEvaluatorVerdict } from '../decision/types.js';

export class LatePepImpl implements LatePep {
  constructor(private deps: LatePepDeps) {}

  async validate(
    candidate: AgentOutputCandidate,
    execContext: ExecutionContextPacket,
    decision: DecisionPacket,
    options?: { signal?: AbortSignal },
  ): Promise<PolicyValidationResult> {
    const opts: { signal?: AbortSignal } = {};
    if (options?.signal) opts.signal = options.signal;
    const results: PolicyValidationResult['policy_decisions'] = [];

    // 1. Schema validation (only if a schema is declared).
    const schemaRef = execContext.skill.selected_skill?.output_schema_ref;
    const schemaCheck = await this.deps.skillSchemaValidator.validate(
      candidate.structured_output ?? candidate.raw_text,
      schemaRef,
      opts,
    );
    if (!schemaCheck.valid) {
      return {
        passed: false,
        policy_decisions: [
          {
            pep: 'late',
            policy_id: 'system.schema_validator',
            rule_descriptor: 'skill.output_schema',
            decision: 'block',
            reason: schemaCheck.errors.join('; '),
          },
        ],
        final_action: 'regenerate',
      };
    }

    // 2. Late policies.
    const latePolicies = execContext.policy.applicable_rules.filter((p) =>
      p.applies_to_peps.includes('late'),
    );

    for (const rule of latePolicies) {
      const body = await this.deps.policyRepo.getBody(rule.policy_id, opts);
      if (!body) continue;

      const verdict = await this.deps.evaluator.evaluate(
        body,
        {
          output: candidate,
          decision,
          execContext,
        },
        opts,
      );

      const policyDecision = mapVerdictToDecision(verdict);
      results.push({
        pep: 'late',
        policy_id: rule.policy_id,
        rule_descriptor: rule.rule_descriptor,
        decision: policyDecision,
        reason: verdict.reason,
      });

      if (verdict.action === 'block') {
        return { passed: false, policy_decisions: results, final_action: 'block' };
      }
      if (verdict.action === 'escalate') {
        return {
          passed: false,
          policy_decisions: results,
          final_action: 'escalate',
        };
      }
      // Codex round-2 finding 1: a Late `require_dual_approval` verdict MUST
      // halt the send path. Without this branch the verdict was recorded into
      // policy_decisions, then the loop fell through to `passed:true /
      // final_action:'send'` — i.e. policy says "needs dual approval" but the
      // message would still be delivered. Treat as failed validation that
      // requires escalation, matching how Mid PEP surfaces the same verdict
      // via DecisionEngine (action_mode='escalate').
      if (verdict.action === 'require_dual_approval') {
        return {
          passed: false,
          policy_decisions: results,
          final_action: 'escalate',
        };
      }
    }

    return { passed: true, policy_decisions: results, final_action: 'send' };
  }
}

function mapVerdictToDecision(verdict: PolicyEvaluatorVerdict): PolicyDecision {
  switch (verdict.action) {
    case 'block':
      return 'block';
    case 'escalate':
      return 'escalate';
    case 'require_dual_approval':
      return 'require_dual_approval';
    case 'warn_in_trace':
    case 'reduce_tool_set':
      return 'warn';
    case 'allow':
    default:
      return 'allow';
  }
}
