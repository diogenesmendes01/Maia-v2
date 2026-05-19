/**
 * P9b — PepAudit accumulator.
 *
 * Spec §8: records one entry per non-silent-allow policy decision. Used by
 * Decision Engine + Guardrails to build `DecisionPacket.policy_decisions[]`.
 *
 * One accumulator per request (stateful). Decision Engine creates a fresh
 * instance per `run()` call.
 */
import type {
  BlockDecision,
  ContinueDecision,
  RequireDualApprovalDecision,
} from './types.js';
import type {
  DecisionPacket,
  PepKind,
  PolicyDecision,
} from '../context-packet/types.js';

type PolicyDecisionEntry = DecisionPacket['policy_decisions'][number];

export class PepAudit {
  private entries: PolicyDecisionEntry[] = [];

  record(
    pep: PepKind,
    policy_id: string,
    rule_descriptor: string,
    decision: PolicyDecision,
    reason: string,
  ): void {
    this.entries.push({ pep, policy_id, rule_descriptor, decision, reason });
  }

  recordFromBlock(b: BlockDecision): void {
    this.record(b.pep, b.policy_id, b.rule_descriptor, b.decision, b.reason);
  }

  recordFromDualApproval(a: RequireDualApprovalDecision): void {
    this.record(
      a.pep,
      a.policy_id,
      a.rule_descriptor,
      'require_dual_approval',
      a.reason,
    );
  }

  recordWarnings(pep: PepKind, warnings: ContinueDecision['warnings']): void {
    for (const w of warnings) {
      this.record(pep, w.policy_id, w.rule_descriptor, 'warn', w.reason);
    }
  }

  recordLate(entries: PolicyDecisionEntry[]): void {
    this.entries.push(...entries);
  }

  toArray(): PolicyDecisionEntry[] {
    return [...this.entries];
  }

  size(): number {
    return this.entries.length;
  }
}
