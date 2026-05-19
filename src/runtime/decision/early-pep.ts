/**
 * P9b — Early PEP (Camada 2, PEP 1/3).
 *
 * Spec §4.1: blocks turns based ONLY on Layer-1 (BaseContextPacket) info.
 * Does NOT see intent / skill / tool / knowledge.
 *
 * Budget target: <30ms.
 * Invariante 14: cannot be bypassed by feature flag.
 */
import type {
  BlockDecision,
  ContinueDecision,
  EarlyPep,
  EarlyPepInput,
  EarlyPepOutput,
  LockdownReader,
  PolicyEvaluator,
  PolicyRulesRepo,
} from './types.js';

export interface EarlyPepDeps {
  lockdownReader: LockdownReader;
  policyRepo: PolicyRulesRepo;
  evaluator: PolicyEvaluator;
}

export class EarlyPepImpl implements EarlyPep {
  constructor(private deps: EarlyPepDeps) {}

  async evaluate({
    base,
    resolved_policies,
    signal,
  }: EarlyPepInput): Promise<EarlyPepOutput> {
    const opts: { signal?: AbortSignal } = {};
    if (signal) opts.signal = signal;
    // 1. Hardcoded short-circuits (rules first, master §0.4 principle 1).
    if (base.channel.is_locked_down) {
      return {
        pep: 'early',
        policy_id: 'system.channel_locked_down',
        rule_descriptor: 'channel.locked_down.global',
        decision: 'block',
        reason: 'channel em lockdown',
        severity: 'high',
      };
    }

    // 2. Tenant lockdown check (governance/lockdown.ts).
    const tenantLocked = await this.deps.lockdownReader.isTenantInGlobalLockdown(
      base.tenant_id,
      opts,
    );
    if (tenantLocked) {
      return {
        pep: 'early',
        policy_id: 'system.tenant_lockdown',
        rule_descriptor: 'tenant.lockdown.emergency',
        decision: 'block',
        reason: 'tenant em lockdown global',
        severity: 'critical',
      };
    }

    // 3. Evaluate early policies (those with applies_to_peps explicitly containing 'early').
    //    Default if not specified is ['mid', 'late'] — early requires opt-in (spec §5).
    const earlyPolicies = resolved_policies.filter((p) => {
      const peps = p.applies_to_peps;
      if (peps) return peps.includes('early');
      const cached = this.deps.policyRepo.getBodySync(p.policy_id);
      return cached?.applies_to_peps?.includes('early') ?? false;
    });

    const warnings: ContinueDecision['warnings'] = [];

    for (const policy of earlyPolicies) {
      const body = await this.deps.policyRepo.getBody(policy.policy_id, opts);
      if (!body) continue;

      const verdict = await this.deps.evaluator.evaluate(
        body,
        {
          actor: base.actor,
          channel: base.channel,
          input: base.input,
          received_at: base.input.received_at,
          tenant_id: base.tenant_id,
        },
        opts,
      );

      if (verdict.action === 'block' || verdict.action === 'escalate') {
        const block: BlockDecision = {
          pep: 'early',
          policy_id: policy.policy_id,
          rule_descriptor: policy.descriptor,
          decision: verdict.action,
          reason: verdict.reason,
          severity: verdict.severity ?? 'high',
        };
        if (verdict.message !== undefined) {
          block.user_facing_message = verdict.message;
        }
        return block;
      }

      if (verdict.action === 'warn_in_trace') {
        warnings.push({
          policy_id: policy.policy_id,
          rule_descriptor: policy.descriptor,
          reason: verdict.reason,
        });
      }
    }

    return { pep: 'early', warnings };
  }
}
